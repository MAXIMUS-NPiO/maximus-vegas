/**
 * Batch changes of the match schedule during an event: set the start of one round, or shift every open match
 * (of one round or of the whole event) by a number of minutes; place a round's matches on the venues in
 * waves. Both sides of every moved match are notified; each change is one audit record. Completed and
 * cancelled matches never move.
 *
 * Venues (stages, stations, servers) and conflicts (MV-SCHEDULE-1, see conflicts.ts): a change that makes a
 * venue host two matches at once, or an entrant or a player play two matches at once — in this tournament or
 * in another one — is refused (schedule_conflict) unless the organiser confirms it; a confirmed override is
 * recorded with the conflicts it creates.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { lockTournament, regMembers, requireManager } from "./tournaments.ts";
import { DEFAULT_MATCH_MINUTES, findConflicts, planWaves, SCHEDULE_VERSION, type Conflict, type Slot } from "./conflicts.ts";
import * as v from "./validate.ts";

/** A round of a tournament: stage, bracket and round number ("1:W:2"); "all" is every open match. */
export type RoundKey = { stage: number; bracket: string; round: number } | "all";

export function parseRoundKey(value: unknown): RoundKey {
  const text = String(value ?? "").trim();
  if (text === "all") return "all";
  const m = /^([12]):(W|L|GF|RR|SW|G):(\d{1,3})$/.exec(text);
  if (!m) return fail("invalid_input");
  return { stage: Number(m[1]), bracket: m[2], round: Number(m[3]) };
}

export const roundKeyOf = (m: { stage?: number | null; bracket?: string | null; round: number }) => `${m.stage ?? 1}:${m.bracket ?? "W"}:${m.round}`;

type Open = { id: string; a_reg: string | null; b_reg: string | null; scheduled_at: Date | null };

async function openMatches(q: Queryable, tournamentId: string, key: RoundKey) {
  const base = "select id, a_reg, b_reg, scheduled_at from matches where tournament_id = $1 and status not in ('completed','cancelled')";
  return key === "all"
    ? q.query<Open>(`${base} order by stage, bracket, round, position for update`, [tournamentId])
    : q.query<Open>(`${base} and stage = $2 and bracket = $3 and round = $4 order by position for update`, [tournamentId, key.stage, key.bracket, key.round]);
}

/**
 * Moves open matches. `at` (local date-time in `timeZone`) sets the start of a round; `shiftMinutes`
 * (−1440…1440, not 0) moves every open match that already has a time.
 */
export async function reschedule(
  db: Database,
  user: SessionUser,
  tournamentId: string,
  input: { round: unknown; at?: unknown; timeZone?: unknown; shiftMinutes?: unknown; force?: unknown },
) {
  const key = parseRoundKey(input.round);
  const at = String(input.at ?? "").trim() ? v.zonedToUtc(input.at, input.timeZone) : null;
  const shift = at ? 0 : v.intIn(input.shiftMinutes, -1440, 1440);
  if (!at && shift === 0) fail("invalid_input");
  if (at && key === "all") fail("invalid_input");
  return db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (!["IN_PROGRESS", "PAUSED"].includes(t.status)) fail("tournament_not_live");
    const matches = await openMatches(q, t.id, key);
    const before = await scheduleConflicts(q, t, matches.map((m) => m.id));
    let moved = 0;
    const ids: string[] = [];
    for (const m of matches) {
      const next = at ? at : m.scheduled_at ? new Date(new Date(m.scheduled_at).getTime() + shift * 60_000) : null;
      if (!next) continue;
      await q.query("update matches set scheduled_at = $2, updated_at = now() where id = $1", [m.id, next.toISOString()]);
      await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "match_scheduled", {
        matchId: m.id,
        tournament: t.name,
        at: next.toISOString(),
      });
      moved++;
      ids.push(m.id);
    }
    const conflicts = await guardConflicts(q, t, ids, v.bool(input.force), before);
    await audit(q, {
      actorId: user.id,
      action: "tournament.rescheduled",
      entity: "tournament",
      entityId: t.id,
      data: { round: key === "all" ? "all" : roundKeyOf(key), at: at?.toISOString() ?? null, shiftMinutes: at ? null : shift, moved, conflicts: summary(conflicts) },
    });
    return moved;
  });
}

export const VENUE_KINDS = ["stage", "station", "server", "table", "room", "other"] as const;
export const MAX_VENUES = 64;

export type Venue = { id: string; name: string; kind: string };

export async function venues(q: Queryable, tournamentId: string) {
  return q.query<Venue>("select id, name, kind from tournament_venues where tournament_id = $1 order by created_at, lower(name)", [tournamentId]);
}

export async function addVenue(db: Database, user: SessionUser, tournamentId: string, input: { name?: unknown; kind?: unknown }) {
  const name = v.oneLine(input.name, 60);
  if (name.length < 1) fail("invalid_input");
  const kind = String(input.kind ?? "station");
  if (!(VENUE_KINDS as readonly string[]).includes(kind)) fail("invalid_input");
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (["COMPLETED", "CANCELLED", "ARCHIVED"].includes(t.status)) fail("not_editable");
    const [count] = await q.query<{ n: number }>("select count(*)::int as n from tournament_venues where tournament_id = $1", [t.id]);
    if ((count?.n ?? 0) >= MAX_VENUES) fail("invalid_input");
    try {
      await q.query("insert into tournament_venues (tournament_id, name, kind) values ($1, $2, $3)", [t.id, name, kind]);
    } catch (error) {
      if (isUniqueViolation(error)) fail("venue_exists");
      throw error;
    }
    await audit(q, { actorId: user.id, action: "tournament.venue_added", entity: "tournament", entityId: t.id, data: { name, kind } });
  });
}

/** Removes a venue no open match is assigned to (finished matches keep the record that they had none). */
export async function removeVenue(db: Database, user: SessionUser, tournamentId: string, venueId: string) {
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    const [venue] = await q.query<Venue>("select id, name, kind from tournament_venues where id = $1 and tournament_id = $2", [venueId, t.id]);
    if (!venue) fail("not_found");
    const [busy] = await q.query("select 1 from matches where venue_id = $1 and status not in ('completed','cancelled') limit 1", [venue.id]);
    if (busy) fail("venue_in_use");
    await q.query("delete from tournament_venues where id = $1", [venue.id]);
    await audit(q, { actorId: user.id, action: "tournament.venue_removed", entity: "tournament", entityId: t.id, data: { name: venue.name } });
  });
}

type SlotRow = { id: string; tournament_id: string; scheduled_at: Date; minutes: number; venue_id: string | null; a_reg: string | null; b_reg: string | null; users: string[] };

const asSlot = (r: SlotRow): Slot => ({
  id: r.id,
  tournamentId: r.tournament_id,
  start: new Date(r.scheduled_at).getTime(),
  minutes: r.minutes,
  venue: r.venue_id,
  regs: [r.a_reg, r.b_reg].filter((x): x is string => Boolean(x)),
  users: r.users ?? [],
});

const SLOT_COLUMNS = `m.id, m.tournament_id, m.scheduled_at, coalesce(t.match_minutes, ${DEFAULT_MATCH_MINUTES})::int as minutes, m.venue_id, m.a_reg, m.b_reg,
  array(select re.user_id::text from roster_entries re where re.registration_id in (m.a_reg, m.b_reg)) as users`;

/** Conflicts of a tournament's timed open matches (or of `focusIds` among them), including players' other events. */
export async function scheduleConflicts(q: Queryable, t: { id: string }, focusIds?: string[]): Promise<Conflict[]> {
  const own = (
    await q.query<SlotRow>(
      `select ${SLOT_COLUMNS} from matches m join tournaments t on t.id = m.tournament_id
        where m.tournament_id = $1 and m.scheduled_at is not null and m.status not in ('completed','cancelled')`,
      [t.id],
    )
  ).map(asSlot);
  const focus = focusIds ? own.filter((s) => focusIds.includes(s.id)) : own;
  if (!focus.length) return [];
  const users = [...new Set(focus.flatMap((s) => s.users))];
  const others = users.length
    ? (
        await q.query<SlotRow>(
          `select ${SLOT_COLUMNS} from matches m join tournaments t on t.id = m.tournament_id
            where m.tournament_id <> $1 and m.scheduled_at is not null and m.status not in ('completed','cancelled')
              and t.status in ('IN_PROGRESS','PAUSED')
              and exists (select 1 from roster_entries re where re.registration_id in (m.a_reg, m.b_reg) and re.user_id::text = any($2))`,
          [t.id, users],
        )
      ).map(asSlot)
    : [];
  return findConflicts(focus, [...own, ...others]);
}

const conflictKey = (c: Conflict) => `${c.kind}:${c.a}:${c.b}:${c.venue ?? c.reg ?? c.user ?? ""}`;

/**
 * Refuses a change that creates new conflicts unless the organiser confirmed it; returns the new conflicts
 * accepted. Conflicts that existed before the change (`before`) do not block it — moving an already
 * overlapping pair together is not a new decision.
 */
export async function guardConflicts(q: Queryable, t: { id: string }, ids: string[], force: boolean, before: Conflict[] = []): Promise<Conflict[]> {
  if (!ids.length) return [];
  const known = new Set(before.map(conflictKey));
  const created = (await scheduleConflicts(q, t, ids)).filter((c) => !known.has(conflictKey(c)));
  if (created.length && !force) fail("schedule_conflict");
  return created;
}

const summary = (conflicts: Conflict[]) =>
  conflicts.length ? { version: SCHEDULE_VERSION, count: conflicts.length, kinds: [...new Set(conflicts.map((c) => c.kind))] } : null;

/**
 * Places the open matches of one round on the tournament's venues in waves: match i plays on venue i mod V,
 * wave ⌊i / V⌋ starts one match length after the previous one. Both sides are told where and when.
 */
export async function scheduleWaves(
  db: Database,
  user: SessionUser,
  tournamentId: string,
  input: { round: unknown; at?: unknown; timeZone?: unknown; force?: unknown },
) {
  const key = parseRoundKey(input.round);
  if (key === "all") fail("invalid_input");
  const at = v.zonedToUtc(input.at, input.timeZone);
  return db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (!["IN_PROGRESS", "PAUSED"].includes(t.status)) fail("tournament_not_live");
    const list = await venues(q, t.id);
    if (!list.length) fail("no_venues");
    const matches = await openMatches(q, t.id, key);
    const before = await scheduleConflicts(q, t, matches.map((m) => m.id));
    const minutes = t.match_minutes ?? DEFAULT_MATCH_MINUTES;
    const plan = planWaves(matches, list.map((x) => x.id), at.getTime(), minutes);
    const names = new Map(list.map((x) => [x.id, x.name]));
    for (const p of plan) {
      const when = new Date(p.start).toISOString();
      await q.query("update matches set scheduled_at = $2, venue_id = $3, updated_at = now() where id = $1", [p.match.id, when, p.venue]);
      await notify(q, [...(await regMembers(q, p.match.a_reg)), ...(await regMembers(q, p.match.b_reg))], "match_venue", {
        matchId: p.match.id,
        tournament: t.name,
        at: when,
        venue: names.get(p.venue) ?? "",
      });
    }
    const conflicts = await guardConflicts(q, t, plan.map((p) => p.match.id), v.bool(input.force), before);
    const waves = list.length ? Math.ceil(plan.length / list.length) : 0;
    await audit(q, {
      actorId: user.id,
      action: "tournament.waves_scheduled",
      entity: "tournament",
      entityId: t.id,
      data: { round: roundKeyOf(key as { stage: number; bracket: string; round: number }), at: at.toISOString(), venues: list.length, waves, matches: plan.length, minutes, conflicts: summary(conflicts) },
    });
    return { matches: plan.length, waves };
  });
}
