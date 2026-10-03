/**
 * MV-STAFF-1 system controls: feature switches, maintenance mode and the status panel.
 *
 * A switch turns off the start of something new in one feature without a deploy (its actions are refused
 * with feature_disabled). What is already under way can still be finished, left or decided, so nothing in
 * flight is stranded. Maintenance refuses every action of accounts without a staff role except signing in
 * and out; pages still render with a banner. Staff keep working through both, to check a fix before
 * switching back. A missing row means the default: features on, maintenance off. Every change is
 * recorded in the hash-chained log; maintenance needs a recently confirmed second factor.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { isStaff, requireSection } from "./access.ts";
import { requireStepUp } from "./mfa.ts";
import { fail } from "./errors.ts";
import * as v from "./validate.ts";

export const FEATURES = ["quick_match", "challenges", "finder", "scouting", "clans", "transfers", "venues", "integrations", "academy", "connections", "cloud_gaming", "recurring_pass"] as const;
export type Feature = (typeof FEATURES)[number];
export const isFeature = (value: unknown): value is Feature => typeof value === "string" && (FEATURES as readonly string[]).includes(value);

/** Actions that start something new in each feature. */
const FEATURE_ACTIONS: Record<Feature, readonly string[]> = {
  quick_match: ["quick.join", "party.create", "party.invite"],
  challenges: ["challenge.create"],
  finder: ["finder.post", "finder.apply"],
  scouting: ["scout.save", "scout.watch"],
  clans: ["clan.create", "clan.invite", "war.propose"],
  transfers: ["transfer.propose"],
  venues: ["venue.create", "venue.submit", "pass.guest", "club.book", "club.rsvp", "club.event", "club.station"],
  integrations: ["integrations.key_create", "integrations.webhook_create", "integrations.webhook_test", "integrations.delivery_retry", "stats.source", "stats.link", "stats.intake"],
  academy: ["coach.submit", "training.request"],
  connections: ["social.profile", "social.like"],
  cloud_gaming: ["p2p.register", "p2p.allocate"],
  recurring_pass: ["reward.create", "reward.reserve"],
};

export const featureOf = (action: string): Feature | null => FEATURES.find((f) => FEATURE_ACTIONS[f].includes(action)) ?? null;

/** Open to everyone during maintenance: staff must be able to sign in and confirm their second factor. */
const MAINTENANCE_OK = new Set(["auth.signin", "auth.signout", "mfa.verify"]);

type Flag = {
  key: string;
  enabled: boolean;
  note: string;
  updated_at: Date;
  updated_by: string | null;
};
const TTL_MS = 1_000;
const cache = new WeakMap<object, { at: number; flags: Map<string, Flag> }>();

/** Switch rows, cached for one second per module instance: one read serves a burst of checks, and a change applies everywhere within a second. */
async function flags(db: Queryable): Promise<Map<string, Flag>> {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.flags;
  const rows = await db.query<Flag>(
    "select f.key, f.enabled, f.note, f.updated_at, u.username as updated_by from feature_flags f left join users u on u.id = f.updated_by",
  );
  const map = new Map(rows.map((r) => [r.key, r]));
  cache.set(db, { at: Date.now(), flags: map });
  return map;
}

export async function featureEnabled(db: Queryable, feature: Feature): Promise<boolean> {
  return (await flags(db)).get(feature)?.enabled ?? true;
}

export async function maintenanceState(db: Queryable): Promise<{ on: boolean; note: string; since: Date | null }> {
  const m = (await flags(db)).get("maintenance");
  return m?.enabled ? { on: true, note: m.note, since: m.updated_at } : { on: false, note: "", since: null };
}

/** Called before every action: maintenance first, then the action's feature switch. */
export async function gate(db: Queryable, action: string, user: SessionUser | null) {
  if (isStaff(user)) return;
  const m = await maintenanceState(db);
  if (m.on && !MAINTENANCE_OK.has(action)) fail("maintenance");
  const feature = featureOf(action);
  if (feature && !(await featureEnabled(db, feature))) fail("feature_disabled");
}

/** Switches a feature or maintenance; the note is shown to users (maintenance) or kept for colleagues. */
export async function setFlag(db: Database, user: SessionUser, keyInput: unknown, enabled: boolean, noteInput: unknown) {
  requireSection(user, "system");
  const key = keyInput === "maintenance" || isFeature(keyInput) ? String(keyInput) : fail("invalid_input");
  if (key === "maintenance") requireStepUp(user);
  const note = v.oneLine(noteInput, 300);
  await db.tx(async (q) => {
    await q.query(
      `insert into feature_flags (key, enabled, note, updated_by, updated_at) values ($1, $2, $3, $4, now())
       on conflict (key) do update set enabled = excluded.enabled, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()`,
      [key, enabled, note, user.id],
    );
    await audit(q, {
      actorId: user.id,
      action: "system.flag",
      entity: "feature_flag",
      entityId: key,
      data: { enabled, note },
    });
  });
  cache.delete(db);
}

/** The last run of a scheduled job, for the status panel. */
export async function recordRun(db: Queryable, name: string, result: Record<string, unknown>) {
  await db.query(
    `insert into system_runs (name, last_at, result) values ($1, now(), $2)
     on conflict (name) do update set last_at = excluded.last_at, result = excluded.result`,
    [name, JSON.stringify(result)],
  );
}

const count = async (q: Queryable, sql: string) => (await q.query<{ n: number }>(sql))[0]?.n ?? 0;
const oldest = async (q: Queryable, sql: string) => (await q.query<{ at: Date | null }>(sql))[0]?.at ?? null;

/** Live state for the system tab: services, queues, delays, errors, size and switches. Never secrets. */
export async function systemStatus(db: Database) {
  const started = Date.now();
  await db.query("select 1");
  const latencyMs = Date.now() - started;
  const [migration] = await db.query<{
    id: number;
    name: string;
    applied_at: Date;
  }>("select id, name, applied_at from schema_migrations order by id desc limit 1");
  const size = await db
    .query<{ bytes: string }>("select pg_database_size(current_database())::text as bytes")
    .then((r) => Number(r[0]?.bytes ?? 0))
    .catch(() => null);
  const [mailPending, mailFailed, mailOldest, hooksPending, hooksFailed, hooksOldest, openIncidents, queued, runs] = await Promise.all([
    count(db, "select count(*)::int as n from email_outbox where status in ('pending','sending')"),
    count(db, "select count(*)::int as n from email_outbox where status = 'failed'"),
    oldest(db, "select min(created_at) as at from email_outbox where status in ('pending','sending')"),
    count(db, "select count(*)::int as n from webhook_deliveries where status = 'pending'"),
    count(db, "select count(*)::int as n from webhook_deliveries where status = 'failed'"),
    oldest(db, "select min(created_at) as at from webhook_deliveries where status = 'pending'"),
    count(db, "select count(*)::int as n from incidents where status <> 'resolved'"),
    count(db, "select count(*)::int as n from quick_queue"),
    db.query<{ name: string; last_at: Date; result: Record<string, unknown> }>("select name, last_at, result from system_runs order by name"),
  ]);
  const all = await flags(db);
  return {
    latencyMs,
    migration: migration ?? null,
    sizeBytes: size,
    mail: { pending: mailPending, failed: mailFailed, oldest: mailOldest },
    webhooks: {
      pending: hooksPending,
      failed: hooksFailed,
      oldest: hooksOldest,
    },
    openIncidents,
    queued,
    runs,
    features: FEATURES.map((f) => ({
      key: f,
      enabled: all.get(f)?.enabled ?? true,
      note: all.get(f)?.note ?? "",
      updated_at: all.get(f)?.updated_at ?? null,
      updated_by: all.get(f)?.updated_by ?? null,
    })),
    maintenance: all.get("maintenance") ?? null,
    /** Whether each setting is present: names only, never values. */
    config: {
      database: true,
      secretKey: Boolean(process.env.MFA_SECRET_KEY?.trim()),
      cronSecret: (process.env.CRON_SECRET?.trim().length ?? 0) >= 16,
      siteUrl: Boolean(process.env.NEXT_PUBLIC_SITE_URL?.trim()),
    },
  };
}
