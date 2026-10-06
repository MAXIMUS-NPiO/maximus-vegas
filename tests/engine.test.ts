import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import {
  addCoOrganizer,
  createTournament,
  disqualify,
  matchCheckIn,
  register,
  removeCoOrganizer,
  setPrizeCoins,
  transition,
  type TournamentInput,
} from "../src/server/tournaments.ts";
import { correctResult, officialResult } from "../src/server/matches.ts";
import { decideDispute, fileDispute, reputation } from "../src/server/disputes.ts";
import { leaderboardStandings, reviewScore, submitScore } from "../src/server/leaderboard.ts";
import { balance } from "../src/server/progression.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
let seq = 0;

async function mk(name: string, country?: string): Promise<SessionUser> {
  const s = await signUp(db, {
    email: `${name}@example.com`,
    username: name,
    displayName: name.toUpperCase(),
    password: "correct horse battery",
    adult: "on",
    terms: "on",
  });
  if (country) await db.query("update users set country_code = $2 where username = $1", [name, country]);
  return (await sessionUser(db, s.token))!;
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}

const base = (over: Partial<TournamentInput> = {}): TournamentInput => ({
  name: `Cup ${++seq}`,
  game: "cs2",
  participantType: "solo",
  teamSize: 1,
  maxParticipants: 64,
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

let admin: SessionUser;
let orgOwner: SessionUser;
let orgId: string;

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  admin = await mk("platformadmin");
  await db.query("insert into user_roles (user_id, role) values ($1, 'admin')", [admin.id]);
  admin = { ...admin, roles: ["admin"] };
  orgOwner = await mk("eventowner");
  orgId = (await createOrg(db, orgOwner, { name: "Events", description: "" })).id;
});
test.after(async () => {
  await db.close();
});

async function setup(n: number, over: Partial<TournamentInput> = {}) {
  const t = await createTournament(db, orgOwner, orgId, base(over));
  await transition(db, orgOwner, t.id, "PUBLISHED");
  await transition(db, orgOwner, t.id, "REGISTRATION_OPEN");
  const players: SessionUser[] = [];
  for (let i = 0; i < n; i++) {
    const p = await mk(`p${seq}_${i}`);
    players.push(p);
    await register(db, p, t.id);
  }
  await transition(db, orgOwner, t.id, "REGISTRATION_CLOSED");
  return { t, players };
}

/** Plays every ready match with the given picker until nothing is left. */
async function playOut(tid: string, pick: (m: M) => "a" | "b") {
  for (let guard = 0; guard < 500; guard++) {
    const ready = (await matchesOf(tid)).filter((m) => m.status === "ready");
    if (!ready.length) return;
    const m = ready[0];
    const side = pick(m);
    await officialResult(db, orgOwner, m.id, { scoreA: side === "a" ? 2 : 0, scoreB: side === "a" ? 0 : 2, evidenceUrl: "", note: "" });
  }
  assert.fail("did not finish");
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

test("double elimination on the database: completes for 2–12 entrants with correct losses and placements", async () => {
  for (const n of [2, 3, 5, 6, 8, 11, 12]) {
    const { t } = await setup(n, { format: "double_elimination" });
    await transition(db, orgOwner, t.id, "IN_PROGRESS");
    const r = rng(n * 97);
    await playOut(t.id, () => (r() < 0.5 ? "a" : "b"));
    const [row] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
    assert.equal(row.status, "COMPLETED", `DE ${n} completes`);
    const ms = await matchesOf(t.id);
    const played = ms.filter((m) => m.status === "completed" && m.outcome === "played");
    const reset = ms.some((m) => m.bracket === "GF" && m.round === 2);
    assert.equal(played.length, reset ? 2 * n - 1 : 2 * n - 2, `DE ${n} match count`);
    const losses = new Map<string, number>();
    for (const m of played) {
      const loser = m.winner_reg === m.a_reg ? m.b_reg! : m.a_reg!;
      losses.set(loser, (losses.get(loser) ?? 0) + 1);
    }
    const regs = await db.query<{ id: string; placement: number | null }>("select id, placement from registrations where tournament_id = $1", [t.id]);
    const champion = regs.filter((x) => x.placement === 1);
    assert.equal(champion.length, 1, "one champion");
    assert.ok((losses.get(champion[0].id) ?? 0) <= 1, "champion lost at most once");
    for (const x of regs) if (x.id !== champion[0].id) assert.equal(losses.get(x.id), 2, `DE ${n}: everyone else lost twice`);
    assert.ok(regs.every((x) => x.placement !== null), "everyone placed");
    assert.equal(regs.filter((x) => x.placement === 2).length, 1, "one runner-up");
  }
});

test("double elimination: the losers champion forces a bracket reset; champion award is paid once per champion", async () => {
  const { t, players } = await setup(4, { format: "double_elimination" });
  await setPrizeCoins(db, admin, t.id, 500);
  await rejects(setPrizeCoins(db, orgOwner, t.id, 500), "forbidden");
  await transition(db, orgOwner, t.id, "IN_PROGRESS");
  // Seed 1 wins everything in the winners bracket, then loses the grand final and the reset.
  const [seed1] = await db.query<{ id: string }>("select id from registrations where tournament_id = $1 and seed = 1", [t.id]);
  await playOut(t.id, (m) => {
    if (m.bracket === "GF") return m.a_reg === seed1.id ? "b" : "a";
    return m.a_reg === seed1.id ? "a" : m.b_reg === seed1.id ? "b" : "a";
  });
  const ms = await matchesOf(t.id);
  assert.ok(ms.find((m) => m.bracket === "GF" && m.round === 2), "reset created");
  const [champ] = await db.query<{ id: string; user_id: string }>("select id, user_id from registrations where tournament_id = $1 and placement = 1", [t.id]);
  assert.notEqual(champ.id, seed1.id);
  assert.equal(await balance(db, champ.user_id), 500, "champion paid");
  assert.ok(players.some((p) => p.id === champ.user_id));
  const [award] = await db.query<{ n: number }>("select count(*)::int as n from tournament_awards where tournament_id = $1", [t.id]);
  assert.equal(award.n, 1);
});

test("post-result dispute: overturning the grand final re-opens the tournament for a reset, pays the new champion, claws nothing back", async () => {
  const { t } = await setup(4, { format: "double_elimination" });
  await setPrizeCoins(db, admin, t.id, 300);
  await transition(db, orgOwner, t.id, "IN_PROGRESS");
  // Favourites (seed order, side a) win everything: the winners champion takes the grand final outright.
  await playOut(t.id, () => "a");
  let [tt] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
  assert.equal(tt.status, "COMPLETED");
  const gf = (await matchesOf(t.id)).find((m) => m.bracket === "GF" && m.round === 1)!;
  const [first] = await db.query<{ user_id: string }>("select user_id from registrations where id = $1", [gf.winner_reg]);
  assert.equal(await balance(db, first.user_id), 300);
  const [runner] = await db.query<{ user_id: string }>("select user_id from registrations where id = $1", [gf.b_reg]);
  const runnerUser = await sessionFor(runner.user_id);
  const disputeId = await fileDispute(db, runnerUser, gf.id, { reason: "Opponent used a banned configuration", evidenceUrl: "https://example.com/demo" });
  await rejects(fileDispute(db, runnerUser, gf.id, { reason: "Second dispute on the same match" }), "dispute_exists");
  await decideDispute(db, orgOwner, disputeId, "overturn", "Banned configuration confirmed from the demo");
  [tt] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
  assert.equal(tt.status, "IN_PROGRESS", "tournament resumes for the reset");
  const reset = (await matchesOf(t.id)).find((m) => m.bracket === "GF" && m.round === 2)!;
  assert.equal(reset.status, "ready");
  // The losers champion wins the reset: new champion is paid; the previous one keeps what was paid.
  await officialResult(db, orgOwner, reset.id, { scoreA: 0, scoreB: 2, evidenceUrl: "", note: "" });
  [tt] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
  assert.equal(tt.status, "COMPLETED");
  assert.equal(await balance(db, runner.user_id), 300, "new champion paid");
  assert.equal(await balance(db, first.user_id), 300, "no clawback");
  const [awards] = await db.query<{ n: number }>("select count(*)::int as n from tournament_awards where tournament_id = $1", [t.id]);
  assert.equal(awards.n, 2);
});

async function sessionFor(userId: string): Promise<SessionUser> {
  const [u] = await db.query<{ id: string; email: string; username: string; display_name: string }>("select * from users where id = $1", [userId]);
  return { id: u.id, email: u.email, username: u.username, displayName: u.display_name, roles: [], sessionId: "test" };
}

test("post-result dispute: upheld disputes cost the filer reputation; overturned ones do not", async () => {
  const { t } = await setup(4);
  await transition(db, orgOwner, t.id, "IN_PROGRESS");
  const [m1] = (await matchesOf(t.id)).filter((m) => m.status === "ready");
  await officialResult(db, orgOwner, m1.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  const [loser] = await db.query<{ user_id: string }>("select user_id from registrations where id = $1", [m1.b_reg]);
  const lu = await sessionFor(loser.user_id);
  assert.equal(await reputation(db, lu.id), 100);
  const d1 = await fileDispute(db, lu, m1.id, { reason: "I think the score was wrong" });
  await decideDispute(db, orgOwner, d1, "uphold", "Evidence does not support the claim");
  assert.equal(await reputation(db, lu.id), 95);
  const outsider = await mk(`outsider${seq}`);
  await rejects(fileDispute(db, outsider, m1.id, { reason: "Not my match at all here" }), "not_participant");
  await rejects(decideDispute(db, orgOwner, d1, "overturn", "Deciding twice is refused"), "already_completed");
  const d2 = await fileDispute(db, lu, m1.id, { reason: "New evidence: opponent account shared" });
  await rejects(decideDispute(db, outsider, d2, "overturn", "No rights to decide"), "forbidden");
  await decideDispute(db, orgOwner, d2, "overturn", "Account sharing confirmed");
  assert.equal(await reputation(db, lu.id), 95, "an overturned dispute costs nothing");
  const [after] = await db.query<{ winner_reg: string; outcome: string }>("select winner_reg, outcome from matches where id = $1", [m1.id]);
  assert.equal(after.winner_reg, m1.b_reg);
  assert.equal(after.outcome, "decision");
});

test("corrections route through automatic byes but never rewrite a played dependent match", async () => {
  const { t } = await setup(5, { format: "double_elimination" });
  await transition(db, orgOwner, t.id, "IN_PROGRESS");
  const ready = (await matchesOf(t.id)).filter((m) => m.status === "ready" && m.bracket === "W" && m.round === 1);
  assert.equal(ready.length, 1, "5 entrants: one real first-round match, three byes");
  const m = ready[0];
  await officialResult(db, orgOwner, m.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  // The loser dropped opposite a void slot and advanced automatically; correcting the result re-routes both.
  await correctResult(db, orgOwner, m.id, { scoreA: 0, scoreB: 2, evidenceUrl: "", note: "Scores were swapped by mistake" });
  const after = (await matchesOf(t.id)).find((x) => x.id === m.id)!;
  assert.equal(after.winner_reg, m.b_reg);
  const lb = (await matchesOf(t.id)).filter((x) => x.bracket === "L" && (x.a_reg === m.a_reg || x.b_reg === m.a_reg));
  assert.ok(lb.length >= 1, "the new loser is in the losers bracket");
  assert.ok(!(await matchesOf(t.id)).some((x) => x.bracket === "L" && (x.a_reg === m.b_reg || x.b_reg === m.b_reg)), "the new winner left the losers bracket");
  // Play the next winners match, then a correction of the first one must be refused.
  const next = (await matchesOf(t.id)).find((x) => x.bracket === "W" && x.round === 2 && (x.a_reg === m.b_reg || x.b_reg === m.b_reg))!;
  assert.equal(next.status, "ready");
  await officialResult(db, orgOwner, next.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  await rejects(correctResult(db, orgOwner, m.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "Try to rewrite history" }), "dependent_match_played");
});

test("leaderboard: weights, best-of-N, flags, review, deadline, completion and placements", async () => {
  const { t, players } = await setup(3, { format: "leaderboard", game: "pubg", bestOf: "2", submissionHours: "2", weights: { kills: "5", place1: "80" } });
  await rejects(createTournament(db, orgOwner, orgId, base({ format: "single_elimination", game: "pubg" })), "format_not_supported");
  await transition(db, orgOwner, t.id, "IN_PROGRESS");
  const [a, b, c] = players;
  await submitScore(db, a, t.id, { kills: 10, assists: 0, deaths: 1, headshots: 2, damage: 0, distance: 0, placement: "1", evidenceUrl: "https://example.test/replay", matchRef: "m-1" }); // 50+6+80 = 136
  await submitScore(db, a, t.id, { kills: 2, deaths: 1, headshots: 0, evidenceUrl: "https://example.test/replay", matchRef: "m-2" }); // 10
  await submitScore(db, a, t.id, { kills: 4, deaths: 1, headshots: 0, evidenceUrl: "https://example.test/replay", matchRef: "m-3" }); // 20
  await rejects(submitScore(db, a, t.id, { kills: 1, evidenceUrl: "https://example.test/replay", matchRef: "m-3" }), "duplicate_entry");
  for (const e of await db.query<{id:string}>("select id from score_entries where tournament_id=$1 and submitted_by=$2",[t.id,a.id])) await reviewScore(db,orgOwner,e.id,"approve","Reviewed replay",1);
  const flagged = await submitScore(db, b, t.id, { kills: 45, deaths: 1, headshots: 3, evidenceUrl: "https://example.test/replay", matchRef: "b-1" });
  assert.equal(flagged.review, "pending");
  assert.deepEqual(flagged.flags, ["kills_extreme"]);
  const impossible = await submitScore(db, c, t.id, { kills: 2, headshots: 5, deaths: 3, evidenceUrl: "https://example.test/replay", matchRef: "c-1" });
  assert.deepEqual(impossible.flags, ["headshots_exceed_kills"]);
  let table = await leaderboardStandings(db, { id: t.id, scoring: { kills: 5, place1: 80 }, best_of: 2 });
  const rowA = table.find((r) => r.name === a.displayName)!;
  assert.equal(rowA.points, 156, "best of 2: 136 + 20");
  assert.equal(table.find((r) => r.name === b.displayName)!.pending, 1);
  await rejects(transition(db, orgOwner, t.id, "COMPLETED"), "pending_reviews");
  const [pb] = await db.query<{ id: string }>("select id from score_entries where tournament_id = $1 and review = 'pending' and match_ref = 'b-1'", [t.id]);
  await reviewScore(db, orgOwner, pb.id, "approve", "Verified from the match replay",1);
  const [pc] = await db.query<{ id: string }>("select id from score_entries where tournament_id = $1 and review = 'pending'", [t.id]);
  await reviewScore(db, orgOwner, pc.id, "reject", "Impossible line",1);
  // Deadline passed: self-service closes, the organiser can still log.
  await db.query("update tournaments set submission_deadline = now() - interval '1 minute' where id = $1", [t.id]);
  await rejects(submitScore(db, c, t.id, { kills: 1, matchRef:"late-result", evidenceUrl:"https://example.test/replay" }), "submission_closed");
  const [cReg] = await db.query<{ id: string }>("select id from registrations where tournament_id = $1 and user_id = $2", [t.id, c.id]);
  await submitScore(db, orgOwner, t.id, { kills: 3, deaths: 1, registration: cReg.id, evidenceUrl: "https://example.test/replay", matchRef: "c-2" }, true);
  table = await leaderboardStandings(db, { id: t.id, scoring: { kills: 5, place1: 80 }, best_of: 2 });
  assert.equal(table[0].name, b.displayName, "approved 45 kills (225 pts) leads");
  await transition(db, orgOwner, t.id, "COMPLETED");
  const regs = await db.query<{ user_id: string; placement: number | null }>("select user_id, placement from registrations where tournament_id = $1 order by placement", [t.id]);
  assert.deepEqual(regs.map((r) => r.placement), [1, 2, 3]);
  assert.equal(regs[0].user_id, b.id);
});

test("region lock, co-organisers and waitlist promotion on disqualification", async () => {
  const t = await createTournament(db, orgOwner, orgId, base({ regionLock: "AE, SA", maxParticipants: 2 }));
  await rejects(createTournament(db, orgOwner, orgId, base({ regionLock: "XX" })), "invalid_country");
  await transition(db, orgOwner, t.id, "PUBLISHED");
  await transition(db, orgOwner, t.id, "REGISTRATION_OPEN");
  const noCountry = await mk(`nocountry${seq}`);
  const wrong = await mk(`wrong${seq}`, "RU");
  const ok1 = await mk(`okone${seq}`, "AE");
  const ok2 = await mk(`oktwo${seq}`, "SA");
  const ok3 = await mk(`okthree${seq}`, "AE");
  await rejects(register(db, noCountry, t.id), "country_required");
  await rejects(register(db, wrong, t.id), "region_locked");
  await register(db, ok1, t.id);
  await register(db, ok2, t.id);
  const w = await register(db, ok3, t.id);
  assert.equal(w.status, "waitlisted");
  // Co-organiser: can manage this tournament, cannot manage the co-organiser list.
  const co = await mk(`coorg${seq}`);
  const other = await mk(`other${seq}`);
  await rejects(addCoOrganizer(db, co, t.id, other.username), "forbidden");
  await addCoOrganizer(db, orgOwner, t.id, co.username);
  await rejects(addCoOrganizer(db, co, t.id, other.username), "forbidden");
  await rejects(removeCoOrganizer(db, co, t.id, co.id), "forbidden");
  const [r1] = await db.query<{ id: string }>("select id from registrations where tournament_id = $1 and user_id = $2", [t.id, ok1.id]);
  await disqualify(db, co, t.id, r1.id, "Smurf account confirmed");
  const [promoted] = await db.query<{ status: string }>("select status from registrations where id = $1", [w.id]);
  assert.equal(promoted.status, "registered", "waitlist promoted after disqualification");
  await removeCoOrganizer(db, orgOwner, t.id, co.id);
  await rejects(transition(db, co, t.id, "REGISTRATION_CLOSED"), "forbidden");
});

test("match check-in is informational and only for the two sides", async () => {
  const { t, players } = await setup(2);
  await transition(db, orgOwner, t.id, "IN_PROGRESS");
  const [m] = (await matchesOf(t.id)).filter((x) => x.status === "ready");
  const [ra] = await db.query<{ user_id: string }>("select user_id from registrations where id = $1", [m.a_reg]);
  const a = players.find((p) => p.id === ra.user_id)!;
  await matchCheckIn(db, a, m.id);
  await matchCheckIn(db, a, m.id);
  const outsider = await mk(`checkout${seq}`);
  await rejects(matchCheckIn(db, outsider, m.id), "not_participant");
  const [row] = await db.query<{ a_checked_in_at: Date | null; b_checked_in_at: Date | null }>("select a_checked_in_at, b_checked_in_at from matches where id = $1", [m.id]);
  assert.ok(row.a_checked_in_at);
  assert.equal(row.b_checked_in_at, null);
  // Not a gate: the organiser records the result without the other side checking in.
  await officialResult(db, orgOwner, m.id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" });
  assert.equal((await verifyAuditChain(db)).valid, true);
});
