/**
 * Live operations (owner's specification, section 9): the incident queue of a running event and a referee's
 * hold on one match.
 *
 * Incidents come from participants (calls to the referee) and from staff (technical, conduct, no-show, schedule,
 * other). Each has a priority, may be assigned to a staff member of the event, may be escalated to the owners and
 * administrators of the organising space, and is resolved with a note the reporter sees. A paused match accepts no
 * result, confirmation, check-in or no-show until a referee resumes it or decides it.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail } from "./errors.ts";
import { lockMatchWithTournament, staffFor } from "./matches.ts";
import { canRefereeTournament, regLeaders, regMembers } from "./tournaments.ts";
import * as v from "./validate.ts";

export const STAFF_KINDS = ["technical", "conduct", "no_show", "schedule", "other"] as const;
export type IncidentKind = "referee_call" | (typeof STAFF_KINDS)[number];
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];
/** A call without an answer for this long is shown as overdue, and a repeated call escalates it. */
export const ANSWER_MINUTES = 5;

const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function parsePriority(input: unknown): Priority {
  const p = typeof input === "string" && input ? input : "normal";
  if (!(PRIORITIES as readonly string[]).includes(p)) fail("invalid_input");
  return p as Priority;
}

type Scope = { id: string; org_id: string; name: string; slug: string; status: string };
type IncidentRow = {
  id: string;
  tournament_id: string;
  match_id: string | null;
  kind: IncidentKind;
  side: "a" | "b" | null;
  opened_by: string;
  message: string;
  status: "open" | "resolved";
  priority: Priority;
  assigned_to: string | null;
  escalated_at: Date | null;
  created_at: Date;
};

async function lockScope(q: Queryable, tournamentId: string): Promise<Scope> {
  const [t] = await q.query<Scope>("select id, org_id, name, slug, status from tournaments where id = $1 for update", [tournamentId]);
  if (!t) fail("not_found");
  return t;
}

/** Locks in the order every writer uses: tournament, match (when the incident has one), then the incident. */
async function lockIncident(q: Queryable, incidentId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(incidentId)) fail("not_found");
  const [ref] = await q.query<{ tournament_id: string; match_id: string | null }>("select tournament_id, match_id from incidents where id = $1", [incidentId]);
  if (!ref) fail("not_found");
  let scope: Scope;
  let match: Awaited<ReturnType<typeof lockMatchWithTournament>> | null = null;
  if (ref.match_id) {
    match = await lockMatchWithTournament(q, ref.match_id);
    scope = { id: match.tournament_id, org_id: match.org_id, name: match.t_name, slug: match.t_slug, status: match.t_status };
  } else scope = await lockScope(q, ref.tournament_id);
  const [inc] = await q.query<IncidentRow>("select * from incidents where id = $1 for update", [incidentId]);
  return { scope, match, inc };
}

async function requireStaff(q: Queryable, scope: { id: string; org_id: string }, user: SessionUser) {
  if (!(await canRefereeTournament(q, scope, user))) fail("forbidden");
}

/** Owners and administrators of the organising space: who an escalation reaches. */
export async function escalationTargets(q: Queryable, orgId: string): Promise<string[]> {
  const rows = await q.query<{ user_id: string }>("select user_id from org_members where org_id = $1 and role in ('owner','admin')", [orgId]);
  return rows.map((r) => r.user_id);
}

/** Raises an open incident to urgent and tells the space's owners and administrators. Escalating twice changes nothing. */
export async function escalate(q: Queryable, scope: Scope, inc: IncidentRow, actorId: string, note: string): Promise<boolean> {
  if (inc.status !== "open" || inc.escalated_at) return false;
  await q.query("update incidents set escalated_at = now(), escalation_note = $2, priority = 'urgent' where id = $1", [inc.id, note]);
  await notify(q, (await escalationTargets(q, scope.org_id)).filter((id) => id !== actorId), "incident_escalated", {
    tournament: scope.name,
    slug: scope.slug,
    ...(inc.match_id ? { matchId: inc.match_id } : {}),
  });
  await audit(q, { actorId, action: "tournament.incident_escalated", entity: "tournament", entityId: scope.id, data: { incident: inc.id, kind: inc.kind, note } });
  return true;
}

/** Staff log an incident of their event, optionally about one match; it starts assigned to the reporter. */
export async function openIncident(
  db: Database,
  user: SessionUser,
  tournamentId: string,
  input: { kind?: unknown; priority?: unknown; matchId?: unknown; message?: unknown },
): Promise<{ id: string }> {
  const kind = typeof input.kind === "string" ? input.kind : "";
  if (!(STAFF_KINDS as readonly string[]).includes(kind)) fail("invalid_input");
  const priority = parsePriority(input.priority);
  const message = v.clean(input.message, 500);
  if (message.length < 3) fail("invalid_input");
  const matchId = typeof input.matchId === "string" && input.matchId ? input.matchId : null;
  return db.tx(async (q) => {
    let scope: Scope;
    if (matchId) {
      const m = await lockMatchWithTournament(q, matchId);
      if (m.tournament_id !== tournamentId) fail("invalid_input");
      scope = { id: m.tournament_id, org_id: m.org_id, name: m.t_name, slug: m.t_slug, status: m.t_status };
    } else scope = await lockScope(q, tournamentId);
    await requireStaff(q, scope, user);
    if (!["REGISTRATION_CLOSED", "IN_PROGRESS", "PAUSED"].includes(scope.status)) fail("tournament_not_live");
    const [row] = await q.query<{ id: string }>(
      `insert into incidents (tournament_id, match_id, kind, opened_by, message, priority, assigned_to, assigned_at)
       values ($1, $2, $3, $4, $5, $6, $4, now()) returning id`,
      [scope.id, matchId, kind, user.id, message, priority],
    );
    await audit(q, { actorId: user.id, action: "tournament.incident_opened", entity: "tournament", entityId: scope.id, data: { incident: row.id, kind, priority, matchId } });
    return { id: row.id };
  });
}

/** Assigns an open incident to a staff member of the event ("me", a user id), or clears the assignee (""). */
export async function assignIncident(db: Database, user: SessionUser, incidentId: string, assigneeInput: unknown): Promise<{ changed: boolean }> {
  return db.tx(async (q) => {
    const { scope, inc } = await lockIncident(q, incidentId);
    await requireStaff(q, scope, user);
    if (inc.status !== "open") fail("not_editable");
    const raw = typeof assigneeInput === "string" ? assigneeInput : "";
    const assignee = raw === "me" ? user.id : raw ? raw : null;
    if (assignee && assignee !== user.id && !(await staffFor(q, scope.org_id, scope.id)).includes(assignee)) fail("invalid_input");
    if (assignee === inc.assigned_to) return { changed: false };
    await q.query("update incidents set assigned_to = $2, assigned_at = case when $2::uuid is null then null else now() end where id = $1", [inc.id, assignee]);
    if (assignee && assignee !== user.id)
      await notify(q, [assignee], "incident_assigned", { tournament: scope.name, slug: scope.slug, ...(inc.match_id ? { matchId: inc.match_id } : {}) });
    await audit(q, { actorId: user.id, action: "tournament.incident_assigned", entity: "tournament", entityId: scope.id, data: { incident: inc.id, assignee } });
    return { changed: true };
  });
}

export async function setIncidentPriority(db: Database, user: SessionUser, incidentId: string, priorityInput: unknown): Promise<{ changed: boolean }> {
  const priority = parsePriority(priorityInput);
  return db.tx(async (q) => {
    const { scope, inc } = await lockIncident(q, incidentId);
    await requireStaff(q, scope, user);
    if (inc.status !== "open") fail("not_editable");
    if (inc.priority === priority) return { changed: false };
    await q.query("update incidents set priority = $2 where id = $1", [inc.id, priority]);
    await audit(q, { actorId: user.id, action: "tournament.incident_priority", entity: "tournament", entityId: scope.id, data: { incident: inc.id, from: inc.priority, to: priority } });
    return { changed: true };
  });
}

export async function escalateIncident(db: Database, user: SessionUser, incidentId: string, noteInput: unknown): Promise<{ escalated: boolean }> {
  const note = v.clean(noteInput, 500);
  return db.tx(async (q) => {
    const { scope, inc } = await lockIncident(q, incidentId);
    await requireStaff(q, scope, user);
    if (inc.status !== "open") fail("not_editable");
    return { escalated: await escalate(q, scope, inc, user.id, note) };
  });
}

/**
 * Staff resolve an open incident with a note. The reporter hears back; for a call to the referee the side's
 * leaders do too. Resolving a resolved incident changes nothing and notifies nobody.
 */
export async function resolveIncident(db: Database, user: SessionUser, incidentId: string, noteInput: unknown): Promise<{ matchId: string | null; closed: boolean }> {
  const note = v.clean(noteInput, 500);
  return db.tx(async (q) => {
    const { scope, match, inc } = await lockIncident(q, incidentId);
    await requireStaff(q, scope, user);
    if (inc.status !== "open") return { matchId: inc.match_id, closed: false };
    await q.query("update incidents set status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now() where id = $1", [inc.id, note, user.id]);
    if (inc.kind === "referee_call") {
      const leaders = inc.side && match ? await regLeaders(q, inc.side === "a" ? match.a_reg : match.b_reg) : [];
      await notify(q, [inc.opened_by, ...leaders].filter((id) => id !== user.id), "referee_call_closed", { tournament: scope.name, matchId: inc.match_id });
      await audit(q, { actorId: user.id, action: "match.referee_call_closed", entity: "match", entityId: inc.match_id!, data: { incident: inc.id } });
    } else {
      if (inc.opened_by !== user.id)
        await notify(q, [inc.opened_by], "incident_resolved", { tournament: scope.name, slug: scope.slug, ...(inc.match_id ? { matchId: inc.match_id } : {}) });
      await audit(q, { actorId: user.id, action: "tournament.incident_resolved", entity: "tournament", entityId: scope.id, data: { incident: inc.id, kind: inc.kind } });
    }
    return { matchId: inc.match_id, closed: true };
  });
}

export type QueueItem = {
  id: string;
  kind: IncidentKind;
  priority: Priority;
  status: "open" | "resolved";
  message: string;
  side: "a" | "b" | null;
  match_id: string | null;
  a_name: string | null;
  b_name: string | null;
  created_at: Date;
  opened_by: string;
  assigned_to: string | null;
  assigned_to_id: string | null;
  escalated_at: Date | null;
  escalation_note: string;
  resolution: string;
  resolved_by: string | null;
  resolved_at: Date | null;
};

/** Open incidents first by priority, escalated first within a priority, then oldest first; then the last resolved ones. */
export async function incidentQueue(q: Queryable, tournamentId: string, resolvedLimit = 20) {
  const rows = await q.query<QueueItem>(
    `select i.id, i.kind, i.priority, i.status, i.message, i.side, i.match_id, i.created_at, i.escalated_at, i.escalation_note,
            i.resolution, i.resolved_at, u.username as opened_by, au.username as assigned_to, i.assigned_to as assigned_to_id, ru.username as resolved_by,
            coalesce(ta.name, ua.display_name) as a_name, coalesce(tb.name, ub.display_name) as b_name
       from incidents i join users u on u.id = i.opened_by
       left join users au on au.id = i.assigned_to left join users ru on ru.id = i.resolved_by
       left join matches m on m.id = i.match_id
       left join registrations ra on ra.id = m.a_reg left join teams ta on ta.id = ra.team_id left join users ua on ua.id = ra.user_id
       left join registrations rb on rb.id = m.b_reg left join teams tb on tb.id = rb.team_id left join users ub on ub.id = rb.user_id
      where i.tournament_id = $1 and (i.status = 'open' or i.resolved_at > now() - interval '7 days')
      order by i.created_at`,
    [tournamentId],
  );
  const open = rows
    .filter((r) => r.status === "open")
    .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || Number(Boolean(b.escalated_at)) - Number(Boolean(a.escalated_at)) || new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const resolved = rows
    .filter((r) => r.status === "resolved")
    .sort((a, b) => new Date(b.resolved_at!).getTime() - new Date(a.resolved_at!).getTime())
    .slice(0, resolvedLimit);
  return { open, resolved };
}

/** Whether an open incident has waited past the answer time without an assignee. */
export const overdue = (i: Pick<QueueItem, "status" | "assigned_to_id" | "created_at">, now = new Date()) =>
  i.status === "open" && !i.assigned_to_id && now.getTime() - new Date(i.created_at).getTime() > ANSWER_MINUTES * 60_000;

/** Staff of the event who can take an incident: the space's members and the event's co-organisers. */
export async function eventStaff(q: Queryable, orgId: string, tournamentId: string) {
  return q.query<{ id: string; username: string; display_name: string }>(
    `select u.id, u.username, u.display_name from users u
      where u.id in (select user_id from org_members where org_id = $1 union select user_id from tournament_organizers where tournament_id = $2)
      order by u.username`,
    [orgId, tournamentId],
  );
}

// ---------- Match hold ----------

const HOLDABLE = ["ready", "in_progress", "result_submitted", "disputed"];

/** A referee pauses a match with a reason; both sides are told. Pausing a paused match changes nothing. */
export async function pauseMatch(db: Database, user: SessionUser, matchId: string, reasonInput: unknown): Promise<{ changed: boolean }> {
  const reason = v.clean(reasonInput, 300);
  if (reason.length < 3) fail("invalid_input");
  return db.tx(async (q) => {
    const m = await lockMatchWithTournament(q, matchId);
    await requireStaff(q, { id: m.tournament_id, org_id: m.org_id }, user);
    if (!["IN_PROGRESS", "PAUSED"].includes(m.t_status)) fail("tournament_not_live");
    if (!HOLDABLE.includes(m.status) || !m.a_reg || !m.b_reg) fail("match_not_ready");
    if (m.paused_at) return { changed: false };
    await q.query("update matches set paused_at = now(), pause_reason = $2, updated_at = now() where id = $1", [m.id, reason]);
    await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "match_paused", { tournament: m.t_name, matchId: m.id });
    await audit(q, { actorId: user.id, action: "match.paused", entity: "match", entityId: m.id, data: { reason } });
    return { changed: true };
  });
}

/** A referee resumes a paused match; both sides are told. Resuming a running match changes nothing. */
export async function resumeMatch(db: Database, user: SessionUser, matchId: string): Promise<{ changed: boolean }> {
  return db.tx(async (q) => {
    const m = await lockMatchWithTournament(q, matchId);
    await requireStaff(q, { id: m.tournament_id, org_id: m.org_id }, user);
    if (!m.paused_at) return { changed: false };
    await q.query("update matches set paused_at = null, pause_reason = '', updated_at = now() where id = $1", [m.id]);
    await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "match_resumed", { tournament: m.t_name, matchId: m.id });
    await audit(q, { actorId: user.id, action: "match.resumed", entity: "match", entityId: m.id, data: {} });
    return { changed: true };
  });
}
