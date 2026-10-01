/**
 * Event rosters. The roster an entrant plays with is captured at registration and kept apart from the team's
 * current line-up. Team leaders edit it until the roster lock (the organiser's lock time, and never after the
 * start); after the lock only the organiser substitutes a player, with a reason. Every change is recorded in
 * roster_changes and the audit log.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { checkRegion, lockTournament, regLeaders, regMembers, requireManager, type TournamentRow } from "./tournaments.ts";
import { checkAdmission } from "./admission.ts";
import { assertNotRestricted } from "./restrictions.ts";
import * as v from "./validate.ts";

const PRE_START = ["DRAFT", "PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"];

/** Leaders may edit the roster only before the start and before the organiser's lock time. */
export const rosterLocked = (t: { status: string; roster_locks_at: Date | string | null }, now = Date.now()) =>
  !PRE_START.includes(t.status) || Boolean(t.roster_locks_at && new Date(t.roster_locks_at).getTime() <= now);

async function teamRegistration(q: Queryable, t: TournamentRow, regId: string) {
  if (t.participant_type !== "team") fail("wrong_participant_type");
  const [reg] = await q.query<{ id: string; team_id: string; status: string }>(
    "select id, team_id, status from registrations where id = $1 and tournament_id = $2 for update",
    [regId, t.id],
  );
  if (!reg || !reg.team_id || !["registered", "waitlisted", "pending"].includes(reg.status)) fail("not_found");
  return reg;
}

async function activeTeamMembers(q: Queryable, teamId: string) {
  const rows = await q.query<{ user_id: string }>(
    "select m.user_id from team_members m join users u on u.id = m.user_id where m.team_id = $1 and u.status = 'active'",
    [teamId],
  );
  return new Set(rows.map((r) => r.user_id));
}

async function rosterOf(q: Queryable, regId: string) {
  return (await q.query<{ user_id: string }>("select user_id from roster_entries where registration_id = $1", [regId])).map((r) => r.user_id);
}

async function addToRoster(q: Queryable, t: TournamentRow, regId: string, userId: string) {
  try {
    await q.query("insert into roster_entries (registration_id, tournament_id, user_id) values ($1, $2, $3)", [regId, t.id, userId]);
  } catch (error) {
    // The player already plays for another entrant of this tournament.
    if (isUniqueViolation(error)) fail("roster_conflict");
    throw error;
  }
}

/** A team leader sets the event roster: team_size to team_size + 3 current team members. */
export async function setRoster(db: Database, user: SessionUser, tournamentId: string, regId: string, memberIds: string[]) {
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    const reg = await teamRegistration(q, t, regId);
    if (!(await regLeaders(q, reg.id)).includes(user.id)) fail("not_team_leader");
    if (rosterLocked(t)) fail("roster_locked");
    const wanted = [...new Set(memberIds)];
    if (wanted.length < t.team_size || wanted.length > t.team_size + 3) fail("invalid_roster");
    const members = await activeTeamMembers(q, reg.team_id);
    if (wanted.some((id) => !members.has(id))) fail("invalid_roster");
    const current = await rosterOf(q, reg.id);
    const removed = current.filter((id) => !wanted.includes(id));
    const added = wanted.filter((id) => !current.includes(id));
    if (!removed.length && !added.length) return;
    await checkRegion(q, t, added);
    await checkAdmission(q, t, added);
    await assertNotRestricted(q, added, "tournament_ban");
    for (const id of removed) await q.query("delete from roster_entries where registration_id = $1 and user_id = $2", [reg.id, id]);
    for (const id of added) await addToRoster(q, t, reg.id, id);
    for (const id of removed)
      await q.query("insert into roster_changes (tournament_id, registration_id, kind, user_out, changed_by) values ($1, $2, 'edit', $3, $4)", [t.id, reg.id, id, user.id]);
    for (const id of added)
      await q.query("insert into roster_changes (tournament_id, registration_id, kind, user_in, changed_by) values ($1, $2, 'edit', $3, $4)", [t.id, reg.id, id, user.id]);
    await notify(q, [...removed, ...added].filter((id) => id !== user.id), "roster_changed", { tournament: t.name, slug: t.slug });
    await audit(q, { actorId: user.id, action: "registration.roster_changed", entity: "tournament", entityId: t.id, data: { registrationId: reg.id, removed, added } });
  });
}

/**
 * The organiser replaces one roster player with another current team member, with a reason. Allowed at any time
 * until the tournament ends; results already recorded stay with the registration.
 */
export async function substitute(db: Database, user: SessionUser, tournamentId: string, regId: string, outId: string, inId: string, reasonInput: unknown) {
  const reason = v.oneLine(reasonInput, 300);
  if (reason.length < 5) fail("invalid_input");
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (["COMPLETED", "CANCELLED", "ARCHIVED"].includes(t.status)) fail("not_editable");
    const reg = await teamRegistration(q, t, regId);
    const current = await rosterOf(q, reg.id);
    if (!current.includes(outId) || current.includes(inId) || outId === inId) fail("invalid_roster");
    if (!(await activeTeamMembers(q, reg.team_id)).has(inId)) fail("invalid_roster");
    await checkRegion(q, t, [inId]);
    await checkAdmission(q, t, [inId]);
    await assertNotRestricted(q, [inId], "tournament_ban");
    await q.query("delete from roster_entries where registration_id = $1 and user_id = $2", [reg.id, outId]);
    await addToRoster(q, t, reg.id, inId);
    await q.query(
      "insert into roster_changes (tournament_id, registration_id, kind, user_out, user_in, reason, changed_by) values ($1, $2, 'substitution', $3, $4, $5, $6)",
      [t.id, reg.id, outId, inId, reason, user.id],
    );
    const told = new Set([outId, inId, ...(await regLeaders(q, reg.id)), ...(await regMembers(q, reg.id))]);
    await notify(q, [...told], "roster_substitution", { tournament: t.name, slug: t.slug, reason });
    await audit(q, { actorId: user.id, action: "registration.substituted", entity: "tournament", entityId: t.id, data: { registrationId: reg.id, out: outId, in: inId, reason } });
  });
}

export type RosterChange = { kind: string; user_out: string | null; user_in: string | null; reason: string; created_at: Date; by: string };

/** Roster history of a registration, newest first, with usernames. */
export async function rosterHistory(q: Queryable, regId: string) {
  return q.query<RosterChange & { out_name: string | null; in_name: string | null }>(
    `select c.kind, c.user_out, c.user_in, c.reason, c.created_at, b.username as by, o.username as out_name, i.username as in_name
       from roster_changes c join users b on b.id = c.changed_by
       left join users o on o.id = c.user_out left join users i on i.id = c.user_in
      where c.registration_id = $1 order by c.created_at desc, c.id desc`,
    [regId],
  );
}
