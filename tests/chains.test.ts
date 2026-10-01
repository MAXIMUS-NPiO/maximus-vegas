/**
 * Chains of stages (MV-STAGES-2): round stages after the main stage and before the playoff, each seeded from the
 * final table of the stage before it and locking that stage once it exists; places follow the stages.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { cloneTournament, computePlacements, createTournament, disqualify, regenerateMatches, register, transition, type TournamentInput } from "../src/server/tournaments.ts";
import { correctResult, officialResult } from "../src/server/matches.ts";
import { stageTables } from "../src/server/rounds.ts";
import { editableSettings, parseFormatSettings } from "../src/server/format-settings.ts";
import { getTournament, tournamentHistory } from "../src/server/queries.ts";
import { standingsFor } from "../src/server/partner-api.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
let seq = 0;
let owner: SessionUser;
let orgId: string;

async function mk(name: string): Promise<SessionUser> {
  const s = await signUp(db, { email: `${name}@example.com`, username: name, displayName: name.toUpperCase(), password: "correct horse battery", adult: "on", terms: "on" });
  return (await sessionUser(db, s.token))!;
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}

function throws(fn: () => unknown, code: string) {
  assert.throws(fn, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}

const START = "2030-01-01T12:00";
const base = (over: Partial<TournamentInput> = {}): TournamentInput => ({
  name: `Chain ${++seq}`,
  game: "cs2",
  participantType: "solo",
  teamSize: 1,
  maxParticipants: 32,
  checkInRequired: "",
  region: "",
  startsAt: START,
  timeZone: "UTC",
  description: "",
  rules: "",
  ...over,
});

type M = {
  id: string;
  bracket: string;
  stage: number;
  group_no: number;
  round: number;
  position: number;
  a_reg: string | null;
  b_reg: string | null;
  winner_reg: string | null;
  status: string;
  outcome: string | null;
  scheduled_at: Date | null;
};
type T = { id: string; slug: string; status: string; format: string; stage: number; format_settings: Record<string, unknown> };
type R = { id: string; user_id: string; status: string; placement: number | null; seed: number | null };

const matchesOf = (tid: string) => db.query<M>("select * from matches where tournament_id = $1 order by stage, group_no, bracket, round, position", [tid]);
const tournamentRow = async (tid: string) => (await db.query<T>("select id, slug, status, format, stage, format_settings from tournaments where id = $1", [tid]))[0];
const regsOf = (tid: string) => db.query<R>("select id, user_id, status, placement, seed from registrations where tournament_id = $1 order by seed", [tid]);
const entriesAt = (tid: string, stage: number) =>
  db.query<{ registration_id: string; seed: number; group_no: number | null; source_rank: number }>(
    "select registration_id, seed, group_no, source_rank from stage_entries where tournament_id = $1 and stage = $2 order by seed",
    [tid, stage],
  );
const auditCount = async (tid: string, action: string) =>
  (await db.query<{ n: number }>("select count(*)::int as n from audit_log where entity_id = $1 and action = $2", [tid, action]))[0].n;

/** Stage notifications of a tournament, by kind. */
async function notes(slug: string) {
  const [row] = await db.query<{ stage_qualified: number; stage_out: number; playoff_qualified: number; stage_finished: number }>(
    `select count(*) filter (where kind = 'stage_qualified')::int as stage_qualified, count(*) filter (where kind = 'stage_out')::int as stage_out,
            count(*) filter (where kind = 'playoff_qualified')::int as playoff_qualified, count(*) filter (where kind = 'stage_finished')::int as stage_finished
       from notifications where data->>'slug' = $1`,
    [slug],
  );
  return row;
}

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  owner = await mk("chainsowner");
  orgId = (await createOrg(db, owner, { name: "Chains League", description: "" })).id;
});
test.after(async () => {
  await db.close();
});

async function setup(n: number, over: Partial<TournamentInput> = {}) {
  const t = await createTournament(db, owner, orgId, base(over));
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  for (let i = 0; i < n; i++) await register(db, await mk(`c${seq}_${i}`), t.id);
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  return t;
}

/** The better registration seed wins every match. */
async function favourite(tid: string) {
  const seeds = new Map((await regsOf(tid)).map((r) => [r.id, r.seed ?? 999]));
  return (m: M) => (seeds.get(m.a_reg!)! < seeds.get(m.b_reg!)! ? "a" : "b");
}

const decide = (m: M, side: "a" | "b") => officialResult(db, owner, m.id, { scoreA: side === "a" ? 2 : 0, scoreB: side === "a" ? 0 : 2, evidenceUrl: "", note: "" });

/** Decides ready matches until nothing is ready, or until `stop` says so. */
async function playOut(tid: string, pick: (m: M) => "a" | "b", stop?: (all: M[]) => boolean) {
  for (let guard = 0; guard < 2000; guard++) {
    const all = await matchesOf(tid);
    if (stop?.(all)) return;
    const ready = all.filter((m) => m.status === "ready");
    if (!ready.length) return;
    await decide(ready[0], pick(ready[0]));
  }
  assert.fail("did not finish");
}

test("swiss → groups → playoff: each stage is seeded from the final table before it and locks it; places and history survive a reload", async () => {
  const t = await setup(16, {
    format: "swiss",
    maxParticipants: 16,
    settings: { swissRounds: "3", stage2Format: "groups", stage2Size: "8", stage2GroupCount: "2", stage2GroupAdvance: "2", playoffFormat: "single_elimination" },
  });
  const created = await tournamentRow(t.id);
  assert.deepEqual(created.format_settings.chain, [{ format: "groups", size: 8, groups: { count: 2, advance: 2 }, legs: 1 }]);
  assert.deepEqual(created.format_settings.playoff, { format: "single_elimination", size: 4 }, "after groups the playoff is groups × advancing");
  assert.equal(created.format_settings.stages, "MV-STAGES-2");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const pick = await favourite(t.id);

  // Stage 1 → 2: the last Swiss result starts the groups with the top eight of the table, in table order.
  await playOut(t.id, pick, (all) => all.some((m) => m.stage === 2));
  const s2 = await tournamentRow(t.id);
  assert.equal(s2.stage, 2);
  assert.ok((await matchesOf(t.id)).filter((m) => m.stage === 1).every((m) => m.status === "completed"));
  const swiss = (await stageTables(db, s2, 1))!.tables[0].rows;
  const field2 = await entriesAt(t.id, 2);
  assert.deepEqual(
    field2.map((e) => [e.registration_id, e.source_rank, e.group_no]),
    swiss.slice(0, 8).map((r) => [r.id, r.rank, null]),
  );
  const stage2 = (await matchesOf(t.id)).filter((m) => m.stage === 2);
  assert.equal(stage2.length, 12, "two groups of four");
  assert.ok(stage2.every((m) => m.bracket === "RR" && m.status === "ready" && [1, 2].includes(m.group_no)));
  const groupOf = new Map<string, number>();
  for (const m of stage2) for (const r of [m.a_reg!, m.b_reg!]) groupOf.set(r, m.group_no);
  assert.deepEqual(field2.map((e) => groupOf.get(e.registration_id)), [1, 2, 2, 1, 1, 2, 2, 1], "a snake by the new seeds");
  const swissMatch = (await matchesOf(t.id)).find((m) => m.stage === 1 && m.outcome !== "bye")!;
  await rejects(correctResult(db, owner, swissMatch.id, { scoreA: 0, scoreB: 2, evidenceUrl: "", note: "Late correction" }), "stage_locked");
  assert.deepEqual(await notes(t.slug), { stage_qualified: 8, stage_out: 8, playoff_qualified: 0, stage_finished: 0 });
  assert.equal(await auditCount(t.id, "tournament.stage_started"), 1);
  const api = await standingsFor(db, (await getTournament(db, t.slug))!);
  assert.ok(api.kind === "groups" && api.stage === 2 && api.groups.length === 2, "the API shows the table of the current stage");

  // Stage 2 → playoff: group winners first, group-mates apart in round one.
  await playOut(t.id, pick, (all) => all.some((m) => m.stage === 3));
  const s3 = await tournamentRow(t.id);
  assert.equal(s3.stage, 3);
  const groups2 = (await stageTables(db, s3, 2))!.tables;
  const field3 = await entriesAt(t.id, 3);
  assert.deepEqual(field3.map((e) => e.source_rank), [1, 1, 2, 2]);
  assert.deepEqual(new Set(field3.slice(0, 2).map((e) => e.registration_id)), new Set(groups2.map((g) => g.rows.find((r) => r.rank === 1)!.id)));
  const playoff = (await matchesOf(t.id)).filter((m) => m.stage === 3);
  assert.equal(playoff.length, 3);
  assert.ok(playoff.every((m) => m.bracket === "W"));
  for (const m of playoff.filter((m) => m.round === 1)) assert.notEqual(groupOf.get(m.a_reg!), groupOf.get(m.b_reg!));
  const groupMatch = (await matchesOf(t.id)).find((m) => m.stage === 2)!;
  await rejects(correctResult(db, owner, groupMatch.id, { scoreA: 0, scoreB: 2, evidenceUrl: "", note: "Late correction" }), "stage_locked");
  assert.deepEqual(await notes(t.slug), { stage_qualified: 8, stage_out: 12, playoff_qualified: 4, stage_finished: 0 });

  await playOut(t.id, pick);
  const done = await tournamentRow(t.id);
  assert.equal(done.status, "COMPLETED");
  assert.equal(done.stage, 3);
  // Places: the playoff; then stage 2 (one shared place per group rank); then the Swiss table.
  const place = new Map((await regsOf(t.id)).map((r) => [r.id, r.placement]));
  assert.deepEqual(field3.map((e) => place.get(e.registration_id)).sort(), [1, 2, 3, 3]);
  for (const g of groups2) for (const r of g.rows.filter((r) => r.rank! > 2)) assert.equal(place.get(r.id), r.rank === 3 ? 5 : 7);
  swiss.slice(8).forEach((r, i) => assert.equal(place.get(r.id), 9 + i, "the rest by the Swiss table"));

  // A reload recomputes nothing different: places come from the saved matches and stage entries.
  const saved = await regsOf(t.id);
  await db.tx((q) => computePlacements(q, t.id));
  assert.deepEqual(await regsOf(t.id), saved);
  const history = (await tournamentHistory(db, t.id, 1000)).map((h) => h.action);
  for (const action of ["tournament.swiss_started", "tournament.stage_started", "tournament.playoff_started", "tournament.completed"]) assert.ok(history.includes(action), action);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("groups → swiss → round robin → gauntlet: four stages, dated round after round, unique and shared places", async () => {
  const t = await setup(9, {
    format: "groups",
    maxParticipants: 9,
    settings: {
      groupCount: "3",
      groupAdvance: "2",
      stage2Format: "swiss",
      stage2Rounds: "2",
      stage3Format: "round_robin",
      stage3Size: "4",
      playoffFormat: "gauntlet",
      playoffSize: "3",
      roundHours: "24",
    },
  });
  const chain = (await tournamentRow(t.id)).format_settings.chain as Array<{ format: string; size: number }>;
  assert.deepEqual(chain.map((c) => [c.format, c.size]), [["swiss", 6], ["round_robin", 4]], "after groups the next stage takes every qualifier");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const pick = await favourite(t.id);
  const start = new Date(`${START}:00Z`).getTime();
  const day = 86_400_000;

  await playOut(t.id, pick, (all) => all.some((m) => m.stage === 2));
  const field2 = await entriesAt(t.id, 2);
  assert.equal(field2.length, 6);
  assert.deepEqual(field2.map((e) => e.source_rank), [1, 1, 1, 2, 2, 2], "group winners first");
  const round1 = (await matchesOf(t.id)).filter((m) => m.stage === 2);
  const stageSeed = new Map(field2.map((e) => [e.registration_id, e.seed]));
  assert.deepEqual(
    round1.map((m) => [stageSeed.get(m.a_reg!), stageSeed.get(m.b_reg!)].sort()),
    [
      [1, 4],
      [2, 5],
      [3, 6],
    ],
    "Swiss round one pairs the top half of the new seeds against the bottom half",
  );
  for (const m of round1) assert.equal(new Date(m.scheduled_at!).getTime(), start + 3 * day, "the stage takes the slot after the group rounds");
  const frozen = (await tournamentRow(t.id)).format_settings.chain as Array<{ rounds?: number; requestedRounds?: number }>;
  assert.equal(frozen[0].rounds, 2);
  assert.equal(frozen[0].requestedRounds, 2);

  await playOut(t.id, pick, (all) => all.some((m) => m.stage === 3));
  const swissRound2 = (await matchesOf(t.id)).filter((m) => m.stage === 2 && m.round === 2);
  assert.ok(swissRound2.length > 0 && swissRound2.every((m) => new Date(m.scheduled_at!).getTime() === start + 4 * day));
  const league = (await matchesOf(t.id)).filter((m) => m.stage === 3);
  assert.equal(league.length, 6, "a round robin of four");
  for (const m of league) assert.equal(new Date(m.scheduled_at!).getTime(), start + (5 + m.round - 1) * day, `stage 3 round ${m.round} dated`);
  assert.equal((await entriesAt(t.id, 3)).length, 4);

  await playOut(t.id, pick, (all) => all.some((m) => m.stage === 4));
  const ladder = (await matchesOf(t.id)).filter((m) => m.stage === 4);
  assert.equal(ladder.length, 2);
  assert.ok(ladder.every((m) => m.bracket === "G"));
  for (const m of ladder) assert.equal(new Date(m.scheduled_at!).getTime(), start + (8 + m.round - 1) * day, `step ${m.round} dated`);
  assert.equal((await entriesAt(t.id, 4)).length, 3);

  await playOut(t.id, pick);
  const done = await tournamentRow(t.id);
  assert.equal(done.status, "COMPLETED");
  assert.equal(done.stage, 4);
  assert.deepEqual(
    (await regsOf(t.id)).map((r) => r.placement).sort((a, b) => a! - b!),
    [1, 2, 3, 4, 5, 6, 7, 7, 7],
    "gauntlet, then the round robin, the Swiss stage and the third places of the groups",
  );
  assert.equal(await auditCount(t.id, "tournament.stage_started"), 2);
  assert.equal(await auditCount(t.id, "tournament.playoff_started"), 1);

  // A copy keeps the chain as the organiser asked for it.
  const copy = await tournamentRow((await cloneTournament(db, owner, t.id, { name: "Chain Copy" })).id);
  assert.deepEqual(
    (copy.format_settings.chain as Array<Record<string, unknown>>).map((c) => [c.format, c.size, c.rounds ?? null]),
    [
      ["swiss", 6, 2],
      ["round_robin", 4, null],
    ],
  );
  assert.equal(copy.stage, 1);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("disqualification in a chained stage: annulled by default, the stage rebuilt from the table before it, places without the disqualified", async () => {
  const t = await setup(8, { format: "swiss", maxParticipants: 8, settings: { swissRounds: "2", stage2Format: "round_robin", stage2Size: "4" } });
  const settings = (await tournamentRow(t.id)).format_settings;
  assert.equal(settings.disqualification, "annul", "a round robin after Swiss follows the disqualification rule");
  assert.equal(settings.playoff, null);
  await transition(db, owner, t.id, "IN_PROGRESS");
  const pick = await favourite(t.id);
  await playOut(t.id, pick, (all) => all.some((m) => m.stage === 2));
  const field = (await entriesAt(t.id, 2)).map((e) => e.registration_id);
  assert.equal(field.length, 4);

  // A qualifier is disqualified before playing: their stage matches are annulled, and the stage is rebuilt.
  const victim = field[0];
  await disqualify(db, owner, t.id, victim, "Cheating");
  assert.equal((await matchesOf(t.id)).filter((m) => m.stage === 2 && m.status === "cancelled").length, 3);
  await regenerateMatches(db, owner, t.id);
  const refreshed = (await entriesAt(t.id, 2)).map((e) => e.registration_id);
  assert.equal(refreshed.length, 4);
  assert.ok(!refreshed.includes(victim));
  const newcomer = refreshed.find((id) => !field.includes(id))!;
  assert.ok(newcomer, "the next of the Swiss table comes in");
  const [told] = await db.query<{ n: number }>(
    "select count(*)::int as n from notifications n join registrations r on r.user_id = n.user_id where r.id = $1 and n.kind = 'stage_qualified'",
    [newcomer],
  );
  assert.equal(told.n, 1);
  assert.equal((await notes(t.slug)).stage_qualified, 5, "only the newcomer is told again");
  assert.equal(await auditCount(t.id, "tournament.stage_regenerated"), 1);
  assert.equal((await tournamentRow(t.id)).stage, 2);
  assert.ok((await matchesOf(t.id)).filter((m) => m.stage === 1).every((m) => m.status === "completed"), "the Swiss stage is untouched");
  const swissMatch = (await matchesOf(t.id)).find((m) => m.stage === 1)!;
  await rejects(correctResult(db, owner, swissMatch.id, { scoreA: 0, scoreB: 2, evidenceUrl: "", note: "Late correction" }), "stage_locked");

  // A second qualifier is disqualified after playing once: that result is annulled too, the rest cancelled.
  const first = (await matchesOf(t.id)).find((m) => m.stage === 2 && m.status === "ready")!;
  await decide(first, pick(first));
  const victim2 = first.a_reg!;
  await disqualify(db, owner, t.id, victim2, "Cheating");
  await playOut(t.id, pick);
  const done = await tournamentRow(t.id);
  assert.equal(done.status, "COMPLETED");
  const table = (await stageTables(db, done, 2))!.tables[0].rows;
  assert.equal(table.find((r) => r.id === victim2)!.rank, null);
  assert.ok(table.filter((r) => r.id !== victim2).every((r) => r.played === 2), "the annulled match does not count for the opponent");
  const regs = await regsOf(t.id);
  const place = new Map(regs.map((r) => [r.id, r.placement]));
  assert.equal(place.get(victim), null);
  assert.equal(place.get(victim2), null);
  assert.deepEqual(
    regs.map((r) => r.placement).filter((p) => p !== null).sort((a, b) => a! - b!),
    [1, 2, 3, 5, 6, 7],
    "the stage's four places come first, then the Swiss table",
  );
});

test("chain settings: gaps, growing stages, impossible groups and oversized playoffs are refused; stored requests are kept", async () => {
  throws(() => parseFormatSettings("swiss", { stage3Format: "groups" }), "invalid_stage_settings");
  throws(() => parseFormatSettings("swiss", { stage2Format: "round_robin", stage2Size: "6", stage3Format: "swiss", stage3Size: "8" }), "invalid_stage_settings");
  throws(() => parseFormatSettings("round_robin", { stage2Format: "groups", stage2Size: "6", stage2GroupCount: "4", stage2GroupAdvance: "2" }), "invalid_stage_settings");
  throws(() => parseFormatSettings("swiss", { stage2Format: "swiss", stage2Size: "8", playoffFormat: "single_elimination", playoffSize: "16" }), "invalid_stage_settings");
  throws(() => parseFormatSettings("swiss", { stage2Format: "knockout" }), "invalid_stage_settings");
  throws(() => parseFormatSettings("swiss", { stage2Format: "round_robin", stage2Size: "100" }), "round_robin_limit");
  const fromGroups = parseFormatSettings("groups", { groupCount: "4", groupAdvance: "2", stage2Format: "round_robin", stage2Size: "99" })!;
  assert.equal(fromGroups.chain![0].size, 8, "after groups the size is groups × advancing");
  const lastGroups = parseFormatSettings("swiss", { stage2Format: "groups", stage2Size: "8", stage2GroupCount: "2", stage2GroupAdvance: "2", playoffFormat: "none" })!;
  assert.deepEqual(lastGroups.playoff, { format: "single_elimination", size: 4 }, "a last stage of groups always ends in a playoff");
  assert.equal(parseFormatSettings("swiss", { stage2Format: "none" })!.chain, undefined);
  assert.equal(parseFormatSettings("swiss", {})!.disqualification, undefined, "a Swiss event alone has no disqualification rule");
  const three = parseFormatSettings("swiss", {
    stage2Format: "swiss",
    stage2Size: "32",
    stage3Format: "groups",
    stage3Size: "16",
    stage3GroupCount: "4",
    stage3GroupAdvance: "2",
    stage4Format: "round_robin",
  })!;
  assert.deepEqual(three.chain!.map((c) => [c.format, c.size]), [["swiss", 32], ["groups", 16], ["round_robin", 8]]);
  assert.deepEqual(three.playoff, null);
  // A Swiss stage's frozen rounds give way to the organiser's request when the settings are edited or copied.
  const stored = { ...three, chain: [{ format: "swiss" as const, size: 32, rounds: 5, requestedRounds: null }, ...three.chain!.slice(1)] };
  assert.equal(editableSettings({ format: "swiss", format_settings: stored })!.chain![0].rounds, null);
  // The first chained stage cannot take more entrants than the event holds.
  await rejects(createTournament(db, owner, orgId, base({ format: "swiss", maxParticipants: 6, settings: { stage2Format: "round_robin", stage2Size: "8" } })), "invalid_stage_settings");
});

test("a stage finished without moving on (code without chains, after a rollback) moves on when the event resumes", async () => {
  const t = await setup(4, {
    format: "swiss",
    maxParticipants: 4,
    settings: { swissRounds: "1", stage2Format: "round_robin", stage2Size: "4", playoffFormat: "single_elimination", playoffSize: "2" },
  });
  await transition(db, owner, t.id, "IN_PROGRESS");
  const pick = await favourite(t.id);
  await playOut(t.id, pick, (all) => all.some((m) => m.stage === 2));
  // Earlier code records the stage's results but never starts the next stage.
  await db.query(
    "update matches set status = 'completed', winner_reg = a_reg, score_a = 2, score_b = 0, outcome = 'played', completed_at = now() where tournament_id = $1 and stage = 2",
    [t.id],
  );
  assert.equal((await tournamentRow(t.id)).stage, 2);
  await transition(db, owner, t.id, "PAUSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  assert.equal((await tournamentRow(t.id)).stage, 3, "resuming starts the playoff");
  assert.equal((await entriesAt(t.id, 3)).length, 2);
  // Nothing more happens on a second pause and resume.
  await transition(db, owner, t.id, "PAUSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  assert.equal(await auditCount(t.id, "tournament.playoff_started"), 1);
  assert.equal((await matchesOf(t.id)).filter((m) => m.stage === 3).length, 1);
  await playOut(t.id, pick);
  assert.equal((await tournamentRow(t.id)).status, "COMPLETED");
});
