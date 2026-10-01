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
 *  - Chains (MV-STAGES-2): further round stages (round robin, Swiss or groups) may follow the main stage
 *    before the playoff. Each is seeded from the final table of the stage before it, the same way, and
 *    locks that stage once it exists. Stage numbers: 1 is the main stage, then the chain, the playoff last.
 */
import { randomUUID } from "node:crypto";
import type { Queryable } from "./db.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail } from "./errors.ts";
import { roundRobinSchedule, RR_MAX_ENTRANTS } from "./roundrobin.ts";
import { effectiveSwissRounds, pairKey, pairSwissRound, SWISS_VERSION } from "./swiss.ts";
import { annulledEntrants, computeStandings, STANDINGS_VERSION, type StandingsMatch, type StandingsRow } from "./standings.ts";
import { avoidSameGroup, CHAIN_VERSION, combinePlaces, groupQualifiers, snakeGroups, STAGES_VERSION } from "./stages.ts";
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
import { isRoundFormat, playoffStage, roundTime, settingsOf, stageSpec, type FormatSettings, type RoundFormat } from "./format-settings.ts";
import { pointsOf, seriesRulesOf, type SeriesRules } from "./series.ts";

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
async function insertRoundRobin(
  q: Queryable,
  t: StartRow,
  participants: Array<{ id: string }>,
  groupNo = 0,
  next = new Map<number, number>(),
  stage: { stage: number; legs: 1 | 2; at: (round: number) => string | null } | null = null,
) {
  if (participants.length > RR_MAX_ENTRANTS) fail("round_robin_limit");
  const settings = settingsOf(t);
  const schedule = roundRobinSchedule(participants.map((p) => p.id), stage?.legs ?? settings.legs ?? 1);
  for (const m of schedule.matches) {
    const position = next.get(m.round) ?? 0;
    next.set(m.round, position + 1);
    await q.query(
      `insert into matches (id, tournament_id, stage, bracket, round, position, a_reg, b_reg, status, scheduled_at, group_no)
       values ($1,$2,$3,'RR',$4,$5,$6,$7,'ready',$8,$9)`,
      [randomUUID(), t.id, stage?.stage ?? 1, m.round, position, m.a, m.b, stage ? stage.at(m.round) : roundTime(t.starts_at, m.round, settings.roundHours ?? 0), groupNo],
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
  await pairSwiss(q, { ...t, format_settings: frozen }, 1, 1, actorId);
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
  await pairSwiss(q, { ...t, format_settings: frozen }, 1, 1, actorId);
  return { rounds, matches: Math.floor(participants.length / 2) };
}

/**
 * Next free position of every round of a bracket code across the whole event. The slot key (tournament,
 * bracket, round, position) predates chains and is kept so earlier code keeps working: a chained stage
 * numbers its matches after those of the earlier stages in the same round.
 */
async function nextPositions(q: Queryable, tournamentId: string, bracket: "RR" | "SW") {
  const rows = await q.query<{ round: number; next: number }>(
    "select round, (max(position) + 1)::int as next from matches where tournament_id = $1 and bracket = $2 group by round",
    [tournamentId, bracket],
  );
  return new Map(rows.map((r) => [r.round, r.next]));
}

type RoundMatch = {
  id: string;
  stage: number;
  round: number;
  group_no: number;
  a_reg: string | null;
  b_reg: string | null;
  winner_reg: string | null;
  score_a: number | null;
  score_b: number | null;
  outcome: string | null;
  status: string;
  points_override: unknown;
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

/**
 * Entrants of a round stage. The main stage: the registrations in its matches (group from the registration).
 * A chained stage: its stage entries in seed order (group from the stage's own matches).
 */
async function stageEntrants(q: Queryable, tournamentId: string, stage: number): Promise<Entrant[]> {
  if (stage === 1) return entrantsOf(q, tournamentId);
  return q.query<Entrant>(
    `select r.id, se.seed, r.status,
            (select m.group_no from matches m where m.tournament_id = se.tournament_id and m.stage = se.stage and (m.a_reg = r.id or m.b_reg = r.id) limit 1) as group_no
       from stage_entries se join registrations r on r.id = se.registration_id
      where se.tournament_id = $1 and se.stage = $2 and r.status in ('registered','disqualified')
      order by se.seed`,
    [tournamentId, stage],
  );
}

const roundMatches = (q: Queryable, tournamentId: string, stage = 1) =>
  q.query<RoundMatch>(
    `select id, stage, round, group_no, a_reg, b_reg, winner_reg, score_a, score_b, outcome, status, points_override from matches
      where tournament_id = $1 and stage = $2 and bracket in ('RR','SW') order by group_no, round, position`,
    [tournamentId, stage],
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

type WithRules = { id: string; format: string; format_settings?: unknown; series_rules?: unknown };

/** The tournament's series rules; read from the database when the caller's row does not carry them. */
async function rulesOf(q: Queryable, t: WithRules): Promise<SeriesRules> {
  if ("series_rules" in t) return seriesRulesOf(t);
  const [row] = await q.query<{ series_rules: unknown }>("select series_rules from tournaments where id = $1", [t.id]);
  return seriesRulesOf(row ?? {});
}

/** Results with the points of each match: a match, its round or its group may override the tournament's table. */
function asResults(rules: SeriesRules, settings: FormatSettings, matches: RoundMatch[]): StandingsMatch[] {
  const custom = rules.rounds.some((r) => r.points) || rules.groups.some((g) => g.points) || matches.some((m) => m.points_override);
  return matches.map((m) => (custom ? { ...asResult(m), points: pointsOf(rules, settings.points, m).points } : asResult(m)));
}

export type GroupTable = { group: number; rows: StandingsRow[] };

/** The format played at a round stage of the tournament (null for the playoff or past the end). */
export function roundFormatAt(t: { format: string; format_settings?: unknown }, stage: number): RoundFormat | null {
  if (!isRoundFormat(t.format)) return null;
  const spec = stageSpec(settingsOf(t), t.format, stage);
  return spec?.kind === "round" ? spec.format : null;
}

/**
 * Live tables of a round stage: one per group for groups (group numbers from 1), otherwise a single table
 * (group 0). Every stage uses the tournament's points, draws and disqualification rule.
 */
export async function stageTables(q: Queryable, t: WithRules, stage: number): Promise<{ format: RoundFormat; tables: GroupTable[] } | null> {
  const format = roundFormatAt(t, stage);
  if (!format) return null;
  const [entrants, all, rules] = await Promise.all([stageEntrants(q, t.id, stage), roundMatches(q, t.id, stage), rulesOf(q, t)]);
  const settings = settingsOf(t);
  const results = asResults(rules, settings, all);
  const opts = { disqualification: settings.disqualification };
  if (format !== "groups") return { format, tables: [{ group: 0, rows: computeStandings(format, entrants.map(asEntrant), results, settings.points, opts) }] };
  const matches = all.map((m, i) => ({ group_no: m.group_no, result: results[i] }));
  const numbers = [...new Set(entrants.map((e) => e.group_no).filter((g): g is number => g !== null && g > 0))].sort((a, b) => a - b);
  return {
    format,
    tables: numbers.map((group) => ({
      group,
      rows: computeStandings(
        "round_robin",
        entrants.filter((e) => e.group_no === group).map(asEntrant),
        matches.filter((m) => m.group_no === group).map((m) => m.result),
        settings.points,
        opts,
      ),
    })),
  };
}

/** Live standings of a round-robin or Swiss main stage (groups: see groupStandings). */
export async function roundStandings(q: Queryable, t: WithRules): Promise<StandingsRow[]> {
  if (t.format !== "round_robin" && t.format !== "swiss") return [];
  return (await stageTables(q, t, 1))?.tables[0]?.rows ?? [];
}

/** Live standings of every group of a groups main stage: each group is a round robin with the tournament's points and rules. */
export async function groupStandings(q: Queryable, t: WithRules): Promise<GroupTable[]> {
  if (t.format !== "groups") return [];
  return (await stageTables(q, t, 1))?.tables ?? [];
}

/**
 * When round `round` of a stage is scheduled. The main stage: from the start by the interval. A later stage
 * starts in the slot after the rounds of the stages before it, never in the past, and keeps that first slot.
 */
async function stageClock(q: Queryable, t: StartRow, stage: number): Promise<(round: number) => string | null> {
  const hours = settingsOf(t).roundHours ?? 0;
  if (stage === 1) return (round) => roundTime(t.starts_at, round, hours);
  const [first] = await q.query<{ at: Date | null }>(
    "select min(scheduled_at) as at from matches where tournament_id = $1 and stage = $2 and round = 1",
    [t.id, stage],
  );
  let start: number;
  if (first?.at) start = new Date(first.at).getTime();
  else {
    const [prev] = await q.query<{ rounds: number }>(
      "select coalesce(sum(r), 0)::int as rounds from (select max(round) as r from matches where tournament_id = $1 and stage < $2 group by stage) x",
      [t.id, stage],
    );
    const planned = hours > 0 ? new Date(t.starts_at).getTime() + (prev?.rounds ?? 0) * hours * 3_600_000 : 0;
    start = Math.max(Date.now(), planned);
  }
  return (round) => (hours > 0 ? new Date(start + (round - 1) * hours * 3_600_000).toISOString() : round === 1 ? new Date(start).toISOString() : null);
}

/** Pairs Swiss round `round` of a stage. Returns false when fewer than two active entrants remain. */
async function pairSwiss(q: Queryable, t: StartRow, stage: number, round: number, actorId: string): Promise<boolean> {
  const settings = settingsOf(t);
  const [entrants, matches, rules] = await Promise.all([
    round === 1 && stage === 1
      ? q.query<Entrant>(
          "select id, seed, status, group_no from registrations where tournament_id = $1 and status = 'registered' order by seed asc nulls last, created_at asc, id asc",
          [t.id],
        )
      : stageEntrants(q, t.id, stage),
    roundMatches(q, t.id, stage),
    rulesOf(q, t),
  ]);
  const active = entrants.filter((e) => e.status === "registered");
  if (active.length < 2) return false;
  const table = round === 1 ? [] : computeStandings("swiss", entrants.map(asEntrant), asResults(rules, settings, matches), settings.points);
  const pointsOf = new Map(table.map((r) => [r.id, r.points]));
  const byesOf = new Map(table.map((r) => [r.id, r.byes]));
  const met = new Set(matches.filter((m) => m.a_reg && m.b_reg).map((m) => pairKey(m.a_reg!, m.b_reg!)));
  const pairing = pairSwissRound(
    active.map((e, i) => ({ id: e.id, seed: e.seed ?? 1000 + i, points: pointsOf.get(e.id) ?? 0, byes: byesOf.get(e.id) ?? 0 })),
    (a, b) => met.has(pairKey(a, b)),
  );
  let position = stage > 1 ? ((await nextPositions(q, t.id, "SW")).get(round) ?? 0) : 0;
  const [meta] = await q.query<{ name: string }>("select name from tournaments where id = $1", [t.id]);
  const at = (await stageClock(q, t, stage))(round);
  for (const [a, b] of pairing.pairs) {
    const id = randomUUID();
    await q.query(
      `insert into matches (id, tournament_id, stage, bracket, round, position, a_reg, b_reg, status, scheduled_at)
       values ($1,$2,$3,'SW',$4,$5,$6,$7,'ready',$8)`,
      [id, t.id, stage, round, position++, a, b, at],
    );
    await notify(q, [...(await regMembers(q, a)), ...(await regMembers(q, b))], "match_ready", { matchId: id, tournament: meta?.name ?? t.name });
  }
  if (pairing.bye) {
    await q.query(
      `insert into matches (id, tournament_id, stage, bracket, round, position, a_reg, b_reg, b_void, winner_reg, status, outcome, completed_at)
       values ($1,$2,$3,'SW',$4,$5,$6,null,true,$6,'completed','bye',now())`,
      [randomUUID(), t.id, stage, round, position, pairing.bye],
    );
    await notify(q, await regMembers(q, pairing.bye), "swiss_bye", { tournament: meta?.name ?? t.name, slug: t.slug, round: String(round) });
  }
  await audit(q, {
    actorId,
    action: "tournament.swiss_round_paired",
    entity: "tournament",
    entityId: t.id,
    data: { ...(stage > 1 ? { stage } : {}), round, pairs: pairing.pairs.length, bye: pairing.bye, rematches: pairing.rematches },
  });
  return true;
}

/**
 * Called after every completed round-stage match (inside the same transaction) and after a decided dispute
 * about one: pairs the next Swiss round of the current stage, or ends the stage — starting the next stage,
 * the playoff, or completing the tournament. Playoff matches advance through the bracket instead.
 */
export async function afterRoundMatch(q: Queryable, tournamentId: string, actorId: string) {
  const [t] = await q.query<TournamentRow>("select * from tournaments where id = $1", [tournamentId]);
  if (!t || !isRoundFormat(t.format) || !["IN_PROGRESS", "PAUSED"].includes(t.status)) return;
  const stage = t.stage ?? 1;
  const format = roundFormatAt(t, stage);
  if (!format) return;
  if (format !== "swiss") {
    const [open] = await q.query<{ n: number }>(
      "select count(*)::int as n from matches where tournament_id = $1 and stage = $2 and status not in ('completed','cancelled')",
      [t.id, stage],
    );
    if ((open?.n ?? 0) === 0) await finishStage(q, t, stage, actorId);
    return;
  }
  const [state] = await q.query<{ round: number; open: number }>(
    `select coalesce(max(round), 0)::int as round,
            count(*) filter (where status not in ('completed','cancelled') and round = (select max(round) from matches where tournament_id = $1 and stage = $2))::int as open
       from matches where tournament_id = $1 and stage = $2`,
    [t.id, stage],
  );
  if ((state?.open ?? 0) > 0) return;
  const settings = settingsOf(t);
  const rounds = (stage === 1 ? settings.rounds : settings.chain?.[stage - 2]?.rounds) ?? 1;
  if (state.round >= rounds || !(await pairSwiss(q, t, stage, state.round + 1, actorId))) await finishStage(q, t, stage, actorId);
}

/** A finished round stage starts the next stage or the playoff, or completes the tournament when nothing follows. */
async function finishStage(q: Queryable, t: TournamentRow, stage: number, actorId: string) {
  const next = stageSpec(settingsOf(t), t.format as RoundFormat, stage + 1);
  if (!next) {
    await completeTournament(q, t.id);
    return;
  }
  // A stage is locked once the next exists, so the next waits for every open dispute about this one.
  const [open] = await q.query<{ n: number }>(
    "select count(*)::int as n from disputes d join matches m on m.id = d.match_id where m.tournament_id = $1 and m.stage = $2 and d.status = 'open'",
    [t.id, stage],
  );
  if ((open?.n ?? 0) > 0) return;
  if (next.kind === "round") await startRoundStage(q, t, stage + 1, actorId, null);
  else await startPlayoff(q, t, actorId, null);
}

type Qualified = { id: string; group: number | null; rank: number };

/**
 * Who goes on from a round stage, in seed order for the next stage: from groups, every group's top
 * `advance` (winners first, ordered across groups); otherwise the top `take` of the table. Group-mates are
 * kept apart in the first round of an elimination bracket when `apart` is set.
 */
async function qualifiersFrom(q: Queryable, t: TournamentRow, stage: number, take: number, apart: boolean): Promise<{ field: Qualified[]; clashes: number }> {
  const data = await stageTables(q, t, stage);
  if (!data) return { field: [], clashes: 0 };
  if (data.format === "groups") {
    const settings = settingsOf(t);
    const advance = (stage === 1 ? settings.groups?.advance : settings.chain?.[stage - 2]?.groups?.advance) ?? 1;
    const list = groupQualifiers(new Map(data.tables.map((g) => [g.group, g.rows])), advance);
    const { seeded, clashes } = apart ? avoidSameGroup(list) : { seeded: list, clashes: 0 };
    return { field: seeded.map((x) => ({ id: x.id, group: x.group, rank: x.groupRank })), clashes };
  }
  const table = data.tables[0]?.rows ?? [];
  return { field: table.filter((r) => r.rank !== null).slice(0, take).map((r) => ({ id: r.id, group: null, rank: r.rank! })), clashes: 0 };
}

/**
 * Registered entrants of a stage who did not go on: told that their part of the event is over ("stage_finished"
 * after a main stage followed by the playoff, as before chains existed; "stage_out" after any other stage).
 */
async function notifyOut(q: Queryable, t: TournamentRow, stage: number, field: Qualified[], kind: "stage_finished" | "stage_out") {
  const went = new Set(field.map((x) => x.id));
  for (const e of await stageEntrants(q, t.id, stage))
    if (e.status === "registered" && !went.has(e.id)) await notify(q, await regMembers(q, e.id), kind, { tournament: t.name, slug: t.slug });
}

/**
 * Starts a chained round stage (MV-STAGES-2): records the field from the final table of the stage before
 * (seed, source group and rank), moves the tournament to it and creates its matches — a round robin, groups
 * dealt in a snake by the new seeds (fewer groups when the field is too small), or Swiss round 1. With fewer
 * than two qualifiers the stage is skipped and the event completes. `previous` is the field before a
 * regeneration (null at the first start): only newly qualified entrants are notified again.
 */
async function startRoundStage(q: Queryable, t: TournamentRow, stage: number, actorId: string, previous: Set<string> | null): Promise<Qualified[]> {
  const settings = settingsOf(t);
  const spec = settings.chain![stage - 2];
  const { field } = await qualifiersFrom(q, t, stage - 1, spec.size, false);
  await q.query("update tournaments set stage = $2, updated_at = now() where id = $1", [t.id, stage]);
  const entry = { stage, format: spec.format, size: spec.size, version: CHAIN_VERSION };
  if (field.length < 2) {
    await audit(q, { actorId, action: "tournament.stage_skipped", entity: "tournament", entityId: t.id, data: { ...entry, qualifiers: field.length } });
    await completeTournament(q, t.id);
    return field;
  }
  for (let i = 0; i < field.length; i++)
    await q.query("insert into stage_entries (tournament_id, stage, registration_id, seed, group_no, source_rank) values ($1, $2, $3, $4, $5, $6)", [
      t.id,
      stage,
      field[i].id,
      i + 1,
      field[i].group,
      field[i].rank,
    ]);
  const ids = field.map((x) => ({ id: x.id }));
  const clock = await stageClock(q, t, stage);
  let summary: Record<string, unknown> = {};
  if (spec.format === "swiss") {
    const requested = spec.requestedRounds !== undefined ? spec.requestedRounds : (spec.rounds ?? null);
    const rounds = effectiveSwissRounds(field.length, requested);
    const chain = settings.chain!.map((c, i) => (i === stage - 2 ? { ...c, rounds, requestedRounds: requested } : c));
    const frozen: FormatSettings = { ...settings, chain };
    await q.query("update tournaments set format_settings = $2 where id = $1", [t.id, JSON.stringify(frozen)]);
    await pairSwiss(q, { ...t, format_settings: frozen }, stage, 1, actorId);
    summary = { rounds, requestedRounds: requested };
  } else if (spec.format === "round_robin") {
    const { schedule } = await insertRoundRobin(q, t, ids, 0, await nextPositions(q, t.id, "RR"), { stage, legs: spec.legs ?? 1, at: clock });
    summary = { rounds: schedule.rounds, matches: schedule.matches.length };
  } else {
    const { count, advance } = spec.groups!;
    // Too small a field plays fewer groups, each still at least two entrants and as many as advance.
    const groupsCount = Math.max(1, Math.min(count, Math.floor(field.length / Math.max(2, advance))));
    const groups = snakeGroups(ids, groupsCount);
    if (groups.some((g) => g.length > RR_MAX_ENTRANTS)) fail("round_robin_limit");
    const next = await nextPositions(q, t.id, "RR");
    let rounds = 0;
    let matches = 0;
    for (let g = 0; g < groups.length; g++) {
      const { schedule } = await insertRoundRobin(q, t, groups[g], g + 1, next, { stage, legs: spec.legs ?? 1, at: clock });
      rounds = Math.max(rounds, schedule.rounds);
      matches += schedule.matches.length;
    }
    summary = { groups: groups.length, sizes: groups.map((g) => g.length), rounds, matches };
  }
  // Swiss pairings notify their players; a round robin or groups start with every first-round match ready.
  if (spec.format !== "swiss") await notifyReady(q, t);
  for (const x of field) if (!previous?.has(x.id)) await notify(q, await regMembers(q, x.id), "stage_qualified", { tournament: t.name, slug: t.slug });
  if (!previous) await notifyOut(q, t, stage - 1, field, "stage_out");
  await audit(q, {
    actorId,
    action: previous ? "tournament.stage_regenerated" : "tournament.stage_started",
    entity: "tournament",
    entityId: t.id,
    data: { ...entry, ...summary, field: field.map((x, i) => ({ registrationId: x.id, seed: i + 1, group: x.group, rank: x.rank })) },
  });
  return field;
}

/**
 * Starts the playoff: records the field (seed, group and rank of each qualifier in the stage before it),
 * builds the bracket and moves the tournament to the playoff stage (2 after the main stage alone, later after
 * a chain). With fewer than two qualifiers left (disqualifications) there is no playoff and the round stages
 * decide the places. `previous` is the field before a regeneration (null at the first start): only newly
 * qualified entrants are notified again.
 */
export async function startPlayoff(q: Queryable, t: TournamentRow, actorId: string, previous: Set<string> | null) {
  const settings = settingsOf(t);
  const playoff = settings.playoff!;
  const stage = playoffStage(settings);
  const { field, clashes } = await qualifiersFrom(q, t, stage - 1, playoff.size, playoff.format !== "gauntlet");
  await q.query("update tournaments set stage = $2, updated_at = now() where id = $1", [t.id, stage]);
  const entry = { format: playoff.format, size: playoff.size, version: settings.chain?.length ? CHAIN_VERSION : STAGES_VERSION };
  if (field.length < 2) {
    await audit(q, { actorId, action: "tournament.playoff_skipped", entity: "tournament", entityId: t.id, data: { ...entry, qualifiers: field.length } });
    await completeTournament(q, t.id);
    return field;
  }
  for (let i = 0; i < field.length; i++)
    await q.query("insert into stage_entries (tournament_id, stage, registration_id, seed, group_no, source_rank) values ($1, $2, $3, $4, $5, $6)", [
      t.id,
      stage,
      field[i].id,
      i + 1,
      field[i].group,
      field[i].rank,
    ]);
  const hours = settings.roundHours ?? 0;
  const [last] = await q.query<{ round: number }>(
    "select coalesce(sum(r), 0)::int as round from (select max(round) as r from matches where tournament_id = $1 and stage < $2 group by stage) x",
    [t.id, stage],
  );
  // With round dates the playoff takes the slot after the last round of the stages before it; it never starts in the past.
  const planned = hours > 0 ? new Date(t.starts_at).getTime() + (last?.round ?? 0) * hours * 3_600_000 : 0;
  const firstRoundAt = new Date(Math.max(Date.now(), planned)).toISOString();
  await buildBracket(q, { ...t, stage }, field.map((x) => x.id), actorId, { format: playoff.format, stage, firstRoundAt, roundHours: hours });
  for (const x of field)
    if (!previous?.has(x.id)) await notify(q, await regMembers(q, x.id), "playoff_qualified", { tournament: t.name, slug: t.slug });
  if (!previous) await notifyOut(q, t, stage - 1, field, stage === 2 ? "stage_finished" : "stage_out");
  await audit(q, {
    actorId,
    action: previous ? "tournament.playoff_regenerated" : "tournament.playoff_started",
    entity: "tournament",
    entityId: t.id,
    data: { ...entry, ...(stage > 2 ? { stage } : {}), clashes, firstRoundAt, field: field.map((x, i) => ({ registrationId: x.id, seed: i + 1, group: x.group, rank: x.rank })) },
  });
  await notifyReady(q, t);
  return field;
}

/**
 * Rebuilds the current stage (a chained round stage or the playoff) from the final table of the stage before
 * it — for example after a qualifier was disqualified before playing. The caller has checked that no result,
 * dispute or live match of that stage exists.
 */
export async function regenerateStage(q: Queryable, t: TournamentRow, actorId: string) {
  const stage = t.stage;
  const spec = stageSpec(settingsOf(t), t.format as RoundFormat, stage);
  if (stage < 2 || !spec) fail("regeneration_blocked");
  const before = await q.query<{ registration_id: string }>("select registration_id from stage_entries where tournament_id = $1 and stage = $2", [t.id, stage]);
  await q.query("update matches set next_match_id = null, loser_next_match_id = null where tournament_id = $1 and stage >= $2", [t.id, stage]);
  await q.query("delete from matches where tournament_id = $1 and stage >= $2", [t.id, stage]);
  await q.query("delete from stage_entries where tournament_id = $1 and stage >= $2", [t.id, stage]);
  await q.query("update registrations set placement = null where tournament_id = $1", [t.id]);
  await q.query("update tournaments set stage = $2 where id = $1", [t.id, stage - 1]);
  const previous = new Set(before.map((r) => r.registration_id));
  const field = spec!.kind === "playoff" ? await startPlayoff(q, { ...t, stage: stage - 1 }, actorId, previous) : await startRoundStage(q, { ...t, stage: stage - 1 }, stage, actorId, previous);
  return { stage, ...(spec!.kind === "playoff" ? { playoff: field.length } : { field: field.length }) };
}

/** The playoff rebuilt from the table of the stage before it (see regenerateStage). */
export const regeneratePlayoff = (q: Queryable, t: TournamentRow, actorId: string) => regenerateStage(q, t, actorId);

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
 * Final places of a tournament played in stages: the playoff ranks its field; everyone else follows by the
 * stage where they stopped, latest stage first — after groups, entrants with the same group rank share a
 * place; after a round robin or Swiss, by table rank. A stage skipped for lack of qualifiers (or a missing
 * playoff) leaves the places to the stages before it. Returns false while the event is still being played.
 */
export async function stagedPlacements(q: Queryable, tournamentId: string): Promise<boolean> {
  const [t] = await q.query<TournamentRow>("select * from tournaments where id = $1", [tournamentId]);
  if (!t || !isRoundFormat(t.format)) return false;
  await q.query("update registrations set placement = null where tournament_id = $1", [t.id]);
  const settings = settingsOf(t);
  const top = t.stage ?? 1;
  // A stage reached without entrants was skipped (fewer than two qualifiers): the event ended there.
  const [entered] = top >= 2 ? await q.query<{ n: number }>("select count(*)::int as n from stage_entries where tournament_id = $1 and stage = $2", [t.id, top]) : [];
  const skipped = top >= 2 && (entered?.n ?? 0) === 0;
  // While a further stage is still to come, nothing is final.
  if (!skipped && stageSpec(settings, t.format, top + 1) && t.status !== "COMPLETED") return false;
  let placed = new Map<string, number>();
  let above = new Set<string>();
  let base = 0;
  let from = top;
  if (stageSpec(settings, t.format, top)?.kind === "playoff") {
    const [entries, matches] = await Promise.all([
      q.query<{ registration_id: string }>("select registration_id from stage_entries where tournament_id = $1 and stage = $2", [t.id, top]),
      q.query<MatchRow>("select * from matches where tournament_id = $1 and stage = $2 order by bracket, round, position", [t.id, top]),
    ]);
    if (matches.length) {
      const places = bracketPlacements(settings.playoff?.format ?? "single_elimination", matches);
      if (!places) return false;
      placed = places;
    }
    above = new Set(entries.map((e) => e.registration_id));
    base = above.size;
    from = top - 1;
  }
  for (let stage = from; stage >= 1; stage--) {
    if (stage === top) {
      const [open] = await q.query<{ n: number }>(
        "select count(*)::int as n from matches where tournament_id = $1 and stage = $2 and status not in ('completed','cancelled')",
        [t.id, stage],
      );
      if ((open?.n ?? 0) > 0) return false;
    }
    const data = await stageTables(q, t, stage);
    if (!data) continue;
    const rest: Array<{ id: string; key: number }> = [];
    for (const table of data.tables) for (const r of table.rows) if (r.rank !== null && !above.has(r.id) && !placed.has(r.id)) rest.push({ id: r.id, key: r.rank });
    placed = combinePlaces(placed, rest, base);
    // Whoever played this stage ranks above everyone who stopped earlier, disqualified entrants included.
    above = new Set([...above, ...data.tables.flatMap((g) => g.rows.map((r) => r.id))]);
    base = above.size;
  }
  for (const [reg, place] of placed) await q.query("update registrations set placement = $2 where id = $1", [reg, place]);
  await q.query("update registrations set placement = null where tournament_id = $1 and status = 'disqualified'", [t.id]);
  return true;
}

/**
 * Open matches of a disqualified entrant in the current round stage. Swiss: the current match is forfeited and the
 * entrant is no longer paired. Round robin and groups, by the tournament's rule: "forfeit" completes every
 * remaining match for the opponent; "annul" cancels them and the table ignores all of the entrant's matches;
 * "half" annuls when fewer than half of the entrant's matches had been played, otherwise forfeits.
 */
export async function forfeitOpenMatches(q: Queryable, tournamentId: string, regId: string, actorId: string) {
  const [t] = await q.query<{ id: string; format: string; format_settings: unknown; stage: number }>(
    "select id, format, format_settings, stage from tournaments where id = $1",
    [tournamentId],
  );
  const stage = t?.stage ?? 1;
  const format = t ? roundFormatAt(t, stage) : null;
  const open = await q.query<MatchRow>(
    `select * from matches where tournament_id = $1 and stage = $3 and (a_reg = $2 or b_reg = $2)
       and status in ('pending','ready','in_progress','result_submitted','disputed') order by round, position for update`,
    [tournamentId, regId, stage],
  );
  if (t && (format === "round_robin" || format === "groups")) {
    const all = await roundMatches(q, tournamentId, stage);
    const annul = annulledEntrants([{ id: regId, seed: 0, disqualified: true }], all.map(asResult), settingsOf(t).disqualification ?? "forfeit").has(regId);
    if (annul) {
      for (const m of open) {
        await q.query("update match_results set status = 'superseded' where match_id = $1 and status = 'pending'", [m.id]);
        await q.query("update matches set status = 'cancelled', outcome = 'disqualification', updated_at = now() where id = $1", [m.id]);
      }
      await audit(q, { actorId, action: "tournament.results_annulled", entity: "tournament", entityId: tournamentId, data: { registrationId: regId, cancelled: open.length, ...(stage > 1 ? { stage } : {}) } });
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
  // A stage is final once the next stage exists.
  if ((m.stage ?? 1) < (t?.stage ?? 1)) fail("stage_locked");
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
