/**
 * Partner integrations of an organising space (MV-HOOK-1).
 *
 * - API keys: a space's owners and admins create keys for the read API; only a SHA-256 of a key is stored,
 *   the key is shown once; up to 10 active keys; 120 requests per key and minute.
 * - Webhook endpoints: an HTTPS URL, the events it wants and a signing secret (shown once, sealed at rest);
 *   up to 5 active endpoints per space. Private, loopback and link-local addresses are refused when the
 *   endpoint is saved and again before every delivery; redirects are not followed.
 * - Events are read from the hash-chained audit log (`collectEvents`): a change and its log entry commit
 *   together, so every committed change becomes an event once, in commit order. Each event becomes one
 *   delivery per subscribed endpoint (an outbox row with a unique event id per endpoint).
 * - Deliveries (`deliverWebhooks`) are claimed with a short lease, sent signed (`src/lib/webhook-signature.ts`)
 *   with a 5-second timeout, and retried after 1, 5, 30, 120 and 360 minutes; after the sixth failed attempt
 *   a delivery is marked failed and can be retried by hand.
 */
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { canManageOrg } from "./access.ts";
import { fail } from "./errors.ts";
import { seal, unseal } from "./secret-box.ts";
import { siteOrigin } from "../lib/site.ts";
import { signedHeaders } from "../lib/webhook-signature.ts";
import * as v from "./validate.ts";
import { featureEnabled } from "./system.ts";

export const KEY_LIMIT = 10;
export const ENDPOINT_LIMIT = 5;
export const RATE_PER_MINUTE = 120;
export const MAX_ATTEMPTS = 6;
export const BACKOFF_MINUTES = [1, 5, 30, 120, 360];
export const DELIVERY_TIMEOUT_MS = 5000;
export const WEBHOOK_EVENTS = ["tournament.status_changed", "registration.created", "registration.withdrawn", "match.completed", "match.corrected"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Audit actions that become webhook events. */
const EVENT_OF: Record<string, WebhookEvent> = {
  "tournament.status": "tournament.status_changed",
  "tournament.completed": "tournament.status_changed",
  "registration.created": "registration.created",
  "registration.withdrawn": "registration.withdrawn",
  "match.result_confirmed": "match.completed",
  "match.result_agreed": "match.completed",
  "match.official_result": "match.completed",
  "match.no_show": "match.completed",
  "match.result_corrected": "match.corrected",
};

const HOOK_LOCK = 734_120_019;
const isId = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Local receivers are allowed only outside production and only when explicitly switched on (local tests). */
export const allowLocalWebhooks = () => process.env.MV_WEBHOOK_ALLOW_LOCAL === "1" && process.env.VERCEL_ENV !== "production";

type Org = { id: string; slug: string; name: string };
async function managedOrg(q: Queryable, user: SessionUser, orgId: unknown): Promise<Org> {
  if (!isId(orgId)) fail("not_found");
  const [org] = await q.query<Org>("select id, slug, name from organizations where id = $1", [orgId]);
  if (!org) fail("not_found");
  if (!(await canManageOrg(q, org.id, user))) fail("forbidden");
  return org;
}

// ---------- API keys ----------

export async function createApiKey(db: Database, user: SessionUser, orgId: unknown, nameInput: unknown): Promise<{ id: string; key: string; prefix: string }> {
  const name = v.displayName(nameInput, 60);
  return db.tx(async (q) => {
    const org = await managedOrg(q, user, orgId);
    await q.query("select id from organizations where id = $1 for update", [org.id]);
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from api_keys where org_id = $1 and revoked_at is null", [org.id]);
    if ((n?.n ?? 0) >= KEY_LIMIT) fail("api_key_limit");
    const key = `mvk_${randomBytes(30).toString("base64url")}`;
    const prefix = key.slice(0, 12);
    const [row] = await q.query<{ id: string }>("insert into api_keys (org_id, name, prefix, key_hash, created_by) values ($1, $2, $3, $4, $5) returning id", [
      org.id,
      name,
      prefix,
      sha256(key),
      user.id,
    ]);
    await audit(q, { actorId: user.id, action: "api_key.created", entity: "organization", entityId: org.id, data: { key: row.id, name, prefix } });
    return { id: row.id, key, prefix };
  });
}

export async function revokeApiKey(db: Database, user: SessionUser, keyId: unknown) {
  if (!isId(keyId)) fail("not_found");
  await db.tx(async (q) => {
    const [k] = await q.query<{ org_id: string; revoked_at: Date | null }>("select org_id, revoked_at from api_keys where id = $1 for update", [keyId]);
    if (!k) fail("not_found");
    const org = await managedOrg(q, user, k.org_id);
    if (k.revoked_at) return;
    await q.query("update api_keys set revoked_at = now(), revoked_by = $2 where id = $1", [keyId, user.id]);
    await audit(q, { actorId: user.id, action: "api_key.revoked", entity: "organization", entityId: org.id, data: { key: keyId } });
  });
}

export type ApiKeyRow = { id: string; name: string; prefix: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null; created_by: string };
export async function listApiKeys(q: Queryable, orgId: string): Promise<ApiKeyRow[]> {
  return q.query<ApiKeyRow>(
    `select k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, u.username as created_by
       from api_keys k join users u on u.id = k.created_by where k.org_id = $1 order by k.revoked_at nulls first, k.created_at desc limit 50`,
    [orgId],
  );
}

export type ApiAuth = { keyId: string; orgId: string };
export type AuthResult = { ok: true; auth: ApiAuth } | { ok: false; status: 401 | 429; code: "unauthorized" | "rate_limited"; retryAfter?: number };

/** Checks a Bearer key and counts the request against the key's per-minute limit. */
export async function authenticateKey(db: Database, authorization: string | null): Promise<AuthResult> {
  const m = /^Bearer\s+(mvk_[A-Za-z0-9_-]{20,80})$/.exec(authorization?.trim() ?? "");
  if (!m) return { ok: false, status: 401, code: "unauthorized" };
  const [k] = await db.query<{ id: string; org_id: string }>("select id, org_id from api_keys where key_hash = $1 and revoked_at is null", [sha256(m[1])]);
  if (!k) return { ok: false, status: 401, code: "unauthorized" };
  const [usage] = await db.query<{ count: number; window_start: Date }>(
    `insert into api_key_usage (key_id, window_start, count) values ($1, date_trunc('minute', now()), 1)
     on conflict (key_id, window_start) do update set count = api_key_usage.count + 1 returning count, window_start`,
    [k.id],
  );
  if (usage.count > RATE_PER_MINUTE) {
    const retryAfter = Math.max(1, 60 - Math.floor((Date.now() - new Date(usage.window_start).getTime()) / 1000));
    return { ok: false, status: 429, code: "rate_limited", retryAfter };
  }
  await db.query("update api_keys set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 minute')", [k.id]);
  return { ok: true, auth: { keyId: k.id, orgId: k.org_id } };
}

// ---------- Webhook endpoints ----------

/** IPv4 and IPv6 ranges a webhook may never reach: private, loopback, link-local, shared, multicast, unspecified. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const x = ip.toLowerCase();
  return (
    x === "::" ||
    x === "::1" ||
    x.startsWith("fc") ||
    x.startsWith("fd") ||
    x.startsWith("fe8") ||
    x.startsWith("fe9") ||
    x.startsWith("fea") ||
    x.startsWith("feb") ||
    x.startsWith("ff")
  );
}

/** HTTPS only, no credentials in the URL, no private or local hosts. */
export function webhookUrl(input: unknown): string {
  const raw = v.oneLine(input, 500);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("webhook_url");
  }
  const local = allowLocalWebhooks();
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) fail("webhook_url");
  if (url.username || url.password) fail("webhook_url");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!local) {
    if (host === "localhost" || /\.(localhost|local|internal|lan|home)$/.test(host)) fail("webhook_url");
    if (isIP(host) && isPrivateAddress(host)) fail("webhook_url");
  }
  return url.toString();
}

/** Resolves the host before each delivery and refuses private addresses (a public name may point inside). */
async function assertPublicHost(url: string) {
  if (allowLocalWebhooks()) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error("the host resolves to a private address");
}

const eventsFrom = (input: unknown): WebhookEvent[] => {
  const raw = Array.isArray(input) ? input : typeof input === "string" && input ? [input] : [];
  const events = WEBHOOK_EVENTS.filter((e) => raw.includes(e));
  if (!events.length) fail("webhook_events");
  return events;
};

const newSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;

export async function createWebhook(
  db: Database,
  user: SessionUser,
  orgId: unknown,
  urlInput: unknown,
  eventsInput: unknown,
): Promise<{ id: string; secret: string }> {
  const url = webhookUrl(urlInput);
  const events = eventsFrom(eventsInput);
  return db.tx(async (q) => {
    const org = await managedOrg(q, user, orgId);
    await q.query("select id from organizations where id = $1 for update", [org.id]);
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from webhook_endpoints where org_id = $1 and active", [org.id]);
    if ((n?.n ?? 0) >= ENDPOINT_LIMIT) fail("webhook_limit");
    const secret = newSecret();
    const sealed = seal("webhook", secret);
    const [row] = await q.query<{ id: string }>(
      "insert into webhook_endpoints (org_id, url, events, secret, scheme, created_by) values ($1, $2, $3, $4, $5, $6) returning id",
      [org.id, url, events, sealed.value, sealed.scheme, user.id],
    );
    await audit(q, { actorId: user.id, action: "webhook.created", entity: "organization", entityId: org.id, data: { endpoint: row.id, url, events } });
    return { id: row.id, secret };
  });
}

async function managedEndpoint(q: Queryable, user: SessionUser, endpointId: unknown) {
  if (!isId(endpointId)) fail("not_found");
  const [e] = await q.query<{ id: string; org_id: string; active: boolean }>("select id, org_id, active from webhook_endpoints where id = $1 for update", [
    endpointId,
  ]);
  if (!e) fail("not_found");
  const org = await managedOrg(q, user, e.org_id);
  return { endpoint: e, org };
}

export async function rotateWebhookSecret(db: Database, user: SessionUser, endpointId: unknown): Promise<{ secret: string }> {
  return db.tx(async (q) => {
    const { endpoint, org } = await managedEndpoint(q, user, endpointId);
    const secret = newSecret();
    const sealed = seal("webhook", secret);
    await q.query("update webhook_endpoints set secret = $2, scheme = $3, secret_rotated_at = now() where id = $1", [endpoint.id, sealed.value, sealed.scheme]);
    await audit(q, { actorId: user.id, action: "webhook.secret_rotated", entity: "organization", entityId: org.id, data: { endpoint: endpoint.id } });
    return { secret };
  });
}

export async function setWebhookActive(db: Database, user: SessionUser, endpointId: unknown, active: boolean) {
  await db.tx(async (q) => {
    const { endpoint, org } = await managedEndpoint(q, user, endpointId);
    if (endpoint.active === active) return;
    if (active) {
      const [n] = await q.query<{ n: number }>("select count(*)::int as n from webhook_endpoints where org_id = $1 and active", [org.id]);
      if ((n?.n ?? 0) >= ENDPOINT_LIMIT) fail("webhook_limit");
    }
    await q.query("update webhook_endpoints set active = $2 where id = $1", [endpoint.id, active]);
    await audit(q, {
      actorId: user.id,
      action: active ? "webhook.enabled" : "webhook.disabled",
      entity: "organization",
      entityId: org.id,
      data: { endpoint: endpoint.id },
    });
  });
}

/** A "ping" event to one endpoint, to check the receiver and its signature check. */
export async function sendTestEvent(db: Database, user: SessionUser, endpointId: unknown): Promise<{ id: string }> {
  return db.tx(async (q) => {
    const { endpoint, org } = await managedEndpoint(q, user, endpointId);
    if (!endpoint.active) fail("webhook_inactive");
    const eventId = `evt_test_${randomBytes(9).toString("hex")}`;
    const payload = {
      id: eventId,
      type: "ping",
      created_at: new Date().toISOString(),
      data: { organization: { slug: org.slug, name: org.name }, message: "Test event from MAXIMUS VEGAS" },
    };
    const [row] = await q.query<{ id: string }>(
      "insert into webhook_deliveries (endpoint_id, event_id, event_type, payload) values ($1, $2, 'ping', $3) returning id",
      [endpoint.id, eventId, JSON.stringify(payload)],
    );
    await audit(q, {
      actorId: user.id,
      action: "webhook.test_sent",
      entity: "organization",
      entityId: org.id,
      data: { endpoint: endpoint.id, delivery: row.id },
    });
    return row;
  });
}

/** Sends a failed or waiting delivery again at the next run. */
export async function retryDelivery(db: Database, user: SessionUser, deliveryId: unknown) {
  if (!isId(deliveryId)) fail("not_found");
  await db.tx(async (q) => {
    const [d] = await q.query<{ endpoint_id: string; status: string }>("select endpoint_id, status from webhook_deliveries where id = $1 for update", [
      deliveryId,
    ]);
    if (!d) fail("not_found");
    const { org } = await managedEndpoint(q, user, d.endpoint_id);
    if (d.status === "delivered") fail("webhook_delivered");
    await q.query("update webhook_deliveries set status = 'pending', next_attempt_at = now() where id = $1", [deliveryId]);
    await audit(q, { actorId: user.id, action: "webhook.retry", entity: "organization", entityId: org.id, data: { delivery: deliveryId } });
  });
}

export type EndpointRow = {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  scheme: string;
  created_at: Date;
  secret_rotated_at: Date | null;
  pending: number;
  failed: number;
};
export async function listWebhooks(q: Queryable, orgId: string): Promise<EndpointRow[]> {
  return q.query<EndpointRow>(
    `select e.id, e.url, e.events, e.active, e.scheme, e.created_at, e.secret_rotated_at,
            (select count(*)::int from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'pending') as pending,
            (select count(*)::int from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'failed') as failed
       from webhook_endpoints e where e.org_id = $1 order by e.active desc, e.created_at desc`,
    [orgId],
  );
}

export type DeliveryRow = {
  id: string;
  endpoint_id: string;
  url: string;
  event_id: string;
  event_type: string;
  status: string;
  attempts: number;
  last_status: number | null;
  last_error: string;
  created_at: Date;
  delivered_at: Date | null;
  next_attempt_at: Date;
};
export async function recentDeliveries(q: Queryable, orgId: string, limit = 30): Promise<DeliveryRow[]> {
  return q.query<DeliveryRow>(
    `select d.id, d.endpoint_id, e.url, d.event_id, d.event_type, d.status, d.attempts, d.last_status, d.last_error, d.created_at, d.delivered_at, d.next_attempt_at
       from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id where e.org_id = $1 order by d.created_at desc limit $2`,
    [orgId, limit],
  );
}

// ---------- Events from the audit log ----------

type AuditRow = { id: string; at: Date; action: string; entity: string; entity_id: string; data: Record<string, unknown> };
type EventTournament = { id: string; org_id: string; slug: string; name: string; game: string; format: string; status: string; starts_at: Date | null };

const pageUrl = (path: string) => `${siteOrigin() ?? "https://www.maximus.vegas"}${path}`;

const tournamentData = (t: EventTournament) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  game: t.game,
  format: t.format,
  status: t.status,
  starts_at: t.starts_at,
  url: pageUrl(`/ru/tournaments/${t.slug}`),
});

async function registrationData(q: Queryable, regId: unknown) {
  if (!isId(regId)) return null;
  const [r] = await q.query<{
    id: string;
    status: string;
    team_name: string | null;
    team_slug: string | null;
    username: string | null;
    display_name: string | null;
  }>(
    `select r.id, r.status, tm.name as team_name, tm.slug as team_slug, u.username, u.display_name
       from registrations r left join teams tm on tm.id = r.team_id left join users u on u.id = r.user_id where r.id = $1`,
    [regId],
  );
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    participant: r.team_slug ? { type: "team", name: r.team_name, slug: r.team_slug } : { type: "player", name: r.display_name, username: r.username },
  };
}

async function matchData(q: Queryable, matchId: string) {
  const [m] = await q.query<Record<string, unknown>>(
    `select m.id, m.bracket, m.stage, m.round, m.position, m.status, m.outcome, m.score_a, m.score_b, m.completed_at,
            coalesce(ta.name, ua.display_name) as a_name, coalesce(tb.name, ub.display_name) as b_name,
            case when m.winner_reg is null then null when m.winner_reg = m.a_reg then 'a' else 'b' end as winner
       from matches m
       left join registrations ra on ra.id = m.a_reg left join teams ta on ta.id = ra.team_id left join users ua on ua.id = ra.user_id
       left join registrations rb on rb.id = m.b_reg left join teams tb on tb.id = rb.team_id left join users ub on ub.id = rb.user_id
      where m.id = $1`,
    [matchId],
  );
  return m ?? null;
}

/**
 * Turns new audit entries into webhook deliveries. Single-flight (advisory lock); the cursor moves in the
 * same transaction as the deliveries it produced.
 */
export async function collectEvents(db: Database, batch = 500): Promise<number> {
  return db.tx(async (q) => {
    const [lock] = await q.query<{ ok: boolean }>("select pg_try_advisory_xact_lock($1) as ok", [HOOK_LOCK]);
    if (!lock?.ok) return 0;
    const [cursor] = await q.query<{ last_audit_id: string }>("select last_audit_id from webhook_cursor where id = 1 for update");
    if (!cursor) return 0;
    const rows = await q.query<AuditRow>("select id, at, action, entity, entity_id, data from audit_log where id > $1 order by id limit $2", [
      cursor.last_audit_id,
      batch,
    ]);
    if (!rows.length) return 0;
    const [any] = await q.query("select 1 from webhook_endpoints where active limit 1");
    let created = 0;
    if (any) {
      for (const row of rows) {
        const type = EVENT_OF[row.action];
        if (!type) continue;
        const tournamentId =
          row.entity === "tournament"
            ? row.entity_id
            : row.entity === "match"
              ? (await q.query<{ tournament_id: string }>("select tournament_id from matches where id = $1", [row.entity_id]))[0]?.tournament_id
              : null;
        if (!tournamentId || !isId(tournamentId)) continue;
        const [t] = await q.query<EventTournament>("select id, org_id, slug, name, game, format, status, starts_at from tournaments where id = $1", [
          tournamentId,
        ]);
        if (!t) continue;
        const endpoints = await q.query<{ id: string }>("select id from webhook_endpoints where org_id = $1 and active and $2 = any(events)", [t.org_id, type]);
        if (!endpoints.length) continue;
        const data =
          type === "tournament.status_changed"
            ? { tournament: tournamentData(t), from: (row.data.from as string) ?? null, to: (row.data.to as string) ?? "COMPLETED" }
            : type === "registration.created" || type === "registration.withdrawn"
              ? { tournament: tournamentData(t), registration: await registrationData(q, row.data.registrationId) }
              : { tournament: tournamentData(t), match: await matchData(q, row.entity_id) };
        const eventId = `evt_${row.id}`;
        const payload = { id: eventId, type, created_at: new Date(row.at).toISOString(), data };
        for (const e of endpoints) {
          const inserted = await q.query(
            "insert into webhook_deliveries (endpoint_id, event_id, event_type, payload) values ($1, $2, $3, $4) on conflict (endpoint_id, event_id) do nothing returning id",
            [e.id, eventId, type, JSON.stringify(payload)],
          );
          created += inserted.length;
        }
      }
    }
    await q.query("update webhook_cursor set last_audit_id = $1 where id = 1", [rows[rows.length - 1].id]);
    return created;
  });
}

type Due = { id: string; event_id: string; payload: unknown; attempts: number; url: string; secret: string; scheme: string };

const backoff = (attempt: number) => BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length) - 1] ?? BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1];

/** Sends due deliveries. Each is leased for two minutes, so parallel runs never send one delivery twice at once. */
export async function deliverWebhooks(db: Database, limit = 10, send: typeof fetch = fetch): Promise<{ delivered: number; retrying: number; failed: number }> {
  const due = await db.tx(async (q) => {
    const rows = await q.query<Due>(
      `select d.id, d.event_id, d.payload, d.attempts, e.url, e.secret, e.scheme
         from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id
        where d.status = 'pending' and d.next_attempt_at <= now() and e.active
        order by d.next_attempt_at limit $1 for update of d skip locked`,
      [limit],
    );
    if (rows.length)
      await q.query("update webhook_deliveries set attempts = attempts + 1, next_attempt_at = now() + interval '2 minutes' where id = any($1::uuid[])", [
        rows.map((r) => r.id),
      ]);
    return rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
  });
  const result = { delivered: 0, retrying: 0, failed: 0 };
  // In parallel: a run takes at most one delivery timeout, well inside a request's time limit.
  await Promise.all(due.map((d) => deliverOne(db, d, send, result)));
  return result;
}

async function deliverOne(db: Database, d: Due, send: typeof fetch, result: { delivered: number; retrying: number; failed: number }) {
  const body = typeof d.payload === "string" ? d.payload : JSON.stringify(d.payload);
  let status: number | null = null;
  let error = "";
  try {
    await assertPublicHost(d.url);
    const res = await send(d.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "MAXIMUS-VEGAS-Webhooks/1",
        ...signedHeaders(unseal("webhook", d.secret, d.scheme), d.event_id, body),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    status = res.status;
    await res.body?.cancel().catch(() => undefined);
  } catch (e) {
    error = (e as Error).name === "TimeoutError" ? "timeout" : String((e as Error).message ?? e).slice(0, 200);
  }
  if (status !== null && status >= 200 && status < 300) {
    await db.query("update webhook_deliveries set status = 'delivered', delivered_at = now(), last_status = $2, last_error = '' where id = $1", [d.id, status]);
    result.delivered++;
  } else if (d.attempts >= MAX_ATTEMPTS) {
    await db.query("update webhook_deliveries set status = 'failed', last_status = $2, last_error = $3 where id = $1", [
      d.id,
      status,
      error || `HTTP ${status}`,
    ]);
    result.failed++;
  } else {
    await db.query("update webhook_deliveries set next_attempt_at = now() + ($4 || ' minutes')::interval, last_status = $2, last_error = $3 where id = $1", [
      d.id,
      status,
      error || `HTTP ${status}`,
      String(backoff(d.attempts)),
    ]);
    result.retrying++;
  }
}

/** Collects new events and sends what is due; run after actions and by the daily maintenance. */
export async function pumpWebhooks(db: Database) {
  // Integrations switched off (MV-STAFF-1): events stay behind the cursor and go out after switching back on.
  if (!(await featureEnabled(db, "integrations"))) return { created: 0, delivered: 0, retrying: 0, failed: 0, paused: true };
  const created = await collectEvents(db);
  const sent = await deliverWebhooks(db);
  return { created, ...sent, paused: false };
}

/** Old rate-limit windows are kept for a day. */
export async function pruneApiUsage(db: Database) {
  await db.query("delete from api_key_usage where window_start < now() - interval '1 day'");
}
