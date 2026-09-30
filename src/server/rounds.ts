/**
 * Round robin and Swiss on the database: start, round progression, completion, placements, forfeits
 * and corrections. The pure algorithms live in roundrobin.ts, swiss.ts and standings.ts.
 *
 * Integrity rules:
 *  - Settings (points, draws, legs, rounds) are frozen at the start and recorded in the audit log, so
 *    the table is reproducible from the matches alone.
 *  - Every match action locks the tournament row first (see lockMatchWithTournament), so two results
 *    finishing a Swiss round at the same moment pair the next round exactly once.
 *  - A correction never re-pairs rounds that were already published; it only changes the table.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "./db.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail } from "./errors.ts";
import { roundRobinSchedule, RR_MAX_ENTRANTS } from "./roundrobin.ts";
import { effectiveSwissRounds, pairKey, pairSwissRound, SWISS_VERSION } from "./swiss.ts";
import { computeStandings, STANDINGS_VERSION, type StandingsRow } from "./standings.ts";
import { completeMatch, completeTournament, regMembers, type MatchRow } from "./tournaments.ts";
import { grantXp, XP } from "./progression.ts";
import { isRoundFormat, settingsOf, type FormatSettings } from "./format-settings.ts";

export { isRoundFormat, settingsOf, type FormatSettings };

type StartRow = { id: string; name: string; slug: string; format: string; format_settings: unknown; starts_at: Date };

async function rosterOf(q: Queryable, tournamentId: string) {
  const rows = await q.query<{ user_id: string }>(
    "select re.user_id from roster_entries re join registrations r on r.id = re.registration_id where re.tournament_id = $1 and r.status = 'registered'",
    [tournamentId],
  );
  return rows.map((r) => r.user_id);
}

async function insertRoundRobin(q: Queryable, t: StartRow, participants: Array<{ id: string }>) {
  if (participants.length > RR_MAX_ENTRANTS) fail("round_robin_limit");
  const settings = settingsOf(t);
  const schedule = roundRobinSchedule(participants.map((p) => p.id), settings.legs ?? 1);
  for (const m of schedule.matches)
    await q.query(
      `insert into matches (id, tournament_id, bracket, round, position, a_reg, b_reg, status, scheduled_at)
       values ($1,$2,'RR',$3,$4,$5,$6,'ready',$7)`,
      [randomUUID(), t.id, m.round, m.position, m.a, m.b, m.round === 1 ? new Date(t.starts_at).toISOString() : null],
    );
  return { settings, schedule };
}

export async function startRoundRobin(q: Queryable, t: StartRow, participants: Array<{ id: string }>, actorId: string) {
  const { settings, schedule } = await insertRoundRobin(q, t, participants);
  await q.query("update tournaments set started_at = now(), check_in_open = false where id = $1", [t.id]);
  await notify(q, await rosterOf(q, t.id), "tournament_started", { tournament: t.name, slug: t.slug });
  await audit(q, {
    actorId,
    action: "tournament.round_robin_started",
    entity: "tournament",
    entityId: t.id,
    data: { entrants: participants.length, rounds: schedule.rounds, matches: schedule.matches.length, settings: { ...settings } },
  });
}

/** Freezes the Swiss settings for this field: the rounds actually played and the algorithm versions. */
async function freezeSwiss(q: Queryable, t: StartRow, entrants: number) {
  const settings = settingsOf(t);
  const requested = settings.requestedRounds !== undefined ? settings.requestedRounds : (settings.rounds ?? null);
  const rounds = effectiveSwissRounds(entrants, requested);
  const frozen: FormatSettings = { ...settings, rounds, requestedRounds: requested, pairing: SWISS_VERSION, standings: STANDINGS_VERSION };
  await q.query("update tournaments set format_settings = $2 where id = $1", [t.id, JSON.stringify(frozen)]);
  return { frozen, requested, rounds };
}

export async function startSwiss(q: Queryable, t: StartRow, participants: Array<{ id: string }>, actorId: string) {
  const { frozen, requested, rounds } = await freezeSwiss(q, t, participants.length);
  await q.query("update tournaments set started_at = now(), check_in_open = false where id = $1", [t.id]);
  await audit(q, {
    actorId,
    action: "tournament.swiss_started",
    entity: "tournament",
    entityId: t.id,
    data: { entrants: participants.length, requestedRounds: requested, rounds, settings: { ...frozen } },
  });
  await notify(q, await rosterOf(q, t.id), "tournament_started", { tournament: t.name, slug: t.slug });
  await pairSwiss(q, { ...t, format_settings: frozen }, 1, actorId);
}

/**
 * Rebuilds the schedule (round robin) or round 1 (Swiss) for a regenerated event. The caller has already
 * checked that no result exists and removed the old matches.
 */
export async function regenerateRounds(q: Queryable, t: StartRow, participants: Array<{ id: string }>, actorId: string) {
  if (t.format === "round_robin") {
    const { schedule } = await insertRoundRobin(q, t, participants);
    return { rounds: schedule.rounds, matches: schedule.matches.length };
  }
  const { frozen, rounds } = await freezeSwiss(q, t, participants.length);
  await pairSwiss(q, { ...t, format_settings: frozen }, 1, actorId);
  return { rounds, matches: Math.floor(participants.length / 2) };
}

type RoundMatch = { id: string; round: number; a_reg: string | null; b_reg: string | null; winner_reg: string | null; score_a: number | null; score_b: number | null; outcome: string | null; status: string };

async function entrantsOf(q: Queryable, tournamentId: string) {
  // Entrants of a started event are exactly the registrations that appear in its matches.
  return q.query<{ id: string; seed: number | null; status: string }>(
    `select r.id, r.seed, r.status from registrations r
      where r.tournament_id = $1 and r.status in ('registered','disqualified')
        and exists (select 1 from matches m where m.tournament_id = r.tournament_id and (m.a_reg = r.id or m.b_reg = r.id))
      order by r.seed asc nulls last, r.created_at asc, r.id asc`,
    [tournamentId],
  );
}

const roundMatches = (q: Queryable, tournamentId: string) =>
  q.query<RoundMatch>(
    "select id, round, a_reg, b_reg, winner_reg, score_a, score_b, outcome, status from matches where tournament_id = $1 and bracket in ('RR','SW') order by round, position",
    [tournamentId],
  );

/** Live standings of a round-robin or Swiss tournament. */
export async function roundStandings(q: Queryable, t: { id: string; format: string; format_settings?: unknown }): Promise<StandingsRow[]> {
  if (!isRoundFormat(t.format)) return [];
  const [entrants, matches] = await Promise.all([entrantsOf(q, t.id), roundMatches(q, t.id)]);
  return computeStandings(
    t.format,
    entrants.map((e, i) => ({ id: e.id, seed: e.seed ?? 1000 + i, disqualified: e.status === "disqualified" })),
    matches.map((m) => ({ a: m.a_reg, b: m.b_reg, winner: m.winner_reg, scoreA: m.score_a, scoreB: m.score_b, outcome: m.outcome, status: m.status })),
    settingsOf(t).points,
  );
}

/** Pairs Swiss round `round`. Returns false when fewer than two active entrants remain. */
async function pairSwiss(q: Queryable, t: StartRow, round: number, actorId: string): Promise<boolean> {
  const settings = settingsOf(t);
  const [entrants, matches] = await Promise.all([
    round === 1
      ? q.query<{ id: string; seed: number | null; status: string }>(
          "select id, seed, status from registrations where tournament_id = $1 and status = 'registered' order by seed asc nulls last, created_at asc, id asc",
          [t.id],
        )
      : entrantsOf(q, t.id),
    roundMatches(q, t.id),
  ]);
  const active = entrants.filter((e) => e.status === "registered");
  if (active.length < 2) return false;
  const table =
    round === 1
      ? []
      : computeStandings(
          "swiss",
          entrants.map((e, i) => ({ id: e.id, seed: e.seed ?? 1000 + i, disqualified: e.status === "disqualified" })),
          matches.map((m) => ({ a: m.a_reg, b: m.b_reg, winner: m.winner_reg, scoreA: m.score_a, scoreB: m.score_b, outcome: m.outcome, status: m.status })),
          settings.points,
        );
  const pointsOf = new Map(table.map((r) => [r.id, r.points]));
  const byesOf = new Map(table.map((r) => [r.id, r.byes]));
  const met = new Set(matches.filter((m) => m.a_reg && m.b_reg).map((m) => pairKey(m.a_reg!, m.b_reg!)));
  const pairing = pairSwissRound(
    active.map((e, i) => ({ id: e.id, seed: e.seed ?? 1000 + i, points: pointsOf.get(e.id) ?? 0, byes: byesOf.get(e.id) ?? 0 })),
    (a, b) => met.has(pairKey(a, b)),
  );
  let position = 0;
  const [meta] = await q.query<{ name: string }>("select name from tournaments where id = $1", [t.id]);
  for (const [a, b] of pairing.pairs) {
    const id = randomUUID();
    await q.query(
      `insert into matches (id, tournament_id, bracket, round, position, a_reg, b_reg, status, scheduled_at)
       values ($1,$2,'SW',$3,$4,$5,$6,'ready',$7)`,
      [id, t.id, round, position++, a, b, round === 1 ? new Date(t.starts_at).toISOString() : null],
    );
    await notify(q, [...(await regMembers(q, a)), ...(await regMembers(q, b))], "match_ready", { matchId: id, tournament: meta?.name ?? t.name });
  }
  if (pairing.bye) {
    await q.query(
      `insert into matches (id, tournament_id, bracket, round, position, a_reg, b_reg, b_void, winner_reg, status, outcome, completed_at)
       values ($1,$2,'SW',$3,$4,$5,null,true,$5,'completed','bye',now())`,
      [randomUUID(), t.id, round, position, pairing.bye],
    );
    await notify(q, await regMembers(q, pairing.bye), "swiss_bye", { tournament: meta?.name ?? t.name, slug: t.slug, round: String(round) });
  }
  await audit(q, {
    actorId,
    action: "tournament.swiss_round_paired",
    entity: "tournament",
    entityId: t.id,
    data: { round, pairs: pairing.pairs.length, bye: pairing.bye, rematches: pairing.rematches },
  });
  return true;
}

/** Called after every completed round-robin or Swiss match (inside the same transaction). */
export async function afterRoundMatch(q: Queryable, tournamentId: string, actorId: string) {
  const [t] = await q.query<StartRow & { status: string }>(
    "select id, name, slug, format, format_settings, starts_at, status from tournaments where id = $1",
    [tournamentId],
  );
  if (!t || !isRoundFormat(t.format) || t.status === "COMPLETED") return;
  if (t.format === "round_robin") {
    const [open] = await q.query<{ n: number }>(
      "select count(*)::int as n from matches where tournament_id = $1 and status not in ('completed','cancelled')",
      [t.id],
    );
    if ((open?.n ?? 0) === 0) await completeTournament(q, t.id);
    return;
  }
  const [state] = await q.query<{ round: number; open: number }>(
    `select coalesce(max(round), 0)::int as round,
            count(*) filter (where status not in ('completed','cancelled') and round = (select max(round) from matches where tournament_id = $1))::int as open
       from matches where tournament_id = $1`,
    [t.id],
  );
  if ((state?.open ?? 0) > 0) return;
  const rounds = settingsOf(t).rounds ?? 1;
  if (state.round >= rounds || !(await pairSwiss(q, t, state.round + 1, actorId))) await completeTournament(q, t.id);
}

/** Final places from the table, once every scheduled match is decided. Returns false while in progress. */
export async function roundPlacements(q: Queryable, tournamentId: string): Promise<boolean> {
  const [t] = await q.query<{ id: string; format: string; format_settings: unknown }>("select id, format, format_settings from tournaments where id = $1", [tournamentId]);
  if (!t || !isRoundFormat(t.format)) return false;
  const [state] = await q.query<{ round: number; open: number; active: number }>(
    `select coalesce((select max(round) from matches where tournament_id = $1), 0)::int as round,
            (select count(*)::int from matches where tournament_id = $1 and status not in ('completed','cancelled')) as open,
            (select count(*)::int from registrations where tournament_id = $1 and status = 'registered') as active`,
    [t.id],
  );
  const finished =
    (state?.open ?? 0) === 0 && (t.format === "round_robin" || state.round >= (settingsOf(t).rounds ?? 1) || state.active < 2);
  await q.query("update registrations set placement = null where tournament_id = $1", [t.id]);
  if (!finished) return false;
  for (const row of await roundStandings(q, t))
    if (row.rank !== null) await q.query("update registrations set placement = $2 where id = $1", [row.id, row.rank]);
  return true;
}

/**
 * A disqualified entrant forfeits every open match: all remaining round-robin matches, or the current
 * Swiss match. Results already played stand; a Swiss entrant is no longer paired.
 */
export async function forfeitOpenMatches(q: Queryable, tournamentId: string, regId: string, actorId: string) {
  const open = await q.query<MatchRow>(
    `select * from matches where tournament_id = $1 and (a_reg = $2 or b_reg = $2)
       and status in ('pending','ready','in_progress','result_submitted','disputed') order by round, position for update`,
    [tournamentId, regId],
  );
  for (const m of open) {
    const [fresh] = await q.query<MatchRow>("select * from matches where id = $1", [m.id]);
    if (!fresh || fresh.status === "completed" || fresh.status === "cancelled") continue;
    const winner = fresh.a_reg === regId ? fresh.b_reg! : fresh.a_reg!;
    await q.query("update match_results set status = 'superseded' where match_id = $1 and status = 'pending'", [m.id]);
    await completeMatch(q, fresh, { winner, scoreA: null, scoreB: null, outcome: "disqualification" }, actorId);
  }
}

/**
 * Corrects or overturns a decided round-robin or Swiss match. No bracket to rewrite: the table changes,
 * published pairings stay. A completed tournament re-settles its places and the champion award (which
 * pays a new champion without clawing anything back).
 */
export async function rewriteRoundResult(
  q: Queryable,
  m: MatchRow,
  result: { winner: string | null; scoreA: number | null; scoreB: number | null; outcome: "played" | "decision" },
) {
  if (m.status !== "completed" || m.outcome === "bye" || !m.a_reg || !m.b_reg) fail("not_editable");
  if (result.winner !== null && result.winner !== m.a_reg && result.winner !== m.b_reg) fail("invalid_input");
  await q.query("update matches set winner_reg = $2, score_a = $3, score_b = $4, outcome = $5, updated_at = now() where id = $1", [
    m.id,
    result.winner,
    result.scoreA,
    result.scoreB,
    result.outcome,
  ]);
  const [t] = await q.query<{ game: string; status: string }>("select game, status from tournaments where id = $1", [m.tournament_id]);
  if (result.winner && result.winner !== m.winner_reg)
    await grantXp(q, await regMembers(q, result.winner), XP.matchWin, "match_win", t?.game ?? "", m.id, `match:${m.id}:win`);
  if (t?.status === "COMPLETED") await completeTournament(q, m.tournament_id);
}
