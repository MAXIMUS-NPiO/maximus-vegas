import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { cloneTournament, createTournament, disqualify, regenerateMatches, register, transition, type TournamentInput } from "../src/server/tournaments.ts";
import { correctResult, officialResult } from "../src/server/matches.ts";
import { decideDispute, fileDispute } from "../src/server/disputes.ts";
import { groupStandings, roundStandings } from "../src/server/rounds.ts";
import { firstRoundPairs } from "../src/server/stages.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
let seq = 0;

async function mk(name: string): Promise<SessionUser> {
  const s = await signUp(db, { email: `${name}@example.com`, username: name, displayName: name.toUpperCase(), password: "correct horse battery", adult: "on", terms: "on" });
  return (await sessionUser(db, s.token))!;
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}

const START = "2030-01-01T12:00";
const base = (over: Partial<TournamentInput> = {}): TournamentInput => ({
  name: `Stages ${++seq}`,
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
type T = { id: string; status: string; format: string; stage: number; format_settings: Record<string, unknown> };
type R = { id: string; user_id: string; status: string; placement: number | null; seed: number | null; group_no: number | null };

const matchesOf = (tid: string) => db.query<M>("select * from matches where tournament_id = $1 order by stage, group_no, bracket, round, position", [tid]);
const tournamentRow = async (tid: string) => (await db.query<T>("select id, status, format, stage, format_settings from tournaments where id = $1", [tid]))[0];
const regsOf = (tid: string) => db.query<R>("select id, user_id, status, placement, seed, group_no from registrations where tournament_id = $1 order by seed", [tid]);
const entriesOf = (tid: string) =>
  db.query<{ registration_id: string; seed: number; group_no: number | null; source_rank: number }>(
    "select registration_id, seed, group_no, source_rank from stage_entries where tournament_id = $1 order by seed",
    [tid],
  );
const auditCount = async (tid: string, action: string) =>
  (await db.query<{ n: number }>("select count(*)::int as n from audit_log where entity_id = $1 and action = $2", [tid, action]))[0].n;

let owner: SessionUser;
let orgId: string;

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  owner = await mk("stagesowner");
  orgId = (await createOrg(db, owner, { name: "Stages League", description: "" })).id;
});
test.after(async () => {
  await db.close();
});

async function setup(n: number, over: Partial<TournamentInput> = {}) {
  const t = await createTournament(db, owner, orgId, base(over));
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  const players: SessionUser[] = [];
  for (let i = 0; i < n; i++) {
    const p = await mk(`s${seq}_${i}`);
    players.push(p);
    await register(db, p, t.id);
  }
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  return { t, players };
}

/** Seed number of every registration (fixed at the start). */
async function seedsOf(tid: string) {
  return new Map((await regsOf(tid)).map((r) => [r.id, r.seed ?? 999]));
}

/** The better seed wins, unless `override` says otherwise. */
async function favourite(tid: string, override?: (m: M) => "a" | "b" | null) {
  const seeds = await seedsOf(tid);
  return (m: M) => override?.(m) ?? (seeds.get(m.a_reg!)! < seeds.get(m.b_reg!)! ? "a" : "b");
}

/** Decides ready matches (officially) until nothing is ready, or until `stop` says so. */
async function playOut(tid: string, pick: (m: M) => "a" | "b", stop?: (all: M[]) => boolean) {
  for (let guard = 0; guard < 2000; guard++) {
    const all = await matchesOf(tid);
    if (stop?.(all)) return;
    const ready = all.filter((m) => m.status === "ready");
    if (!ready.length) return;
    const m = ready[0];
    const [scoreA, scoreB] = pick(m) === "a" ? [2, 0] : [0, 2];
    await officialResult(db, owner, m.id, { scoreA, scoreB, evidenceUrl: "", note: "" });
  }
  assert.fail("did not finish");
}

const placesBySeed = async (tid: string) => Object.fromEntries((await regsOf(tid)).map((r) => [r.seed, r.placement]));

test("groups + single elimination: snake groups, playoff created once by the last group match, group-mates apart, shared places", async () => {
  const { t } = await setup(13, { format: "groups", settings: { groupCount: "4", groupAdvance: "2", playoffFormat: "single_elimination" } });
  await transition(db, owner, t.id, "IN_PROGRESS");
  const regs = await regsOf(t.id);
  const groupOf = new Map(regs.map((r) => [r.seed, r.group_no]));
  // Snake: 1–4 into A–D, 5–8 back D–A, 9–12 into A–D, 13 into D.
  assert.deepEqual([1, 8, 9].map((s) => groupOf.get(s)), [1, 1, 1]);
  assert.deepEqual([2, 7, 10].map((s) => groupOf.get(s)), [2, 2, 2]);
  assert.deepEqual([3, 6, 11].map((s) => groupOf.get(s)), [3, 3, 3]);
  assert.deepEqual([4, 5, 12, 13].map((s) => groupOf.get(s)), [4, 4, 4, 4]);
  const main = await matchesOf(t.id);
  assert.equal(main.length, 3 + 3 + 3 + 6, "each group plays its own round robin");
  assert.ok(main.every((m) => m.bracket === "RR" && m.stage === 1 && m.group_no >= 1));
  const regGroup = new Map(regs.map((r) => [r.id, r.group_no]));
  assert.ok(main.every((m) => regGroup.get(m.a_reg!) === m.group_no && regGroup.get(m.b_reg!) === m.group_no), "matches stay inside a group");
  assert.equal(await auditCount(t.id, "tournament.groups_started"), 1);

  const pick = await favourite(t.id);
  // Everything but the last group match: still the main stage.
  await playOut(t.id, pick, (all) => all.filter((m) => m.stage === 1 && m.status === "ready").length === 1);
  assert.equal((await tournamentRow(t.id)).stage, 1);
  assert.equal((await matchesOf(t.id)).filter((m) => m.stage === 2).length, 0, "no playoff before the main stage ends");
  const last = (await matchesOf(t.id)).find((m) => m.stage === 1 && m.status === "ready")!;
  await officialResult(db, owner, last.id, { scoreA: pick(last) === "a" ? 2 : 0, scoreB: pick(last) === "a" ? 0 : 2, evidenceUrl: "", note: "" });

  const after = await tournamentRow(t.id);
  assert.equal(after.stage, 2, "the last group result starts the playoff");
  assert.equal(after.status, "IN_PROGRESS");
  const entries = await entriesOf(t.id);
  assert.equal(entries.length, 8);
  const seeds = await seedsOf(t.id);
  assert.deepEqual(
    entries.slice(0, 4).map((e) => seeds.get(e.registration_id)),
    [1, 2, 3, 4],
    "group winners take the top playoff seeds (equal per-game records fall back to group order)",
  );
  assert.ok(entries.slice(0, 4).every((e) => e.source_rank === 1) && entries.slice(4).every((e) => e.source_rank === 2));
  const playoff = (await matchesOf(t.id)).filter((m) => m.stage === 2);
  assert.equal(playoff.length, 7, "8-entrant single elimination");
  assert.ok(playoff.every((m) => m.bracket === "W"));
  for (const m of playoff.filter((m) => m.round === 1)) assert.notEqual(regGroup.get(m.a_reg!), regGroup.get(m.b_reg!), "no group-mates in round one");
  const order = entries.map((e) => e.registration_id);
  for (const [x, y] of firstRoundPairs(8)) assert.notEqual(regGroup.get(order[x]), regGroup.get(order[y]));
  assert.equal(await auditCount(t.id, "tournament.playoff_started"), 1);
  const [notes] = await db.query<{ qualified: number; finished: number }>(
    `select count(*) filter (where kind = 'playoff_qualified')::int as qualified, count(*) filter (where kind = 'stage_finished')::int as finished
       from notifications where data->>'slug' = $1`,
    [t.slug],
  );
  assert.deepEqual(notes, { qualified: 8, finished: 5 });

  await playOut(t.id, pick);
  assert.equal((await tournamentRow(t.id)).status, "COMPLETED");
  assert.deepEqual(await placesBySeed(t.id), { 1: 1, 2: 2, 3: 3, 4: 3, 5: 5, 6: 5, 7: 5, 8: 5, 9: 9, 10: 9, 11: 9, 12: 9, 13: 13 });
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("groups + double elimination: the playoff grand-final reset belongs to the playoff and completes the event", async () => {
  const { t } = await setup(8, { format: "groups", settings: { groupCount: "2", groupAdvance: "2", playoffFormat: "double_elimination" } });
  await transition(db, owner, t.id, "IN_PROGRESS");
  const fav = await favourite(t.id, (m) => (m.bracket === "GF" && m.round === 1 ? "b" : null));
  await playOut(t.id, fav);
  const all = await matchesOf(t.id);
  const reset = all.find((m) => m.bracket === "GF" && m.round === 2);
  assert.ok(reset, "the losers champion won the grand final: a reset was played");
  assert.equal(reset!.stage, 2);
  const t2 = await tournamentRow(t.id);
  assert.equal(t2.status, "COMPLETED");
  const regs = await regsOf(t.id);
  const placed = regs.filter((r) => r.placement !== null);
  assert.equal(placed.length, 8, "everyone has a place");
  assert.equal(placed.filter((r) => r.placement === 1).length, 1);
  // Non-qualifiers (third and fourth in each group) follow the playoff field of four.
  const entries = new Set((await entriesOf(t.id)).map((e) => e.registration_id));
  for (const r of regs.filter((r) => !entries.has(r.id))) assert.ok(r.placement! >= 5, "the rest come after the playoff");
});

test("swiss + playoff: the top of the table qualifies in table order; the rest keep their table ranks", async () => {
  const { t } = await setup(8, { format: "swiss", settings: { playoffFormat: "single_elimination", playoffSize: "4" } });
  await transition(db, owner, t.id, "IN_PROGRESS");
  const pick = await favourite(t.id);
  await playOut(t.id, pick, (all) => all.some((m) => m.stage === 2));
  const t1 = await tournamentRow(t.id);
  assert.equal(t1.stage, 2);
  const table = await roundStandings(db, t1);
  const entries = await entriesOf(t.id);
  assert.deepEqual(
    entries.map((e) => [e.registration_id, e.source_rank]),
    table.slice(0, 4).map((r) => [r.id, r.rank]),
    "seeded by table rank",
  );
  await playOut(t.id, pick);
  assert.equal((await tournamentRow(t.id)).status, "COMPLETED");
  const regs = await regsOf(t.id);
  const place = new Map(regs.map((r) => [r.id, r.placement]));
  table.slice(4).forEach((r, i) => assert.equal(place.get(r.id), 5 + i, "the rest by table rank"));
  assert.deepEqual(regs.map((r) => r.placement).sort((a, b) => a! - b!), [1, 2, 3, 3, 5, 6, 7, 8]);
});

test("round robin + gauntlet playoff with round dates: rounds dated by the interval, the playoff in the slot after the league", async () => {
  const { t } = await setup(5, { format: "round_robin", settings: { playoffFormat: "gauntlet", playoffSize: "4", roundHours: "24" } });
  await transition(db, owner, t.id, "IN_PROGRESS");
  const start = new Date(`${START}:00Z`).getTime();
  const league = await matchesOf(t.id);
  for (const m of league) assert.equal(new Date(m.scheduled_at!).getTime(), start + (m.round - 1) * 86_400_000, `round ${m.round} dated`);
  const rounds = Math.max(...league.map((m) => m.round));
  const pick = await favourite(t.id);
  await playOut(t.id, pick, (all) => all.some((m) => m.stage === 2));
  const ladder = (await matchesOf(t.id)).filter((m) => m.stage === 2);
  assert.equal(ladder.length, 3);
  assert.ok(ladder.every((m) => m.bracket === "G"));
  const seeds = await seedsOf(t.id);
  const first = ladder.find((m) => m.round === 1)!;
  assert.deepEqual([seeds.get(first.a_reg!), seeds.get(first.b_reg!)], [3, 4], "the two lowest playoff seeds open the ladder");
  assert.equal(first.status, "ready");
  for (const m of ladder) assert.equal(new Date(m.scheduled_at!).getTime(), start + (rounds + m.round - 1) * 86_400_000, `step ${m.round} dated`);
  assert.ok(ladder.filter((m) => m.round > 1).every((m) => m.b_reg === null && m.status === "pending"));
  await playOut(t.id, pick);
  assert.equal((await tournamentRow(t.id)).status, "COMPLETED");
  assert.deepEqual(await placesBySeed(t.id), { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 }, "gauntlet places are unique, then the table");
});

test("standalone gauntlet: at most 16 entrants, upsets climb the ladder, places by elimination", async () => {
  await rejects(createTournament(db, owner, orgId, base({ format: "gauntlet", maxParticipants: 17 })), "gauntlet_limit");
  const { t } = await setup(5, { format: "gauntlet", maxParticipants: 16 });
  await transition(db, owner, t.id, "IN_PROGRESS");
  const ms = await matchesOf(t.id);
  assert.equal(ms.length, 4);
  assert.ok(ms.every((m) => m.bracket === "G" && m.stage === 1));
  // Seed 5 beats 4 and 3, then loses to 2; seed 1 wins the final.
  const seeds = await seedsOf(t.id);
  const pick = (m: M) => {
    const a = seeds.get(m.a_reg!)!;
    const b = seeds.get(m.b_reg!)!;
    if (a === 4 || a === 3) return "b" as const;
    return a < b ? ("a" as const) : ("b" as const);
  };
  await playOut(t.id, pick);
  assert.equal((await tournamentRow(t.id)).status, "COMPLETED");
  assert.deepEqual(await placesBySeed(t.id), { 1: 1, 2: 2, 5: 3, 3: 4, 4: 5 });
});

test("main stage locked: the playoff waits for open disputes, then main-stage results can no longer change", async () => {
  // Overturn: the decision changes who qualifies, and the playoff starts right after it.
  const { t, players } = await setup(4, { format: "groups", settings: { groupCount: "2", groupAdvance: "1" } });
  await transition(db, owner, t.id, "IN_PROGRESS");
  const regs = await regsOf(t.id);
  const bySeed = new Map(regs.map((r) => [r.seed, r]));
  const userOf = (seed: number) => players.find((p) => p.id === bySeed.get(seed)!.user_id)!;
  const [groupA, groupB] = [(await matchesOf(t.id)).find((m) => m.group_no === 1)!, (await matchesOf(t.id)).find((m) => m.group_no === 2)!];
  const pick = await favourite(t.id);
  const decide = (m: M) => officialResult(db, owner, m.id, { scoreA: pick(m) === "a" ? 2 : 0, scoreB: pick(m) === "a" ? 0 : 2, evidenceUrl: "", note: "" });
  await decide(groupA);
  const dispute = await fileDispute(db, userOf(4), groupA.id, { reason: "The opponent used a banned setting" });
  await decide(groupB);
  let row = await tournamentRow(t.id);
  assert.equal(row.stage, 1, "a dispute about the main stage holds the playoff");
  assert.equal((await matchesOf(t.id)).filter((m) => m.stage === 2).length, 0);
  await decideDispute(db, owner, dispute, "overturn", "Evidence confirmed");
  row = await tournamentRow(t.id);
  assert.equal(row.stage, 2, "deciding the last open dispute starts the playoff");
  const field = new Set((await entriesOf(t.id)).map((e) => e.registration_id));
  assert.deepEqual(field, new Set([bySeed.get(4)!.id, bySeed.get(2)!.id]), "the overturned result counts");
  await rejects(correctResult(db, owner, groupB.id, { scoreA: 0, scoreB: 2, evidenceUrl: "", note: "Late correction" }), "stage_locked");
  await rejects(fileDispute(db, userOf(3), groupB.id, { reason: "Too late to dispute this one" }), "stage_locked");

  // Uphold: the result stands and the playoff starts with the original qualifiers.
  const second = await setup(4, { format: "groups", settings: { groupCount: "2", groupAdvance: "1" } });
  await transition(db, owner, second.t.id, "IN_PROGRESS");
  const pick2 = await favourite(second.t.id);
  const ms2 = await matchesOf(second.t.id);
  for (const m of ms2) await officialResult(db, owner, m.id, { scoreA: pick2(m) === "a" ? 2 : 0, scoreB: pick2(m) === "a" ? 0 : 2, evidenceUrl: "", note: "" });
  assert.equal((await tournamentRow(second.t.id)).stage, 2, "no dispute: the playoff starts at once");
  // A dispute filed before the playoff and still open: upholding stays possible, overturning does not.
  const third = await setup(4, { format: "groups", settings: { groupCount: "2", groupAdvance: "1" } });
  await transition(db, owner, third.t.id, "IN_PROGRESS");
  const regs3 = await regsOf(third.t.id);
  const seed3 = new Map(regs3.map((r) => [r.seed, r]));
  const user3 = (seed: number) => third.players.find((p) => p.id === seed3.get(seed)!.user_id)!;
  const pick3 = await favourite(third.t.id);
  const [a3, b3] = [(await matchesOf(third.t.id)).find((m) => m.group_no === 1)!, (await matchesOf(third.t.id)).find((m) => m.group_no === 2)!];
  await officialResult(db, owner, a3.id, { scoreA: pick3(a3) === "a" ? 2 : 0, scoreB: pick3(a3) === "a" ? 0 : 2, evidenceUrl: "", note: "" });
  const d3 = await fileDispute(db, user3(4), a3.id, { reason: "The opponent used a banned setting" });
  await officialResult(db, owner, b3.id, { scoreA: pick3(b3) === "a" ? 2 : 0, scoreB: pick3(b3) === "a" ? 0 : 2, evidenceUrl: "", note: "" });
  assert.equal((await tournamentRow(third.t.id)).stage, 1);
  await decideDispute(db, owner, d3, "uphold", "No evidence of a banned setting");
  assert.equal((await tournamentRow(third.t.id)).stage, 2);
  assert.deepEqual(new Set((await entriesOf(third.t.id)).map((e) => e.registration_id)), new Set([seed3.get(1)!.id, seed3.get(2)!.id]));
});

test("disqualification across stages: annulled in groups, forfeited in the playoff, replaced by regenerating the playoff", async () => {
  const { t } = await setup(8, { format: "groups", settings: { groupCount: "2", groupAdvance: "2" } });
  await transition(db, owner, t.id, "IN_PROGRESS");
  const regs = await regsOf(t.id);
  const bySeed = new Map(regs.map((r) => [r.seed, r]));
  // Seed 1 (group A) is disqualified before playing: annulled by default, never qualifies.
  await disqualify(db, owner, t.id, bySeed.get(1)!.id, "Cheating");
  const cancelled = (await matchesOf(t.id)).filter((m) => m.status === "cancelled");
  assert.equal(cancelled.length, 3, "the remaining group matches are cancelled");
  const pick = await favourite(t.id);
  await playOut(t.id, pick, (all) => all.some((m) => m.stage === 2));
  const t1 = await tournamentRow(t.id);
  assert.equal(t1.stage, 2);
  const tables = await groupStandings(db, t1);
  const groupA = tables.find((g) => g.group === 1)!;
  assert.equal(groupA.rows.find((r) => r.id === bySeed.get(1)!.id)!.rank, null);
  const field = (await entriesOf(t.id)).map((e) => e.registration_id);
  assert.ok(!field.includes(bySeed.get(1)!.id));
  assert.equal(field.length, 4);
  // A qualifier is disqualified before playing in the playoff: the match is forfeited...
  const victim = field[3];
  await disqualify(db, owner, t.id, victim, "No-show policy");
  const forfeited = (await matchesOf(t.id)).find((m) => m.stage === 2 && (m.a_reg === victim || m.b_reg === victim) && m.round === 1)!;
  assert.equal(forfeited.outcome, "disqualification");
  // ...and regenerating the playoff brings in the next entrant of the main stage instead.
  await regenerateMatches(db, owner, t.id);
  const refreshed = (await entriesOf(t.id)).map((e) => e.registration_id);
  assert.equal(refreshed.length, 4);
  assert.ok(!refreshed.includes(victim));
  const newcomer = refreshed.find((id) => !field.includes(id))!;
  assert.ok(newcomer, "someone new qualified");
  const [note] = await db.query<{ n: number }>(
    "select count(*)::int as n from notifications n join registrations r on r.user_id = n.user_id where r.id = $1 and n.kind = 'playoff_qualified'",
    [newcomer],
  );
  assert.equal(note.n, 1, "the new qualifier is told");
  assert.equal(await auditCount(t.id, "tournament.playoff_regenerated"), 1);
  assert.equal((await tournamentRow(t.id)).stage, 2);
  assert.ok((await matchesOf(t.id)).filter((m) => m.stage === 1).every((m) => ["completed", "cancelled"].includes(m.status)), "the main stage is untouched");
  await playOut(t.id, pick);
  assert.equal((await tournamentRow(t.id)).status, "COMPLETED");
  const final = await regsOf(t.id);
  assert.equal(final.find((r) => r.id === victim)!.placement, null);
  assert.equal(final.find((r) => r.seed === 1)!.placement, null);
  // A played playoff result blocks a playoff regeneration.
  const other = await setup(4, { format: "groups", settings: { groupCount: "2", groupAdvance: "1" } });
  await transition(db, owner, other.t.id, "IN_PROGRESS");
  const pickOther = await favourite(other.t.id);
  await playOut(other.t.id, pickOther, (all) => all.some((m) => m.stage === 2));
  await regenerateMatches(db, owner, other.t.id);
  assert.equal((await tournamentRow(other.t.id)).stage, 2, "an unplayed playoff can be rebuilt");
  await playOut(other.t.id, pickOther);
  assert.equal((await tournamentRow(other.t.id)).status, "COMPLETED");
});

test("groups: regeneration before results keeps the snake; too few entrants or impossible settings are refused", async () => {
  const { t } = await setup(8, { format: "groups", settings: { groupCount: "2", groupAdvance: "2" } });
  await transition(db, owner, t.id, "IN_PROGRESS");
  const before = (await regsOf(t.id)).map((r) => [r.seed, r.group_no]);
  await regenerateMatches(db, owner, t.id);
  assert.deepEqual((await regsOf(t.id)).map((r) => [r.seed, r.group_no]), before);
  assert.equal((await matchesOf(t.id)).length, 12);

  // Seven entrants cannot fill four groups of two: the start is refused and nothing changes.
  const few = await setup(7, { format: "groups", settings: { groupCount: "4", groupAdvance: "2" } });
  await rejects(transition(db, owner, few.t.id, "IN_PROGRESS"), "stage_too_few");
  assert.equal((await tournamentRow(few.t.id)).status, "REGISTRATION_CLOSED");
  assert.equal((await matchesOf(few.t.id)).length, 0);
  assert.ok((await regsOf(few.t.id)).every((r) => r.group_no === null));
  // Settings that can never start are refused when saved.
  await rejects(createTournament(db, owner, orgId, base({ format: "groups", maxParticipants: 6, settings: { groupCount: "4", groupAdvance: "2" } })), "stage_too_few");
  await rejects(createTournament(db, owner, orgId, base({ format: "groups", maxParticipants: 200, settings: { groupCount: "4", groupAdvance: "2" } })), "round_robin_limit");
  await rejects(createTournament(db, owner, orgId, base({ format: "groups", settings: { groupCount: "8", groupAdvance: "3", playoffFormat: "gauntlet" } })), "gauntlet_limit");

  // A copy keeps the stage settings.
  const copy = await cloneTournament(db, owner, t.id, { name: "Stages Copy" });
  const c = await tournamentRow(copy.id);
  assert.equal(c.format, "groups");
  assert.deepEqual(c.format_settings.groups, { count: 2, advance: 2 });
  assert.deepEqual(c.format_settings.playoff, { format: "single_elimination", size: 4 });
  assert.equal(c.stage, 1);
});

test("no playoff without two qualifiers: the main stage decides and the event completes", async () => {
  const { t } = await setup(3, { format: "round_robin", settings: { playoffFormat: "single_elimination", playoffSize: "2" } });
  await transition(db, owner, t.id, "IN_PROGRESS");
  const regs = await regsOf(t.id);
  await disqualify(db, owner, t.id, regs[0].id, "Withdrew");
  await disqualify(db, owner, t.id, regs[1].id, "Withdrew");
  const row = await tournamentRow(t.id);
  assert.equal(row.status, "COMPLETED");
  assert.equal(row.stage, 2);
  assert.equal((await matchesOf(t.id)).filter((m) => m.stage === 2).length, 0);
  assert.equal(await auditCount(t.id, "tournament.playoff_skipped"), 1);
  assert.deepEqual((await regsOf(t.id)).map((r) => r.placement), [null, null, 1]);
});
