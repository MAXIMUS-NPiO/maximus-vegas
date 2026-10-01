import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { createTournament, register, transition, withdraw, type TournamentInput } from "../src/server/tournaments.ts";
import { officialResult } from "../src/server/matches.ts";
import {
  authenticateKey,
  collectEvents,
  createApiKey,
  createWebhook,
  deliverWebhooks,
  isPrivateAddress,
  listApiKeys,
  MAX_ATTEMPTS,
  RATE_PER_MINUTE,
  retryDelivery,
  revokeApiKey,
  rotateWebhookSecret,
  sendTestEvent,
  setWebhookActive,
  webhookUrl,
} from "../src/server/partner.ts";
import { apiMatches, apiStandings, apiTournament, apiTournaments } from "../src/server/partner-api.ts";
import { verifyWebhook } from "../src/lib/webhook-signature.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
let seq = 0;
async function mk(name: string): Promise<SessionUser> {
  const s = await signUp(db, {
    email: `${name}@example.com`,
    username: name,
    displayName: name.toUpperCase(),
    password: "correct horse battery",
    adult: "on",
    terms: "on",
  });
  return (await sessionUser(db, s.token))!;
}
async function rejects(p: Promise<unknown> | (() => unknown), code: string) {
  const run = typeof p === "function" ? Promise.resolve().then(p) : p;
  await assert.rejects(run, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}
const base = (over: Partial<TournamentInput> = {}): TournamentInput => ({
  name: `Partner Cup ${++seq}`,
  game: "cs2",
  participantType: "solo",
  teamSize: 1,
  maxParticipants: 4,
  checkInRequired: "",
  region: "",
  startsAt: "2030-01-01T12:00",
  timeZone: "UTC",
  description: "",
  rules: "",
  ...over,
});

/** A receiver that checks signatures like a partner would: 200 for a fresh valid request, 409 for a replay. */
type Received = { headers: IncomingMessage["headers"]; body: string; verdict: string };
let server: Server;
let port = 0;
const received: Received[] = [];
let failNext = 0;
let receiverSecret = "";
const seen = new Set<string>();

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  process.env.MV_WEBHOOK_ALLOW_LOCAL = "1";
  process.env.MFA_SECRET_KEY = "partner-test-secret-key-0123456789abcdef";
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (failNext > 0) {
        failNext--;
        received.push({ headers: req.headers, body, verdict: "fail" });
        res.writeHead(500).end("busy");
        return;
      }
      const r = verifyWebhook({
        secret: receiverSecret,
        id: req.headers["mv-webhook-id"] as string,
        timestamp: req.headers["mv-webhook-timestamp"] as string,
        signature: req.headers["mv-webhook-signature"] as string,
        body,
        seen,
      });
      received.push({ headers: req.headers, body, verdict: r.ok ? "ok" : r.reason });
      res.writeHead(r.ok ? 200 : r.reason === "replayed" ? 409 : 401).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});
test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
  delete process.env.MV_WEBHOOK_ALLOW_LOCAL;
  delete process.env.MFA_SECRET_KEY;
});

test("API keys: owners and admins only, stored as a fingerprint, revocable, rate limited, scoped to their space", async () => {
  const [owner, other, stranger] = [await mk("pk_owner"), await mk("pk_other"), await mk("pk_x")];
  const org = await createOrg(db, owner, { name: "Partner Space", description: "" });
  const otherOrg = await createOrg(db, other, { name: "Other Space", description: "" });
  await rejects(createApiKey(db, stranger, org.id, "Site"), "forbidden");
  const { id, key, prefix } = await createApiKey(db, owner, org.id, "Main site");
  assert.match(key, /^mvk_[A-Za-z0-9_-]{40}$/);
  assert.equal(prefix, key.slice(0, 12));
  const [row] = await db.query<{ key_hash: string }>("select key_hash from api_keys where id = $1", [id]);
  assert.notEqual(row.key_hash, key);
  assert.ok(!(await listApiKeys(db, org.id)).some((k) => JSON.stringify(k).includes(key)), "the key itself is never listed");
  const ok = await authenticateKey(db, `Bearer ${key}`);
  assert.ok(ok.ok && ok.auth.orgId === org.id);
  assert.deepEqual(await authenticateKey(db, null), { ok: false, status: 401, code: "unauthorized" });
  assert.deepEqual(await authenticateKey(db, `Bearer ${key.slice(0, -2)}xx`), { ok: false, status: 401, code: "unauthorized" });
  // The limit: requests above the per-minute count are refused with a retry time.
  await db.query("update api_key_usage set count = $2 where key_id = $1", [id, RATE_PER_MINUTE]);
  const limited = await authenticateKey(db, `Bearer ${key}`);
  assert.equal(limited.ok, false);
  assert.ok(!limited.ok && limited.status === 429 && (limited.retryAfter ?? 0) > 0);
  await revokeApiKey(db, owner, id);
  assert.equal((await authenticateKey(db, `Bearer ${key}`)).ok, false);
  // Tenant isolation: a space's key sees its own tournaments only, drafts included; another space's is "not found".
  const mine = await createTournament(db, owner, org.id, base());
  const theirs = await createTournament(db, other, otherOrg.id, base());
  const list = await apiTournaments(db, org.id);
  assert.deepEqual(
    list.map((t) => t.slug),
    [mine.slug],
  );
  assert.equal(await apiTournament(db, org.id, theirs.slug), null);
  assert.equal(await apiMatches(db, org.id, theirs.slug), null);
  assert.equal(await apiTournament(db, org.id, "../etc"), null);
  for (let i = 0; i < 9; i++) await createApiKey(db, owner, org.id, `Key ${i}`);
  await createApiKey(db, owner, org.id, "Tenth");
  await rejects(createApiKey(db, owner, org.id, "Eleventh"), "api_key_limit");
});

test("webhook addresses: HTTPS, no credentials, nothing private or local", () => {
  delete process.env.MV_WEBHOOK_ALLOW_LOCAL;
  try {
    assert.equal(webhookUrl("https://hooks.example.com/mv"), "https://hooks.example.com/mv");
    for (const bad of [
      "http://hooks.example.com/mv",
      "https://user:pw@hooks.example.com/",
      "https://localhost/hook",
      "https://10.1.2.3/hook",
      "https://192.168.0.5/",
      "https://169.254.169.254/latest",
      "https://[::1]/",
      "https://printer.local/",
      "ftp://example.com/",
    ])
      assert.throws(
        () => webhookUrl(bad),
        (e: unknown) => e instanceof DomainError && e.code === "webhook_url",
        bad,
      );
  } finally {
    process.env.MV_WEBHOOK_ALLOW_LOCAL = "1";
  }
  for (const ip of [
    "10.0.0.1",
    "127.0.0.1",
    "172.20.1.1",
    "192.168.1.1",
    "169.254.1.1",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
  ])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "2001:4860:4860::8888"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("webhooks: events from the space's tournaments, signed, retried, replay refused by the receiver", async () => {
  const [owner, p1, p2, p3, p4, other] = await Promise.all(["wh_owner", "wh_p1", "wh_p2", "wh_p3", "wh_p4", "wh_other"].map((n) => mk(n)));
  const org = await createOrg(db, owner, { name: "Hook Space", description: "" });
  const otherOrg = await createOrg(db, other, { name: "Quiet Space", description: "" });
  const url = `http://127.0.0.1:${port}/hook`;
  await rejects(createWebhook(db, owner, org.id, url, []), "webhook_events");
  await rejects(createWebhook(db, p1, org.id, url, ["match.completed"]), "forbidden");
  const hook = await createWebhook(db, owner, org.id, url, ["registration.created", "registration.withdrawn", "match.completed", "tournament.status_changed"]);
  assert.match(hook.secret, /^whsec_/);
  const [stored] = await db.query<{ secret: string; scheme: string }>("select secret, scheme from webhook_endpoints where id = $1", [hook.id]);
  assert.equal(stored.scheme, "aes-256-gcm");
  assert.ok(!stored.secret.includes(hook.secret), "the secret is sealed at rest");
  receiverSecret = hook.secret;

  const t = await createTournament(db, owner, org.id, base());
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  for (const p of [p1, p2, p3, p4]) await register(db, p, t.id);
  // Another space's activity creates nothing for this endpoint.
  const quiet = await createTournament(db, other, otherOrg.id, base());
  await transition(db, other, quiet.id, "PUBLISHED");
  assert.equal(await collectEvents(db), 6, "two status changes and four registrations");
  assert.equal(await collectEvents(db), 0, "an event becomes a delivery once");
  assert.deepEqual(await deliverWebhooks(db), { delivered: 6, retrying: 0, failed: 0 });
  assert.deepEqual(
    received.map((r) => r.verdict),
    ["ok", "ok", "ok", "ok", "ok", "ok"],
  );
  const first = JSON.parse(received[0].body);
  assert.equal(first.type, "tournament.status_changed");
  assert.deepEqual([first.data.from, first.data.to, first.data.tournament.slug], ["DRAFT", "PUBLISHED", t.slug]);
  const reg = received.map((r) => JSON.parse(r.body)).find((b) => b.type === "registration.created");
  assert.equal(reg.data.registration.participant.username, "wh_p1");
  assert.ok(!JSON.stringify(reg).includes("@example.com"), "no contact details in events");

  // Replay: the same captured request sent again is refused by a receiver that remembers ids.
  const captured = received[0];
  const replay = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mv-webhook-id": captured.headers["mv-webhook-id"] as string,
      "mv-webhook-timestamp": captured.headers["mv-webhook-timestamp"] as string,
      "mv-webhook-signature": captured.headers["mv-webhook-signature"] as string,
    },
    body: captured.body,
  });
  assert.equal(replay.status, 409);
  assert.equal(received.at(-1)!.verdict, "replayed");

  // A failing receiver: retried with backoff, then failed after the last attempt, then retried by hand.
  failNext = 1;
  await withdraw(db, p4, t.id);
  await collectEvents(db);
  assert.deepEqual(await deliverWebhooks(db), { delivered: 0, retrying: 1, failed: 0 });
  const [pending] = await db.query<{ id: string; attempts: number; status: string; wait: number }>(
    "select id, attempts, status, extract(epoch from next_attempt_at - now())::int as wait from webhook_deliveries where event_type = 'registration.withdrawn'",
  );
  assert.deepEqual([pending.attempts, pending.status], [1, "pending"]);
  assert.ok(pending.wait > 50 && pending.wait <= 60, "the first retry waits a minute");
  failNext = 1;
  await db.query("update webhook_deliveries set attempts = $2, next_attempt_at = now() where id = $1", [pending.id, MAX_ATTEMPTS - 1]);
  assert.deepEqual(await deliverWebhooks(db), { delivered: 0, retrying: 0, failed: 1 });
  await retryDelivery(db, owner, pending.id);
  assert.deepEqual(await deliverWebhooks(db), { delivered: 1, retrying: 0, failed: 0 });
  await rejects(retryDelivery(db, owner, pending.id), "webhook_delivered");

  // Matches: a completed match is an event with the score and the winner's side.
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const [m] = await db.query<{ id: string }>(
    "select id from matches where tournament_id = $1 and status <> 'completed' and a_reg is not null and b_reg is not null order by round, position limit 1",
    [t.id],
  );
  await officialResult(db, owner, m.id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" });
  await collectEvents(db);
  await deliverWebhooks(db);
  const done = received.map((r) => JSON.parse(r.body)).find((b) => b.type === "match.completed");
  assert.deepEqual([done.data.match.score_a, done.data.match.score_b, done.data.match.winner], [2, 1, "a"]);
  const matches = (await apiMatches(db, org.id, t.slug))!;
  assert.ok(matches.some((x) => x.id === m.id && x.status === "completed" && x.winner === "a"));
  const standings = (await apiStandings(db, org.id, t.slug))!;
  assert.equal(standings.kind, "placements");

  // A new secret: the old one no longer verifies; a test event reaches the receiver with the new one.
  const rotated = await rotateWebhookSecret(db, owner, hook.id);
  assert.notEqual(rotated.secret, hook.secret);
  receiverSecret = rotated.secret;
  await sendTestEvent(db, owner, hook.id);
  await deliverWebhooks(db);
  const ping = received.at(-1)!;
  assert.equal(JSON.parse(ping.body).type, "ping");
  assert.equal(ping.verdict, "ok");
  assert.equal(
    verifyWebhook({
      secret: hook.secret,
      id: ping.headers["mv-webhook-id"] as string,
      timestamp: ping.headers["mv-webhook-timestamp"] as string,
      signature: ping.headers["mv-webhook-signature"] as string,
      body: ping.body,
    }).ok,
    false,
  );
  // A turned-off endpoint gets nothing new.
  await setWebhookActive(db, owner, hook.id, false);
  await rejects(sendTestEvent(db, owner, hook.id), "webhook_inactive");
  await transition(db, owner, t.id, "PAUSED");
  assert.equal(await collectEvents(db), 0);
  assert.equal((await verifyAuditChain(db)).valid, true);
});
