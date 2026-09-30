import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import {
  addCoOrganizer,
  cloneTournament,
  createTournament,
  disqualify,
  regenerateMatches,
  register,
  setPrizeCoins,
  transition,
  type TournamentInput,
} from "../src/server/tournaments.ts";
import { confirmResult, correctResult, officialResult, submitResult } from "../src/server/matches.ts";
import { decideDispute, fileDispute } from "../src/server/disputes.ts";
import { roundStandings } from "../src/server/rounds.ts";
import { effectiveSwissRounds, pairKey } from "../src/server/swiss.ts";
import { balance } from "../src/server/progression.ts";
import { rankings } from "../src/server/queries.ts";
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

const base = (over: Partial<TournamentInput> = {}): TournamentInput => ({
  name: `Rounds ${++seq}`,
  game: "cs2",
  participantType: "solo",
  teamSize: 1,
  maxParticipants: 32,
  checkInRequired: "",
  region: "",
  startsAt: "2030-01-01T12:00",
  timeZone: "UTC",
  description: "",
  rules: "",
  ...over,
});

type M = { id: string; bracket: string; round: number; position: number; a_reg: string | null; b_reg: string | null; winner_reg: string | null; status: string; outcome: string | null };
const matchesOf = (tid: string) => db.query<M>("select * from matches where tournament_id = $1 order by bracket, round, position", [tid]);
const tournamentRow = async (tid: string) =>
  (await db.query<{ id: string; status: string; format: string; format_settings: Record<string, unknown> }>("select id, status, format, format_settings from tournaments where id = $1", [tid]))[0];
const regsOf = (tid: string) => db.query<{ id: string; user_id: string; status: string; placement: number | null; seed: number | null }>("select id, user_id, status, placement, seed from registrations where tournament_id = $1", [tid]);

let admin: SessionUser;
let owner: SessionUser;
let orgId: string;

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  admin = await mk("roundsadmin");
  await db.query("insert into user_roles (user_id, role) values ($1, 'admin')", [admin.id]);
  admin = { ...admin, roles: ["admin"] };
  owner = await mk("roundsowner");
  orgId = (await createOrg(db, owner, { name: "Rounds League", description: "" })).id;
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
    const p = await mk(`r${seq}_${i}`);
    players.push(p);
    await register(db, p, t.id);
  }
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  return { t, players };
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** Decides every ready match (officially) until nothing is left; Swiss rounds are paired as they finish. */
async function playOut(tid: string, pick: (m: M) => "a" | "b" | "draw") {
  for (let guard = 0; guard < 2000; guard++) {
    const ready = (await matchesOf(tid)).filter((m) => m.status === "ready");
    if (!ready.length) return;
    const m = ready[0];
    const side = pick(m);
    const [scoreA, scoreB] = side === "a" ? [2, 0] : side === "b" ? [0, 2] : [1, 1];
    await officialResult(db, owner, m.id, { scoreA, scoreB, evidenceUrl: "", note: "" });
  }
  assert.fail("did not finish");
}

/** Places must equal the table computed from the stored matches: unique, 1..n for everyone not disqualified. */
async function assertPlacesFollowTable(tid: string) {
  const t = await tournamentRow(tid);
  const table = await roundStandings(db, t);
  const regs = await regsOf(tid);
  const byId = new Map(regs.map((r) => [r.id, r]));
  for (const row of table) assert.equal(byId.get(row.id)?.placement ?? null, row.rank, "placement equals table rank");
  const places = regs.filter((r) => r.placement !== null).map((r) => r.placement!).sort((a, b) => a - b);
  assert.deepEqual(places, Array.from({ length: places.length }, (_, i) => i + 1), "places are 1..n without gaps");
  return table;
}

test("round robin on the database: every pair meets once per leg and the table decides the places", async () => {
  for (const n of [2, 3, 5, 8]) {
    const { t } = await setup(n, { format: "round_robin" });
    await transition(db, owner, t.id, "IN_PROGRESS");
    const ms = await matchesOf(t.id);
    assert.ok(ms.every((m) => m.bracket === "RR"));
    assert.equal(ms.length, (n * (n - 1)) / 2, `RR ${n}: n(n-1)/2 matches`);
    assert.equal(Math.max(...ms.map((m) => m.round)), n % 2 === 0 ? n - 1 : n, `RR ${n}: rounds`);
    const pairs = new Set(ms.map((m) => pairKey(m.a_reg!, m.b_reg!)));
    assert.equal(pairs.size, ms.length, `RR ${n}: no pair twice`);
    for (let r = 1; r <= Math.max(...ms.map((m) => m.round)); r++) {
      const inRound = ms.filter((m) => m.round === r).flatMap((m) => [m.a_reg, m.b_reg]);
      assert.equal(new Set(inRound).size, inRound.length, `RR ${n}: nobody plays twice in round ${r}`);
    }
    const r = rng(n * 31);
    await playOut(t.id, () => (r() < 0.5 ? "a" : "b"));
    assert.equal((await tournamentRow(t.id)).status, "COMPLETED", `RR ${n} completes`);
    const table = await assertPlacesFollowTable(t.id);
    assert.equal(table.length, n);
    const [log] = await db.query<{ n: number }>("select count(*)::int as n from audit_log where action = 'tournament.round_robin_started' and entity_id = $1", [t.id]);
    assert.equal(log.n, 1, "start recorded with its settings");
  }
  // Two legs: every pair twice, once on each side.
  const { t } = await setup(4, { format: "round_robin", settings: { legs: "2" } });
  await transition(db, owner, t.id, "IN_PROGRESS");
  const ms = await matchesOf(t.id);
  assert.equal(ms.length, 12);
  const sides = new Set(ms.map((m) => `${m.a_reg}>${m.b_reg}`));
  assert.equal(sides.size, 12, "the second leg swaps sides");
  assert.equal(Math.max(...ms.map((m) => m.round)), 6);
});

test("draws: accepted only in round robin and Swiss when allowed; a draw gives both sides match XP", async () => {
  const { t, players } = await setup(3, { format: "round_robin", settings: { allowDraws: "on", pointsWin: "3", pointsDraw: "1", pointsLoss: "0" } });
  await transition(db, owner, t.id, "IN_PROGRESS");
  const [m] = await matchesOf(t.id);
  const leader = async (reg: string) => {
    const [r] = await db.query<{ user_id: string }>("select user_id from registrations where id = $1", [reg]);
    return players.find((p) => p.id === r.user_id)!;
  };
  const a = await leader(m.a_reg!);
  const b = await leader(m.b_reg!);
  await submitResult(db, a, m.id, { scoreA: 1, scoreB: 1, evidenceUrl: "", note: "" });
  await confirmResult(db, b, m.id);
  const [done] = await db.query<M>("select * from matches where id = $1", [m.id]);
  assert.equal(done.status, "completed");
  assert.equal(done.winner_reg, null, "a draw has no winner");
  const xp = await db.query<{ user_id: string; reason: string }>("select user_id, reason from xp_events where ref = $1", [m.id]);
  assert.deepEqual(xp.map((x) => x.reason).sort(), ["match_played", "match_played"]);
  assert.deepEqual(new Set(xp.map((x) => x.user_id)), new Set([a.id, b.id]));
  const table = await roundStandings(db, await tournamentRow(t.id));
  for (const reg of [m.a_reg, m.b_reg]) {
    const row = table.find((x) => x.id === reg)!;
    assert.equal(row.draws, 1);
    assert.equal(row.points, 1);
  }
  // Draws are refused where the organiser did not allow them, and in brackets.
  const noDraws = await setup(3, { format: "round_robin" });
  await transition(db, owner, noDraws.t.id, "IN_PROGRESS");
  const [m2] = await matchesOf(noDraws.t.id);
  await rejects(officialResult(db, owner, m2.id, { scoreA: 1, scoreB: 1, evidenceUrl: "", note: "" }), "draw_not_allowed");
  const se = await setup(2);
  await transition(db, owner, se.t.id, "IN_PROGRESS");
  const [m3] = await matchesOf(se.t.id);
  await rejects(officialResult(db, owner, m3.id, { scoreA: 1, scoreB: 1, evidenceUrl: "", note: "" }), "draw_not_allowed");
  // A round robin with draws allowed finishes with drawn matches counted.
  await playOut(t.id, () => "draw");
  assert.equal((await tournamentRow(t.id)).status, "COMPLETED");
  await assertPlacesFollowTable(t.id);
});

test("swiss on the database: rounds frozen at the start, no rematches, one bye per odd round, places from the table", async () => {
  for (const n of [4, 5, 8, 9, 12]) {
    const { t } = await setup(n, { format: "swiss" });
    await transition(db, owner, t.id, "IN_PROGRESS");
    const frozen = (await tournamentRow(t.id)).format_settings;
    assert.equal(frozen.rounds, effectiveSwissRounds(n, null), `Swiss ${n}: rounds frozen`);
    assert.equal(frozen.pairing, "MV-SWISS-1");
    assert.equal(frozen.standings, "MV-STANDINGS-1");
    assert.equal(frozen.requestedRounds, null, "the organiser's request is kept");
    const r = rng(n * 131);
    await playOut(t.id, () => (r() < 0.5 ? "a" : "b"));
    assert.equal((await tournamentRow(t.id)).status, "COMPLETED", `Swiss ${n} completes`);
    const ms = await matchesOf(t.id);
    assert.ok(ms.every((m) => m.bracket === "SW"));
    const rounds = frozen.rounds as number;
    assert.equal(Math.max(...ms.map((m) => m.round)), rounds, `Swiss ${n}: exactly the frozen number of rounds`);
    const games = ms.filter((m) => m.a_reg && m.b_reg);
    assert.equal(new Set(games.map((m) => pairKey(m.a_reg!, m.b_reg!))).size, games.length, `Swiss ${n}: no rematch`);
    const byes = ms.filter((m) => m.outcome === "bye");
    assert.equal(byes.length, n % 2 === 1 ? rounds : 0, `Swiss ${n}: one bye per round for an odd field`);
    assert.equal(new Set(byes.map((m) => m.a_reg)).size, byes.length, `Swiss ${n}: nobody gets two byes`);
    for (let round = 1; round <= rounds; round++) {
      const inRound = ms.filter((m) => m.round === round);
      assert.equal(inRound.length, Math.ceil(n / 2), `Swiss ${n}: round ${round} size`);
      const seen = inRound.flatMap((m) => [m.a_reg, m.b_reg]).filter(Boolean);
      assert.equal(new Set(seen).size, n, `Swiss ${n}: everyone once in round ${round}`);
    }
    await assertPlacesFollowTable(t.id);
    const [log] = await db.query<{ n: number }>("select count(*)::int as n from audit_log where action = 'tournament.swiss_round_paired' and entity_id = $1", [t.id]);
    assert.equal(log.n, rounds, "every pairing is recorded");
  }
});

test("swiss: requested rounds are honoured up to n−1; a disqualified entrant forfeits and is not paired again", async () => {
  const { t } = await setup(6, { format: "swiss", settings: { swissRounds: "5" } });
  await rejects(createTournament(db, owner, orgId, base({ format: "swiss", settings: { swissRounds: "21" } })), "invalid_input");
  await transition(db, owner, t.id, "IN_PROGRESS");
  assert.equal((await tournamentRow(t.id)).format_settings.rounds, 5);
  const round1 = (await matchesOf(t.id)).filter((m) => m.round === 1);
  for (const m of round1) await officialResult(db, owner, m.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  const round2 = (await matchesOf(t.id)).filter((m) => m.round === 2);
  assert.equal(round2.length, 3, "round 2 paired once round 1 is complete");
  const victim = round2[0].b_reg!;
  await disqualify(db, owner, t.id, victim, "Rules breach");
  const [forfeit] = await db.query<M>("select * from matches where id = $1", [round2[0].id]);
  assert.equal(forfeit.status, "completed");
  assert.equal(forfeit.outcome, "disqualification");
  assert.equal(forfeit.winner_reg, round2[0].a_reg);
  await playOut(t.id, (m) => (m.position % 2 === 0 ? "a" : "b"));
  assert.equal((await tournamentRow(t.id)).status, "COMPLETED");
  const later = (await matchesOf(t.id)).filter((m) => m.round > 2);
  assert.ok(later.length > 0);
  assert.ok(later.every((m) => m.a_reg !== victim && m.b_reg !== victim), "no pairing after disqualification");
  assert.ok(later.filter((m) => m.round === 3).some((m) => m.outcome === "bye"), "five remaining entrants: a bye each round");
  const regs = await regsOf(t.id);
  assert.equal(regs.find((r) => r.id === victim)!.placement, null, "the disqualified entrant is not placed");
  await assertPlacesFollowTable(t.id);
});

test("round robin: the tournament's disqualification rule — annul by default, forfeit, or the 50% rule", async () => {
  // Default for new tournaments: annul. The remaining matches are cancelled and every result of the entrant leaves the table.
  {
    const { t } = await setup(4, { format: "round_robin" });
    assert.equal((await tournamentRow(t.id)).format_settings.disqualification, "annul");
    await transition(db, owner, t.id, "IN_PROGRESS");
    const round1 = (await matchesOf(t.id)).filter((m) => m.round === 1);
    for (const m of round1) await officialResult(db, owner, m.id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" });
    const victim = round1[0].a_reg!;
    const beaten = round1[0].b_reg!;
    await disqualify(db, owner, t.id, victim, "Cheating report upheld");
    const theirs = (await matchesOf(t.id)).filter((m) => m.a_reg === victim || m.b_reg === victim);
    assert.ok(theirs.filter((m) => m.round > 1).every((m) => m.status === "cancelled" && m.outcome === "disqualification" && m.winner_reg === null));
    await playOut(t.id, () => "a");
    assert.equal((await tournamentRow(t.id)).status, "COMPLETED");
    const table = await assertPlacesFollowTable(t.id);
    const victimRow = table.find((r) => r.id === victim)!;
    assert.equal(victimRow.rank, null);
    assert.equal(victimRow.annulled, true);
    assert.equal(victimRow.points, 0);
    assert.equal(table.find((r) => r.id === beaten)!.losses, 0, "the loss to the disqualified entrant no longer counts");
    assert.equal(table.filter((r) => !r.disqualified).every((r) => r.played === 2), true, "everyone else is compared on the same two games");
  }
  // forfeit: results already played stand, the remaining matches go to the opponents.
  {
    const { t } = await setup(4, { format: "round_robin", settings: { dqRule: "forfeit" } });
    await transition(db, owner, t.id, "IN_PROGRESS");
    const round1 = (await matchesOf(t.id)).filter((m) => m.round === 1);
    for (const m of round1) await officialResult(db, owner, m.id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" });
    const victim = round1[0].a_reg!;
    await disqualify(db, owner, t.id, victim, "Cheating report upheld");
    const theirs = (await matchesOf(t.id)).filter((m) => m.a_reg === victim || m.b_reg === victim);
    assert.equal(theirs.length, 3);
    assert.ok(theirs.filter((m) => m.round > 1).every((m) => m.status === "completed" && m.outcome === "disqualification" && m.winner_reg !== victim));
    await playOut(t.id, () => "a");
    const table = await assertPlacesFollowTable(t.id);
    const victimRow = table.find((r) => r.id === victim)!;
    assert.equal(victimRow.rank, null);
    assert.equal(victimRow.wins, 1, "results already played stand");
    assert.equal(victimRow.annulled, false);
  }
  // half: disqualified after 2 of 3 matches → forfeits; after 1 of 5 → annulled.
  {
    const { t } = await setup(4, { format: "round_robin", settings: { dqRule: "half" } });
    await transition(db, owner, t.id, "IN_PROGRESS");
    for (const r of [1, 2]) for (const m of (await matchesOf(t.id)).filter((x) => x.round === r)) await officialResult(db, owner, m.id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" });
    const victim = (await matchesOf(t.id)).find((m) => m.round === 3)!.a_reg!;
    await disqualify(db, owner, t.id, victim, "Left the event");
    const last = (await matchesOf(t.id)).find((m) => m.round === 3 && (m.a_reg === victim || m.b_reg === victim))!;
    assert.equal(last.status, "completed");
    assert.equal(last.outcome, "disqualification");
    await playOut(t.id, () => "a");
    assert.equal((await assertPlacesFollowTable(t.id)).find((r) => r.id === victim)!.annulled, false);
  }
  {
    const { t } = await setup(6, { format: "round_robin", settings: { dqRule: "half" } });
    await transition(db, owner, t.id, "IN_PROGRESS");
    for (const m of (await matchesOf(t.id)).filter((x) => x.round === 1)) await officialResult(db, owner, m.id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" });
    const victim = (await matchesOf(t.id)).find((m) => m.round === 1)!.a_reg!;
    await disqualify(db, owner, t.id, victim, "Left the event");
    assert.ok((await matchesOf(t.id)).filter((m) => m.round > 1 && (m.a_reg === victim || m.b_reg === victim)).every((m) => m.status === "cancelled"));
    await playOut(t.id, () => "b");
    assert.equal((await tournamentRow(t.id)).status, "COMPLETED");
    assert.equal((await assertPlacesFollowTable(t.id)).find((r) => r.id === victim)!.annulled, true);
  }
  await rejects(createTournament(db, owner, orgId, base({ format: "round_robin", settings: { dqRule: "lottery" } })), "invalid_input");
});

test("corrections and overturned disputes re-rank a completed round robin and pay a new champion without claw-back", async () => {
  const { t, players } = await setup(3, { format: "round_robin" });
  await setPrizeCoins(db, admin, t.id, 100);
  await transition(db, owner, t.id, "IN_PROGRESS");
  const regs = await regsOf(t.id);
  const regOf = (p: SessionUser) => regs.find((r) => r.user_id === p.id)!.id;
  const [A, B, C] = players.map(regOf);
  const strength = new Map([[A, 3], [B, 2], [C, 1]]);
  await playOut(t.id, (m) => (strength.get(m.a_reg!)! > strength.get(m.b_reg!)! ? "a" : "b"));
  assert.equal((await tournamentRow(t.id)).status, "COMPLETED");
  assert.equal((await regsOf(t.id)).find((r) => r.id === A)!.placement, 1);
  assert.equal(await balance(db, players[0].id), 100);
  // The organiser corrects A v B: B won it. B now leads on points.
  const ab = (await matchesOf(t.id)).find((m) => pairKey(m.a_reg!, m.b_reg!) === pairKey(A, B))!;
  const bIsA = ab.a_reg === B;
  await correctResult(db, owner, ab.id, { scoreA: bIsA ? 2 : 0, scoreB: bIsA ? 0 : 2, evidenceUrl: "", note: "Replay reviewed" });
  let placed = await regsOf(t.id);
  assert.equal(placed.find((r) => r.id === B)!.placement, 1, "the table changes the champion");
  assert.equal(placed.find((r) => r.id === A)!.placement, 2);
  assert.equal(await balance(db, players[1].id), 100, "the new champion is paid");
  assert.equal(await balance(db, players[0].id), 100, "nothing is clawed back");
  await assertPlacesFollowTable(t.id);
  // C files a post-result dispute on its loss to B and it is overturned: B and C swap that result.
  const bc = (await matchesOf(t.id)).find((m) => pairKey(m.a_reg!, m.b_reg!) === pairKey(B, C))!;
  const disputeId = await fileDispute(db, players[2], bc.id, { reason: "Opponent used a banned setting" });
  await decideDispute(db, owner, disputeId, "overturn", "Evidence confirmed");
  placed = await regsOf(t.id);
  const [after] = await db.query<M>("select * from matches where id = $1", [bc.id]);
  assert.equal(after.winner_reg, C);
  await assertPlacesFollowTable(t.id);
  assert.equal((await tournamentRow(t.id)).status, "COMPLETED", "a table change never reopens a round robin");
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("safe regeneration: rebuilt from current entrants before the first result, blocked after it", async () => {
  // Swiss: an entrant is disqualified before any game; round 1 is rebuilt without the forfeit.
  const { t, players } = await setup(5, { format: "swiss" });
  await transition(db, owner, t.id, "IN_PROGRESS");
  const before = await matchesOf(t.id);
  const victim = before.find((m) => m.a_reg && m.b_reg)!.a_reg!;
  await disqualify(db, owner, t.id, victim, "Did not meet eligibility");
  await regenerateMatches(db, owner, t.id);
  const rebuilt = await matchesOf(t.id);
  assert.ok(rebuilt.every((m) => !before.some((b) => b.id === m.id)), "old matches are gone");
  assert.equal(rebuilt.length, 2, "four entrants: two games, no bye");
  assert.ok(rebuilt.every((m) => m.a_reg !== victim && m.b_reg !== victim && m.status === "ready"));
  assert.equal((await tournamentRow(t.id)).format_settings.rounds, effectiveSwissRounds(4, null), "rounds recomputed for the new field");
  const seeds = (await regsOf(t.id)).filter((r) => r.status === "registered").map((r) => r.seed).sort();
  assert.deepEqual(seeds, [1, 2, 3, 4]);
  const [note] = await db.query<{ n: number }>("select count(*)::int as n from notifications where kind = 'bracket_regenerated' and data->>'slug' = $1", [t.slug]);
  assert.ok(note.n >= 4);
  // One reported result blocks it.
  const [who] = await db.query<{ user_id: string }>("select user_id from registrations where id = $1", [rebuilt[0].a_reg]);
  const reporter = players.find((p) => p.id === who.user_id)!;
  await submitResult(db, reporter, rebuilt[0].id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  await rejects(regenerateMatches(db, owner, t.id), "regeneration_blocked");
  // Single elimination: rebuilt with byes; a leaderboard has nothing to regenerate.
  const se = await setup(6);
  await transition(db, owner, se.t.id, "IN_PROGRESS");
  await regenerateMatches(db, owner, se.t.id);
  const bracket = await matchesOf(se.t.id);
  assert.equal(bracket.filter((m) => m.outcome === "bye").length, 2, "six entrants in an eight-slot bracket: two byes");
  const lb = await setup(2, { game: "fortnite", format: "leaderboard" });
  await transition(db, owner, lb.t.id, "IN_PROGRESS");
  await rejects(regenerateMatches(db, owner, lb.t.id), "invalid_transition");
});

test("clone copies the organiser's settings into a new draft; only space managers can clone", async () => {
  const { t } = await setup(4, { format: "swiss", settings: { swissRounds: "3", pointsWin: "2", pointsDraw: "1", pointsLoss: "0", pointsBye: "1", allowDraws: "on" } });
  await transition(db, owner, t.id, "IN_PROGRESS");
  const copy = await cloneTournament(db, owner, t.id, { name: "Rounds Copy" });
  const [row] = await db.query<{ status: string; format: string; format_settings: Record<string, unknown>; created_by: string; name: string; starts_at: Date }>(
    "select status, format, format_settings, created_by, name, starts_at from tournaments where id = $1",
    [copy.id],
  );
  assert.equal(row.status, "DRAFT");
  assert.equal(row.format, "swiss");
  assert.equal(row.name, "Rounds Copy");
  assert.equal(row.format_settings.rounds, 3, "the organiser's request, not the frozen value");
  assert.equal(row.format_settings.requestedRounds, undefined);
  assert.deepEqual(row.format_settings.points, { win: 2, draw: 1, loss: 0, bye: 1 });
  assert.equal(row.format_settings.allowDraws, true);
  assert.ok(new Date(row.starts_at).getTime() > Date.now(), "starts in the future");
  const [regs] = await db.query<{ n: number }>("select count(*)::int as n from registrations where tournament_id = $1", [copy.id]);
  assert.equal(regs.n, 0, "no entrants are copied");
  const helper = await mk(`coorg${seq}`);
  await addCoOrganizer(db, owner, t.id, helper.username);
  await rejects(cloneTournament(db, helper, t.id, {}), "forbidden");
});

test("validation: round-robin size, points table and format support", async () => {
  await rejects(createTournament(db, owner, orgId, base({ format: "round_robin", maxParticipants: 33 })), "round_robin_limit");
  await rejects(createTournament(db, owner, orgId, base({ format: "round_robin", settings: { pointsWin: "1", pointsLoss: "2" } })), "invalid_points");
  await rejects(createTournament(db, owner, orgId, base({ format: "swiss", settings: { pointsDraw: "5", pointsWin: "3" } })), "invalid_points");
  await rejects(createTournament(db, owner, orgId, base({ format: "round_robin", game: "fortnite" })), "format_not_supported");
  await rejects(createTournament(db, owner, orgId, base({ format: "swiss", game: "fortnite" })), "format_not_supported");
  const ok = await createTournament(db, owner, orgId, base({ format: "round_robin", maxParticipants: 32 }));
  const [row] = await db.query<{ format_settings: Record<string, unknown> }>("select format_settings from tournaments where id = $1", [ok.id]);
  assert.deepEqual(row.format_settings.points, { win: 3, draw: 1, loss: 0, bye: 0 }, "defaults for round robin");
  assert.equal(row.format_settings.legs, 1);
});

test("rankings: titles are first places of completed events; draws are neither wins nor losses", async () => {
  const { t, players } = await setup(2, { format: "round_robin", settings: { allowDraws: "on" } });
  await transition(db, owner, t.id, "IN_PROGRESS");
  await playOut(t.id, () => "draw");
  const r = await rankings(db, "cs2");
  const rows = players.map((p) => r.solo.find((x) => x.link === p.username)!);
  assert.ok(rows.every((x) => x.draws === 1 && x.wins === 0 && x.losses === 0));
  const champions = await db.query<{ user_id: string }>("select user_id from registrations where tournament_id = $1 and placement = 1", [t.id]);
  assert.equal(champions.length, 1, "seed breaks the full tie");
  const champ = players.find((p) => p.id === champions[0].user_id)!;
  assert.equal(r.solo.find((x) => x.link === champ.username)!.titles, 1);
});
