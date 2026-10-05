import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { isAdmin, requireSection } from "./access.ts";
import { requireStepUp } from "./mfa.ts";
import { audit } from "./audit.ts";
import { fail } from "./errors.ts";
import * as v from "./validate.ts";
import { FORMATS, STATUSES, transition } from "./tournaments.ts";
import { recordStaffView } from "./admin.ts";
import { playerProfile } from "./queries.ts";
import { trustReport } from "./conduct.ts";

const literal = (x: unknown) =>
  `%${String(x ?? "")
    .trim()
    .slice(0, 100)
    .replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const pageOf = (x: unknown) =>
  Math.max(1, Math.min(10000, Number.isInteger(Number(x)) ? Number(x) : 1));
export type EventRow = {
  id: string;
  slug: string;
  name: string;
  game: string;
  format: string;
  status: string;
  org_name: string;
  org_slug: string;
  org_id: string;
  starts_at: Date;
  registered: number;
  waiting: number;
  pending: number;
  checked_in: number;
  max_participants: number;
  check_in_open: boolean;
  total: number;
};
export async function searchEvents(
  q: Queryable,
  staff: SessionUser,
  input: Record<string, unknown> = {},
) {
  requireSection(staff, "tournaments");
  const page = pageOf(input.page);
  const rows = await q.query<EventRow>(
    `select t.id,t.slug,t.name,t.game,t.format,t.status,t.org_id,t.starts_at,t.max_participants,t.check_in_open,
    o.name as org_name,o.slug as org_slug,count(*) over()::int as total,
    (select count(*)::int from registrations r where r.tournament_id=t.id and r.status='registered') as registered,
    (select count(*)::int from registrations r where r.tournament_id=t.id and r.status='waitlisted') as waiting,
    (select count(*)::int from registrations r where r.tournament_id=t.id and r.status='pending') as pending,
    (select count(*)::int from registrations r where r.tournament_id=t.id and r.status='registered' and r.checked_in_at is not null) as checked_in
    from tournaments t join organizations o on o.id=t.org_id
    where (t.name ilike $1 or t.slug ilike $1 or o.name ilike $1) and ($2='' or t.game=$2)
      and ($3='' or t.format=$3) and ($4='' or t.status=$4)
    order by t.created_at desc,t.id limit 40 offset $5`,
    [
      literal(input.q),
      String(input.game ?? ""),
      FORMATS.includes(input.format as never) ? input.format : "",
      STATUSES.includes(input.status as never) ? input.status : "",
      (page - 1) * 40,
    ],
  );
  return { rows, page, total: rows[0]?.total ?? 0 };
}
export async function adminTransition(
  db: Database,
  actor: SessionUser,
  id: string,
  to: unknown,
  reasonInput: unknown,
) {
  if (!isAdmin(actor)) fail("forbidden");
  requireStepUp(actor);
  const reason = v.clean(reasonInput, 500);
  if (reason.length < 10) fail("invalid_input");
  // The existing state machine and bracket completion checks remain authoritative.
  // Both the domain transition and the explanation commit (or roll back) together.
  return db.tx(async (q) => {
    const nested: Database = { ...db, query: q.query, tx: (fn) => fn(q) };
    await transition(nested, actor, id, to);
    await audit(q, {
      actorId: actor.id,
      action: "tournament.admin_transition",
      entity: "tournament",
      entityId: id,
      data: { to, reason },
    });
  });
}
export async function staffProfile(
  db: Database,
  staff: SessionUser,
  username: string,
) {
  requireSection(staff, "users");
  const profile = await playerProfile(db, username, staff);
  if (!profile || profile.hidden) return null;
  await recordStaffView(
    db,
    staff,
    profile.user.id,
    "admin_profile_history_accounts",
  );
  const spaces = await db.query<{
    id: string;
    name: string;
    slug: string;
    role: string;
  }>(
    `select o.id,o.name,o.slug,m.role from org_members m join organizations o on o.id=m.org_id where m.user_id=$1 order by o.name`,
    [profile.user.id],
  );
  return { ...profile, spaces };
}
export async function setOrganizerAccess(
  db: Database,
  actor: SessionUser,
  userId: string,
  orgId: string,
  roleInput: unknown,
  reasonInput: unknown,
) {
  if (!isAdmin(actor)) fail("forbidden");
  requireStepUp(actor);
  const role = String(roleInput),
    reason = v.clean(reasonInput, 500);
  if (!["admin", "referee", "remove"].includes(role) || reason.length < 10)
    fail("invalid_input");
  await db.tx(async (q) => {
    const [org] = await q.query(
      "select id from organizations where id=$1 for update",
      [orgId],
    );
    const [target] = await q.query(
      "select id from users where id=$1 and status='active'",
      [userId],
    );
    if (!org || !target) fail("not_found");
    const [old] = await q.query<{ role: string }>(
      "select role from org_members where org_id=$1 and user_id=$2",
      [orgId, userId],
    );
    if (old?.role === "owner") fail("last_owner");
    if (role === "remove")
      await q.query("delete from org_members where org_id=$1 and user_id=$2", [
        orgId,
        userId,
      ]);
    else
      await q.query(
        "insert into org_members(org_id,user_id,role) values($1,$2,$3) on conflict(org_id,user_id) do update set role=$3",
        [orgId, userId, role],
      );
    await audit(q, {
      actorId: actor.id,
      action: "org.admin_access",
      entity: "organization",
      entityId: orgId,
      data: { userId, before: old?.role ?? null, role, reason },
    });
  });
}
export async function searchApplications(
  q: Queryable,
  staff: SessionUser,
  input: Record<string, unknown> = {},
) {
  requireSection(staff, "applications");
  const page = pageOf(input.page);
  const rows = await q.query<{
    id: string;
    kind: string;
    name: string;
    email: string;
    company: string;
    message: string;
    status: string;
    decision: string;
    decider: string | null;
    decided_at: Date | null;
    version: number;
    created_at: Date;
    total: number;
  }>(
    `select a.*,u.username as decider,count(*) over()::int as total from applications a left join users u on u.id=a.decided_by
     where ($1='' or a.status=$1) and ($2='' or a.kind=$2) and (a.name ilike $3 or a.company ilike $3 or a.email ilike $3)
     order by a.created_at desc,a.id limit 40 offset $4`,
    [
      String(input.status ?? ""),
      String(input.kind ?? ""),
      literal(input.q),
      (page - 1) * 40,
    ],
  );
  return { rows, page, total: rows[0]?.total ?? 0 };
}
export async function decideApplication(
  db: Database,
  staff: SessionUser,
  id: string,
  input: Record<string, unknown>,
) {
  requireSection(staff, "applications");
  requireStepUp(staff);
  const status = String(input.status),
    reason = v.clean(input.reason, 2000),
    version = v.intIn(input.version, 1, 2147483647);
  if (
    !["new", "in_review", "closed", "approved", "rejected"].includes(status) ||
    reason.length < 10
  )
    fail("invalid_input");
  await db.tx(async (q) => {
    const [old] = await q.query<{ status: string; version: number }>(
      "select status,version from applications where id=$1 for update",
      [id],
    );
    if (!old) fail("not_found");
    if (old.version !== version) fail("not_editable");
    await q.query(
      "update applications set status=$2,decision=$3,decided_by=$4,decided_at=now(),version=version+1,updated_at=now() where id=$1",
      [id, status, reason, staff.id],
    );
    await audit(q, {
      actorId: staff.id,
      action: "application.decided",
      entity: "application",
      entityId: id,
      data: { before: old.status, status, reason, version: version + 1 },
    });
  });
}
export type DecisionRow = {
  id: string;
  at: Date;
  actor: string | null;
  action: string;
  entity: string;
  entity_id: string;
  data: Record<string, unknown>;
  hash: string;
  prev_hash: string;
};
export async function searchDecisions(
  q: Queryable,
  staff: SessionUser,
  input: Record<string, unknown> = {},
) {
  requireSection(staff, "audit");
  const before = /^\d+$/.test(String(input.before))
    ? String(input.before)
    : "9223372036854775807";
  const date = (x: unknown) =>
    typeof x === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(x) &&
    Number.isFinite(Date.parse(x))
      ? x
      : null;
  const rows = await q.query<DecisionRow>(
    `select a.id::text,a.at,u.username as actor,a.action,a.entity,a.entity_id,a.data,a.hash,a.prev_hash
     from audit_log a left join users u on u.id=a.actor_id where a.id<$1::bigint and ($2='' or a.action=$2)
     and ($3='' or a.entity=$3) and ($4='' or a.entity_id=$4) and (coalesce(u.username,'system') ilike $5)
     and ($6::date is null or a.at >= $6::date) and ($7::date is null or a.at < $7::date+interval '1 day')
     order by a.id desc limit 51`,
    [
      before,
      String(input.action ?? "").slice(0, 100),
      String(input.entity ?? "").slice(0, 80),
      String(input.id ?? "").slice(0, 100),
      literal(input.actor),
      date(input.from),
      date(input.to),
    ],
  );
  return {
    rows: rows.slice(0, 50),
    next: rows.length > 50 ? rows[49].id : null,
  };
}
export async function trustDashboard(q: Queryable, staff: SessionUser) {
  requireSection(staff, "overview");
  const report = await trustReport(q);
  const [ops] = await q.query<{
    open_reports: number;
    reviewing_reports: number;
    open_appeals: number;
    unassigned_appeals: number;
    oldest_report: Date | null;
  }>(`select
    (select count(*)::int from conduct_reports where status='open') as open_reports,
    (select count(*)::int from conduct_reports where status='reviewing') as reviewing_reports,
    (select count(*)::int from sanction_appeals where status='open') as open_appeals,
    (select count(*)::int from sanction_appeals where status='open' and assigned_to is null) as unassigned_appeals,
    (select min(created_at) from conduct_reports where status in ('open','reviewing')) as oldest_report`);
  return { report, ops };
}
