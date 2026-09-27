import type { Database } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { isAdmin, isStaff } from "./access.ts";
import { fail } from "./errors.ts";
import { sha256 } from "./auth.ts";
import * as v from "./validate.ts";

export const APPLICATION_KINDS = [
  "partner",
  "sponsor",
  "organizer",
  "academy",
  "coach",
  "venue",
  "clubhouse",
  "cloud_gaming",
  "gpu_host",
  "server_rental",
  "shop",
  "marketplace",
  "media",
  "community",
  "school",
  "investor",
  "contact",
  "support",
] as const;
export type ApplicationKind = (typeof APPLICATION_KINDS)[number];

export async function createApplication(
  db: Database,
  input: { kind: unknown; name: unknown; email: unknown; company: unknown; message: unknown; lang: unknown; consent: unknown; website?: unknown },
  user: SessionUser | null,
) {
  if (typeof input.website === "string" && input.website.trim()) fail("invalid_input");
  const kind = APPLICATION_KINDS.includes(input.kind as ApplicationKind) ? (input.kind as ApplicationKind) : fail("invalid_input");
  const name = v.displayName(input.name, 100);
  const email = v.email(input.email);
  const company = v.oneLine(input.company, 150);
  const message = v.clean(input.message, 3000);
  const lang = input.lang === "en" ? "en" : "ru";
  if (!v.bool(input.consent)) fail("consent_required");
  const key = `app:${sha256(email)}`;
  const [recent] = await db.query<{ n: number }>(
    "select count(*)::int as n from auth_attempts where key = $1 and at > now() - interval '10 minutes'",
    [key],
  );
  if ((recent?.n ?? 0) >= 5) fail("too_many_attempts");
  const id = await db.tx(async (q) => {
    await q.query("insert into auth_attempts (key, ok) values ($1, true)", [key]);
    const [row] = await q.query<{ id: string }>(
      `insert into applications (kind, name, email, company, message, lang, user_id)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [kind, name, email, company, message, lang, user?.id ?? null],
    );
    await audit(q, { actorId: user?.id ?? null, action: "application.created", entity: "application", entityId: row.id, data: { kind } });
    return row.id;
  });
  await forward({ id, kind, name, email, company, message, lang }).catch(() => {});
  return id;
}

/** Optional delivery to an external CRM. The application is already stored before this runs. */
async function forward(payload: Record<string, string>) {
  const endpoint = process.env.LEAD_WEBHOOK_URL;
  if (!endpoint || !endpoint.startsWith("https://")) return;
  await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.LEAD_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.LEAD_WEBHOOK_TOKEN}` } : {}),
    },
    body: JSON.stringify({ source: "maximus.vegas", receivedAt: new Date().toISOString(), ...payload }),
    signal: AbortSignal.timeout(5000),
    redirect: "error",
    cache: "no-store",
  });
}

export async function setApplicationStatus(db: Database, user: SessionUser, id: string, status: unknown) {
  if (!isStaff(user)) fail("forbidden");
  const next = ["new", "in_review", "closed"].includes(String(status)) ? String(status) : fail("invalid_input");
  await db.tx(async (q) => {
    const rows = await q.query("update applications set status = $2, updated_at = now() where id = $1 returning id", [id, next]);
    if (!rows.length) fail("not_found");
    await audit(q, { actorId: user.id, action: "application.status", entity: "application", entityId: id, data: { status: next } });
  });
}

export async function setRole(db: Database, user: SessionUser, targetId: string, roleInput: unknown, grant: boolean) {
  if (!isAdmin(user)) fail("forbidden");
  const role = ["admin", "referee", "support"].includes(String(roleInput)) ? String(roleInput) : fail("invalid_input");
  await db.tx(async (q) => {
    if (!grant && role === "admin") {
      if (targetId === user.id) fail("cannot_modify_self");
      const [n] = await q.query<{ n: number }>("select count(*)::int as n from user_roles where role = 'admin'");
      if ((n?.n ?? 0) <= 1) fail("last_owner");
    }
    if (grant)
      await q.query("insert into user_roles (user_id, role, granted_by) values ($1, $2, $3) on conflict do nothing", [targetId, role, user.id]);
    else await q.query("delete from user_roles where user_id = $1 and role = $2", [targetId, role]);
    await audit(q, { actorId: user.id, action: grant ? "role.granted" : "role.revoked", entity: "user", entityId: targetId, data: { role } });
  });
}

export async function setUserStatus(db: Database, user: SessionUser, targetId: string, statusInput: unknown, reasonInput: unknown) {
  if (!isAdmin(user)) fail("forbidden");
  if (targetId === user.id) fail("cannot_modify_self");
  const status = statusInput === "suspended" ? "suspended" : statusInput === "active" ? "active" : fail("invalid_input");
  const reason = v.oneLine(reasonInput, 300);
  if (status === "suspended" && reason.length < 5) fail("invalid_input");
  await db.tx(async (q) => {
    const rows = await q.query("update users set status = $2, updated_at = now() where id = $1 and status <> 'deleted' returning id", [targetId, status]);
    if (!rows.length) fail("not_found");
    if (status === "suspended") await q.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [targetId]);
    await audit(q, { actorId: user.id, action: `user.${status}`, entity: "user", entityId: targetId, data: { reason } });
  });
}

export async function markNotificationsRead(db: Database, user: SessionUser) {
  await db.query("update notifications set read_at = now() where user_id = $1 and read_at is null", [user.id]);
}
