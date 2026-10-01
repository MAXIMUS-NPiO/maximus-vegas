/**
 * Round robin, Swiss and groups on the database: start, round progression, the playoff that may follow the
 * main stage, completion, placements, forfeits and corrections. The pure algorithms live in roundrobin.ts,
 * swiss.ts, standings.ts and stages.ts.
 *
 * Integrity rules:
 *  - Settings (points, draws, legs, rounds, groups, playoff, round dates) are frozen at the start and recorded
 *    in the audit log, so the tables are reproducible from the matches alone.
 *  - Every match action locks the tournament row first (see lockMatchWithTournament), so two results finishing
 *    a Swiss round pair the next round exactly once, and the last result of the main stage creates the playoff
 *    exactly once.
 *  - A correction never re-pairs rounds that were already published; it only changes the table.
 *  - The playoff is seeded from the final table of the main stage. It is not created while a dispute about a
 *    main-stage match is open, and once it exists the main-stage results are locked (stage_locked).
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "./db.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail } from "./errors.ts";
import { roundRobinSchedule, RR_MAX_ENTRANTS } from "./roundrobin.ts";
import { effectiveSwissRounds, pairKey, pairSwissRound, SWISS_VERSION } from "./swiss.ts";
import { annulledEntrants, computeStandings, STANDINGS_VERSION, type StandingsMatch, type StandingsRow } from "./standings.ts";
import { avoidSameGroup, combinePlaces, groupQualifiers, snakeGroups, STAGES_VERSION } from "./stages.ts";
import {
  bracketPlacements,
  buildBracket,
  completeMatch,
  completeTournament,
  notifyReady,
  regMembers,
  type MatchRow,
  type TournamentRow,
} from "./tournaments.ts";
import { grantXp, XP } from "./progression.ts";
import { isRoundFormat, roundTime, settingsOf, type FormatSettings } from "./format-settings.ts";

export { isRoundFormat, settingsOf, type FormatSettings };

type StartRow = { id: string; name: string; slug: string; format: string; format_settings: unknown; starts_at: Date };

async function rosterOf(q: Queryable, tournamentId: string) {
  const rows = await q.query<{ user_id: string }>(
    "select re.user_id from roster_entries re join registrations r on r.id = re.registration_id where re.tournament_id = $1 and r.status = 'registered'",
    [tournamentId],
  );
  return rows.map((r) => r.user_id);
}

/**
 * Inserts one round robin: the whole event, or one group (group_no ≥ 1). Rounds are dated by the interval.
 * Positions are unique per round across all groups (`next` carries the next free position of each round),
 * so the slot key (tournament, bracket, round, position) holds for groups too.
 */
async function insertRoundRobin(q: Queryable, t: StartRow, participants: Array<{ id: string }>, groupNo = 0, next = new Map<number, number>()) {
  if (participants.length > RR_MAX_ENTRANTS) fail("round_robin_limit");
  const settings = settingsOf(t);
  const schedule = roundRobinSchedule(participants.map((p) => p.id), settings.legs ?? 1);
  for (const m of schedule.matches) {
    const position = next.get(m.round) ?? 0;
    next.set(m.round, position + 1);
    await q.query(
      `insert into matches (id, tournament_id, bracket, round, position, a_reg, b_reg, status, scheduled_at, group_no)
       values ($1,$2,'RR',$3,$4,$5,$6,'ready',$7,$8)`,
      [randomUUID(), t.id, m.round, position, m.a, m.b, roundTime(t.starts_at, m.round, settings.roundHours ?? 0), groupNo],
    );
  }
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

/**
 * Deals the seeded entrants into groups (snake) and creates each group's round robin. Every group needs at
 * least two entrants and at least as many as advance from it.
 */
async function insertGroups(q: Queryable, t: StartRow, participants: Array<{ id: string }>) {
  const settings = settingsOf(t);
  const { count, advance } = settings.groups ?? { count: 2, advance: 1 };
  if (participants.length < count * Math.max(2, advance)) fail("stage_too_few");
  const groups = snakeGroups(participants, count);
  if (groups.some((g) => g.length > RR_MAX_ENTRANTS)) fail("round_robin_limit");
  let rounds = 0;
  let matches = 0;
  const next = new Map<number, number>();
  for (let g = 0; g < groups.length; g++) {
    for (const p of groups[g]) await q.query("update registrations set group_no = $2 where id = $1", [p.id, g + 1]);
    const { schedule } = await insertRoundRobin(q, t, groups[g], g + 1, next);
    rounds = Math.max(rounds, schedule.rounds);
    matches += schedule.matches.length;
  }
  return { settings, sizes: groups.map((g) => g.length), rounds, matches };
}

export async function startGroups(q: Queryable, t: StartRow, participants: Array<{ id: string }>, actorId: string) {
  const { settings, sizes, rounds, matches } = await insertGroups(q, t, participants);
  await q.query("update tournaments set started_at = now(), check_in_open = false where id = $1", [t.id]);
  await notify(q, await rosterOf(q, t.id), "tournament_started", { tournament: t.name, slug: t.slug });
  await audit(q, {
    actorId,
    action: "tournament.groups_started",
    entity: "tournament",
    entityId: t.id,
    data: { entrants: participants.length, groups: sizes.length, sizes, rounds, matches, version: STAGES_VERSION, settings: { ...settings } },
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
 * Rebuilds the schedule (round robin), the groups or round 1 (Swiss) for a regenerated event. The caller has
 * already checked that no result exists and removed the old matches.
 */
export async function regenerateRounds(q: Queryable, t: StartRow, participants: Array<{ id: string }>, actorId: string) {
  if (t.format === "round_robin") {
    const { schedule } = await insertRoundRobin(q, t, participants);
    return { rounds: schedule.rounds, matches: schedule.matches.length };
  }
  if (t.format === "groups") {
    await q.query("update registrations set group_no = null where tournament_id = $1", [t.id]);
    const { sizes, rounds, matches } = await insertGroups(q, t, participants);
    return { groups: sizes.length, sizes, rounds, matches };
  }
  const { frozen, rounds } = await freezeSwiss(q, t, participants.length);
  await pairSwiss(q, { ...t, format_settings: frozen }, 1, actorId);
  return { rounds, matches: Math.floor(participants.length / 2) };
}

type RoundMatch = {
  id: string;
  round: number;
  group_no: number;
  a_reg: string | null;
  b_reg: string | null;
  winner_reg: string | null;
  score_a: number | null;
  score_b: number | null;
  outcome: string | null;
  status: string;
};
type Entrant = { id: string; seed: number | null; status: string; group_no: number | null };

async function entrantsOf(q: Queryable, tournamentId: string) {
  // Entrants of a started event are exactly the registrations that appear in its main-stage matches.
  return q.query<Entrant>(
    `select r.id, r.seed, r.status, r.group_no from registrations r
      where r.tournament_id = $1 and r.status in ('registered','disqualified')
        and exists (select 1 from matches m where m.tournament_id = r.tournament_id and m.stage = 1 and (m.a_reg = r.id or m.b_reg = r.id))
      order by r.seed asc nulls last, r.created_at asc, r.id asc`,
    [tournamentId],
  );
}

const roundMatches = (q: Queryable, tournamentId: string) =>
  q.query<RoundMatch>(
    `select id, round, group_no, a_reg, b_reg, winner_reg, score_a, score_b, outcome, status from matches
      where tournament_id = $1 and stage = 1 and bracket in ('RR','SW') order by group_no, round, position`,
    [tournamentId],
  );

const asEntrant = (e: Entrant, i: number) => ({ id: e.id, seed: e.seed ?? 1000 + i, disqualified: e.status === "disqualified" });
const asResult = (m: RoundMatch): StandingsMatch => ({
  a: m.a_reg,
  b: m.b_reg,
  winner: m.winner_reg,
  scoreA: m.score_a,
  scoreB: m.score_b,
  outcome: m.outcome,
  status: m.status,
});

/** Live standings of a round-robin or Swiss tournament (groups: see groupStandings). */
export async function roundStandings(q: Queryable, t: { id: string; format: string; format_settings?: unknown }): Promise<StandingsRow[]> {
  if (t.format !== "round_robin" && t.format !== "swiss") return [];
  const [entrants, matches] = await Promise.all([entrantsOf(q, t.id), roundMatches(q, t.id)]);
  const settings = settingsOf(t);
  return computeStandings(t.format, entrants.map(asEntrant), matches.map(asResult), settings.points, { disqualification: settings.disqualification });
}

export type GroupTable = { group: number; rows: StandingsRow[] };

/** Live standings of every group: each group is a round robin with the tournament's points and rules. */
export async function groupStandings(q: Queryable, t: { id: string; format: string; format_settings?: unknown }): Promise<GroupTable[]> {
  if (t.format !== "groups") return [];
  const [entrants, matches] = await Promise.all([entrantsOf(q, t.id), roundMatches(q, t.id)]);
  const settings = settingsOf(t);
  const numbers = [...new Set(entrants.map((e) => e.group_no).filter((g): g is number => g !== null))].sort((a, b) => a - b);
  return numbers.map((group) => ({
    group,
    rows: computeStandings(
      "round_robin",
      entrants.filter((e) => e.group_no === group).map(asEntrant),
      matches.filter((m) => m.group_no === group).map(asResult),
      settings.points,
      { disqualification: settings.disqualification },
    ),
  }));
}

/** Pairs Swiss round `round`. Returns false when fewer than two active entrants remain. */
async function pairSwiss(q: Queryable, t: StartRow, round: number, actorId: string): Promise<boolean> {
  const settings = settingsOf(t);
  const [entrants, matches] = await Promise.all([
    round === 1
      ? q.query<Entrant>(
          "select id, seed, status, group_no from registrations where tournament_id = $1 and status = 'registered' order by seed asc nulls last, created_at asc, id asc",
          [t.id],
        )
      : entrantsOf(q, t.id),
    roundMatches(q, t.id),
  ]);
  const active = entrants.filter((e) => e.status === "registered");
  if (active.length < 2) return false;
  const table = round === 1 ? [] : computeStandings("swiss", entrants.map(asEntrant), matches.map(asResult), settings.points);
  const pointsOf = new Map(table.map((r) => [r.id, r.points]));
  const byesOf = new Map(table.map((r) => [r.id, r.byes]));
  const met = new Set(matches.filter((m) => m.a_reg && m.b_reg).map((m) => pairKey(m.a_reg!, m.b_reg!)));
  const pairing = pairSwissRound(
    active.map((e, i) => ({ id: e.id, seed: e.seed ?? 1000 + i, points: pointsOf.get(e.id) ?? 0, byes: byesOf.get(e.id) ?? 0 })),
    (a, b) => met.has(pairKey(a, b)),
  );
  let position = 0;
  const [meta] = await q.query<{ name: string }>("select name from tournaments where id = $1", [t.id]);
  const at = roundTime(t.starts_at, round, settings.roundHours ?? 0);
  for (const [a, b] of pairing.pairs) {
    const id = randomUUID();
    await q.query(
      `insert into matches (id, tournament_id, bracket, round, position, a_reg, b_reg, status, scheduled_at)
       values ($1,$2,'SW',$3,$4,$5,$6,'ready',$7)`,
      [id, t.id, round, position++, a, b, at],
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

/**
 * Called after every completed main-stage match (inside the same transaction) and after a decided dispute
 * about one: pairs the next Swiss round, or ends the main stage — completing the tournament or starting its
 * playoff. Playoff matches advance through the bracket instead.
 */
export async function afterRoundMatch(q: Queryable, tournamentId: string, actorId: string) {
  const [t] = await q.query<TournamentRow>("select * from tournaments where id = $1", [tournamentId]);
  if (!t || !isRoundFormat(t.format) || !["IN_PROGRESS", "PAUSED"].includes(t.status) || t.stage !== 1) return;
  if (t.format !== "swiss") {
    const [open] = await q.query<{ n: number }>(
      "select count(*)::int as n from matches where tournament_id = $1 and stage = 1 and status not in ('completed','cancelled')",
      [t.id],
    );
    if ((open?.n ?? 0) === 0) await finishMainStage(q, t, actorId);
    return;
  }
  const [state] = await q.query<{ round: number; open: number }>(
    `select coalesce(max(round), 0)::int as round,
            count(*) filter (where status not in ('completed','cancelled') and round = (select max(round) from matches where tournament_id = $1 and stage = 1))::int as open
       from matches where tournament_id = $1 and stage = 1`,
    [t.id],
  );
  if ((state?.open ?? 0) > 0) return;
  const rounds = settingsOf(t).rounds ?? 1;
  if (state.round >= rounds || !(await pairSwiss(q, t, state.round + 1, actorId))) await finishMainStage(q, t, actorId);
}

async function finishMainStage(q: Queryable, t: TournamentRow, actorId: string) {
  if (!settingsOf(t).playoff) {
    await completeTournament(q, t.id);
    return;
  }
  // The main stage is locked once the playoff exists, so the playoff waits for every open dispute about it.
  const [open] = await q.query<{ n: number }>(
    "select count(*)::int as n from disputes d join matches m on m.id = d.match_id where m.tournament_id = $1 and m.stage = 1 and d.status = 'open'",
    [t.id],
  );
  if ((open?.n ?? 0) > 0) return;
  await startPlayoff(q, t, actorId, null);
}

type Qualified = { id: string; group: number | null; rank: number };

/** The playoff field in seed order, from the final table of the main stage. */
async function playoffField(q: Queryable, t: TournamentRow): Promise<{ field: Qualified[]; clashes: number }> {
  const settings = settingsOf(t);
  const playoff = settings.playoff!;
  if (t.format === "groups") {
    const tables = await groupStandings(q, t);
    const list = groupQualifiers(new Map(tables.map((g) => [g.group, g.rows])), settings.groups?.advance ?? 1);
    // A gauntlet has no first-round pairs to keep apart: the seeds go straight in.
    const { seeded, clashes } = playoff.format === "gauntlet" ? { seeded: list, clashes: 0 } : avoidSameGroup(list);
    return { field: seeded.map((x) => ({ id: x.id, group: x.group, rank: x.groupRank })), clashes };
  }
  const table = await roundStandings(q, t);
  const field = table
    .filter((r) => r.rank !== null)
    .slice(0, playoff.size)
    .map((r) => ({ id: r.id, group: null, rank: r.rank! }));
  return { field, clashes: 0 };
}

/**
 * Starts the playoff: records the field (seed, group and main-stage rank of each qualifier), builds the bracket
 * and moves the tournament to stage 2. With fewer than two qualifiers left (disqualifications) there is no
 * playoff and the main stage decides the places. `previous` is the field before a regeneration (null at the
 * first start): only newly qualified entrants are notified again.
 */
export async function startPlayoff(q: Queryable, t: TournamentRow, actorId: string, previous: Set<string> | null) {
  const settings = settingsOf(t);
  const playoff = settings.playoff!;
  const { field, clashes } = await playoffField(q, t);
  await q.query("update tournaments set stage = 2, updated_at = now() where id = $1", [t.id]);
  const entry = { format: playoff.format, size: playoff.size, version: STAGES_VERSION };
  if (field.length < 2) {
    await audit(q, { actorId, action: "tournament.playoff_skipped", entity: "tournament", entityId: t.id, data: { ...entry, qualifiers: field.length } });
    await completeTournament(q, t.id);
    return field;
  }
  for (let i = 0; i < field.length; i++)
    await q.query("insert into stage_entries (tournament_id, stage, registration_id, seed, group_no, source_rank) values ($1, 2, $2, $3, $4, $5)", [
      t.id,
      field[i].id,
      i + 1,
      field[i].group,
      field[i].rank,
    ]);
  const hours = settings.roundHours ?? 0;
  const [last] = await q.query<{ round: number }>("select coalesce(max(round), 0)::int as round from matches where tournament_id = $1 and stage = 1", [t.id]);
  // With round dates the playoff takes the slot after the last main-stage round; it never starts in the past.
  const planned = hours > 0 ? new Date(t.starts_at).getTime() + (last?.round ?? 0) * hours * 3_600_000 : 0;
  const firstRoundAt = new Date(Math.max(Date.now(), planned)).toISOString();
  await buildBracket(q, { ...t, stage: 2 }, field.map((x) => x.id), actorId, { format: playoff.format, stage: 2, firstRoundAt, roundHours: hours });
  const qualified = new Set(field.map((x) => x.id));
  for (const x of field)
    if (!previous?.has(x.id)) await notify(q, await regMembers(q, x.id), "playoff_qualified", { tournament: t.name, slug: t.slug });
  if (!previous) {
    const others = await q.query<{ id: string }>("select id from registrations where tournament_id = $1 and status = 'registered'", [t.id]);
    for (const r of others.filter((r) => !qualified.has(r.id))) await notify(q, await regMembers(q, r.id), "stage_finished", { tournament: t.name, slug: t.slug });
  }
  await audit(q, {
    actorId,
    action: previous ? "tournament.playoff_regenerated" : "tournament.playoff_started",
    entity: "tournament",
    entityId: t.id,
    data: { ...entry, clashes, firstRoundAt, field: field.map((x, i) => ({ registrationId: x.id, seed: i + 1, group: x.group, rank: x.rank })) },
  });
  await notifyReady(q, t);
  return field;
}

/**
 * Rebuilds the playoff from the main-stage table (for example after a qualifier was disqualified before playing).
 * The caller has checked that no playoff result, dispute or live match exists.
 */
export async function regeneratePlayoff(q: Queryable, t: TournamentRow, actorId: string) {
  const before = await q.query<{ registration_id: string }>("select registration_id from stage_entries where tournament_id = $1 and stage = 2", [t.id]);
  await q.query("update matches set next_match_id = null, loser_next_match_id = null where tournament_id = $1 and stage = 2", [t.id]);
  await q.query("delete from matches where tournament_id = $1 and stage = 2", [t.id]);
  await q.query("delete from stage_entries where tournament_id = $1 and stage = 2", [t.id]);
  await q.query("update registrations set placement = null where tournament_id = $1", [t.id]);
  await q.query("update tournaments set stage = 1 where id = $1", [t.id]);
  const field = await startPlayoff(q, { ...t, stage: 1 }, actorId, new Set(before.map((r) => r.registration_id)));
  return { stage: 2, playoff: field.length };
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
 * Final places of a tournament with a playoff: the playoff ranks its field; everyone else follows by the main
 * stage — after groups, entrants with the same group rank share a place; after a round robin or Swiss, by
 * table rank. Without a playoff (fewer than two qualifiers) the main stage alone decides. Returns false while
 * the main stage or the playoff is still being played.
 */
export async function stagedPlacements(q: Queryable, tournamentId: string): Promise<boolean> {
  const [t] = await q.query<TournamentRow>("select * from tournaments where id = $1", [tournamentId]);
  if (!t || !isRoundFormat(t.format)) return false;
  await q.query("update registrations set placement = null where tournament_id = $1", [t.id]);
  if (t.stage !== 2) return false;
  const [entries, matches] = await Promise.all([
    q.query<{ registration_id: string }>("select registration_id from stage_entries where tournament_id = $1 and stage = 2", [t.id]),
    q.query<MatchRow>("select * from matches where tournament_id = $1 and stage = 2 order by bracket, round, position", [t.id]),
  ]);
  let playoff = new Map<string, number>();
  if (matches.length) {
    const places = bracketPlacements(settingsOf(t).playoff?.format ?? "single_elimination", matches);
    if (!places) return false;
    playoff = places;
  }
  const field = new Set(entries.map((e) => e.registration_id));
  const rest: Array<{ id: string; key: number }> = [];
  const tables = t.format === "groups" ? (await groupStandings(q, t)).map((g) => g.rows) : [await roundStandings(q, t)];
  for (const rows of tables) for (const r of rows) if (r.rank !== null && !field.has(r.id)) rest.push({ id: r.id, key: r.rank });
  for (const [reg, place] of combinePlaces(playoff, rest, field.size)) await q.query("update registrations set placement = $2 where id = $1", [reg, place]);
  await q.query("update registrations set placement = null where tournament_id = $1 and status = 'disqualified'", [t.id]);
  return true;
}

/**
 * Open matches of a disqualified entrant during the main stage. Swiss: the current match is forfeited and the
 * entrant is no longer paired. Round robin and groups, by the tournament's rule: "forfeit" completes every
 * remaining match for the opponent; "annul" cancels them and the table ignores all of the entrant's matches;
 * "half" annuls when fewer than half of the entrant's matches had been played, otherwise forfeits.
 */
export async function forfeitOpenMatches(q: Queryable, tournamentId: string, regId: string, actorId: string) {
  const [t] = await q.query<{ id: string; format: string; format_settings: unknown }>("select id, format, format_settings from tournaments where id = $1", [tournamentId]);
  const open = await q.query<MatchRow>(
    `select * from matches where tournament_id = $1 and stage = 1 and (a_reg = $2 or b_reg = $2)
       and status in ('pending','ready','in_progress','result_submitted','disputed') order by round, position for update`,
    [tournamentId, regId],
  );
  if (t && (t.format === "round_robin" || t.format === "groups")) {
    const all = await roundMatches(q, tournamentId);
    const annul = annulledEntrants([{ id: regId, seed: 0, disqualified: true }], all.map(asResult), settingsOf(t).disqualification ?? "forfeit").has(regId);
    if (annul) {
      for (const m of open) {
        await q.query("update match_results set status = 'superseded' where match_id = $1 and status = 'pending'", [m.id]);
        await q.query("update matches set status = 'cancelled', outcome = 'disqualification', updated_at = now() where id = $1", [m.id]);
      }
      await audit(q, { actorId, action: "tournament.results_annulled", entity: "tournament", entityId: tournamentId, data: { registrationId: regId, cancelled: open.length } });
      await afterRoundMatch(q, tournamentId, actorId);
      return;
    }
  }
  for (const m of open) {
    const [fresh] = await q.query<MatchRow>("select * from matches where id = $1", [m.id]);
    if (!fresh || fresh.status === "completed" || fresh.status === "cancelled") continue;
    const winner = fresh.a_reg === regId ? fresh.b_reg! : fresh.a_reg!;
    await q.query("update match_results set status = 'superseded' where match_id = $1 and status = 'pending'", [m.id]);
    await completeMatch(q, fresh, { winner, scoreA: null, scoreB: null, outcome: "disqualification" }, actorId);
  }
}

/**
 * Corrects or overturns a decided main-stage match. No bracket to rewrite: the table changes, published
 * pairings stay. A completed tournament re-settles its places and the champion award (which pays a new
 * champion without clawing anything back). Locked once the playoff has started.
 */
export async function rewriteRoundResult(
  q: Queryable,
  m: MatchRow,
  result: { winner: string | null; scoreA: number | null; scoreB: number | null; outcome: "played" | "decision" },
) {
  if (m.status !== "completed" || m.outcome === "bye" || !m.a_reg || !m.b_reg) fail("not_editable");
  if (result.winner !== null && result.winner !== m.a_reg && result.winner !== m.b_reg) fail("invalid_input");
  const [t] = await q.query<{ game: string; status: string; stage: number }>("select game, status, stage from tournaments where id = $1", [m.tournament_id]);
  if ((m.stage ?? 1) === 1 && t?.stage === 2) fail("stage_locked");
  await q.query("update matches set winner_reg = $2, score_a = $3, score_b = $4, outcome = $5, updated_at = now() where id = $1", [
    m.id,
    result.winner,
    result.scoreA,
    result.scoreB,
    result.outcome,
  ]);
  if (result.winner && result.winner !== m.winner_reg)
    await grantXp(q, await regMembers(q, result.winner), XP.matchWin, "match_win", t?.game ?? "", m.id, `match:${m.id}:win`);
  if (t?.status === "COMPLETED") await completeTournament(q, m.tournament_id);
}
