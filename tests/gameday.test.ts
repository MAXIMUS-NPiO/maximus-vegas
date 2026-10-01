import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg, createTeam } from "../src/server/teams.ts";
import { createTournament, matchCheckIn, register, transition, type TournamentInput } from "../src/server/tournaments.ts";
import { confirmResult, officialResult, submitResult } from "../src/server/matches.ts";
import { callReferee, closeRefereeCall, gameDay, refereeCalls } from "../src/server/gameday.ts";
import { tournamentHistory } from "../src/server/queries.ts";
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
  name: `Game Day ${++seq}`,
  game: "cs2",
  participantType: "solo",
  teamSize: 1,
  maxParticipants: 4,
  checkInRequired: "",
  region: "",
  startsAt: "2030-01-01T12:00",
  timeZone: "UTC",
  description: "",
  rules: "",
  ...over,
});

let owner: SessionUser;
let orgId: string;
test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  owner = await mk("gdowner");
  orgId = (await createOrg(db, owner, { name: "Game Day Org", description: "" })).id;
});
test.after(async () => {
  await db.close();
});

/** A started single-elimination event of four solo players; returns the players by match side. */
async function started(tag: string) {
  const t = await createTournament(db, owner, orgId, base());
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  const players = await Promise.all([1, 2, 3, 4].map((i) => mk(`${tag}${i}`)));
  for (const p of players) await register(db, p, t.id);
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const ms = await db.query<{ id: string; a_reg: string; b_reg: string }>(
    "select id, a_reg, b_reg from matches where tournament_id = $1 and round = 1 order by position",
    [t.id],
  );
  const byReg = async (reg: string) => {
    const [r] = await db.query<{ user_id: string }>("select user_id from registrations where id = $1", [reg]);
    return players.find((p) => p.id === r.user_id)!;
  };
  return { t, ms, a1: await byReg(ms[0].a_reg), b1: await byReg(ms[0].b_reg), a2: await byReg(ms[1].a_reg), b2: await byReg(ms[1].b_reg) };
}
const stepOf = async (u: SessionUser, tid: string) => (await gameDay(db, u)).find((e) => e.tournament.id === tid);
const notes = (userId: string, kind: string) => db.query("select data from notifications where user_id = $1 and kind = $2", [userId, kind]);

test("Game Day walks a player from check-in to the next match, elimination and the final place", async () => {
  const { t, ms, a1, b1, a2, b2 } = await started("gdw");
  const stranger = await mk("gdstranger");
  assert.deepEqual(await gameDay(db, stranger), [], "nothing for someone outside the event");
  let e = (await stepOf(a1, t.id))!;
  assert.equal(e.matchId, ms[0].id);
  assert.equal(e.leader, true);
  assert.deepEqual(e.step, { key: "check_in", action: "checkin", deadline: null });
  await matchCheckIn(db, a1, ms[0].id);
  assert.equal((await stepOf(a1, t.id))!.step.key, "opponent_check_in");
  await matchCheckIn(db, b1, ms[0].id);
  assert.equal((await stepOf(a1, t.id))!.step.key, "play");
  await submitResult(db, a1, ms[0].id, { scoreA: 2, scoreB: 0, evidenceUrl: "https://example.com/proof", note: "" });
  assert.equal((await stepOf(a1, t.id))!.step.key, "wait_confirm");
  assert.deepEqual((await stepOf(b1, t.id))!.step, { key: "confirm", action: "confirm", deadline: null });
  await confirmResult(db, b1, ms[0].id);
  // The winner's current match is the final, still waiting for the other semi-final.
  e = (await stepOf(a1, t.id))!;
  assert.notEqual(e.matchId, ms[0].id);
  assert.equal(e.step.key, "waiting_opponent");
  // The loser has nothing open and is out of a single-elimination bracket.
  e = (await stepOf(b1, t.id))!;
  assert.equal(e.matchId, ms[0].id, "the last match is kept for reference");
  assert.equal(e.step.key, "out");
  await officialResult(db, owner, ms[1].id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" });
  assert.equal((await stepOf(a1, t.id))!.step.key, "check_in", "the final is ready once both finalists are known");
  assert.equal((await stepOf(b2, t.id))!.step.key, "out");
  const [final] = await db.query<{ id: string; a_reg: string }>("select id, a_reg from matches where tournament_id = $1 and round = 2", [t.id]);
  const [aReg] = await db.query<{ id: string }>("select id from registrations where tournament_id = $1 and user_id = $2", [t.id, a1.id]);
  await officialResult(db, owner, final.id, { scoreA: final.a_reg === aReg.id ? 2 : 0, scoreB: final.a_reg === aReg.id ? 0 : 2, evidenceUrl: "", note: "" });
  e = (await stepOf(a1, t.id))!;
  assert.equal(e.tournament.status, "COMPLETED");
  assert.deepEqual([e.step.key, e.registration.placement], ["finished", 1]);
  assert.equal((await stepOf(a2, t.id))!.step.key, "finished");
});

test("referee calls: one open call per side, staff reply once, access and closed matches", async () => {
  const { t, ms, a1, b1, a2 } = await started("gdc");
  const stranger = await mk("gdcstranger");
  await rejects(callReferee(db, stranger, ms[0].id, "Let me in"), "not_participant");
  await rejects(callReferee(db, a2, ms[0].id, "Not my match"), "not_participant");
  await rejects(callReferee(db, a1, ms[0].id, "  "), "invalid_input");
  const first = await callReferee(db, a1, ms[0].id, "Opponent's client crashed at round 9");
  assert.equal(first.created, true);
  const again = await callReferee(db, a1, ms[0].id, "Still waiting");
  assert.deepEqual(again, { id: first.id, created: false }, "a repeated call returns the open one");
  assert.equal((await notes(owner.id, "referee_call")).length, 1, "staff are notified once per open call");
  const other = await callReferee(db, b1, ms[0].id, "Server lag");
  assert.equal(other.created, true, "each side has its own call");
  let calls = await refereeCalls(db, ms[0].id);
  assert.deepEqual(calls.map((c) => [c.side, c.status]).sort(), [["a", "open"], ["b", "open"]]);
  await rejects(closeRefereeCall(db, a1, first.id, "I fixed it"), "forbidden");
  assert.deepEqual(await closeRefereeCall(db, owner, first.id, "Coming to station 2"), { matchId: ms[0].id, closed: true });
  assert.deepEqual(await closeRefereeCall(db, owner, first.id, "Again"), { matchId: ms[0].id, closed: false });
  assert.equal((await notes(a1.id, "referee_call_closed")).length, 1, "the caller hears back once");
  calls = await refereeCalls(db, ms[0].id);
  const answered = calls.find((c) => c.id === first.id)!;
  assert.deepEqual([answered.status, answered.resolution, answered.resolved_by], ["resolved", "Coming to station 2", "gdowner"]);
  // After the answer the side may call again.
  assert.equal((await callReferee(db, a1, ms[0].id, "One more thing")).created, true);
  await officialResult(db, owner, ms[0].id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  await rejects(callReferee(db, b1, ms[0].id, "After the end"), "match_closed");
  const history = await tournamentHistory(db, t.id);
  assert.ok(history.some((h) => h.action === "match.referee_called"));
  assert.ok(history.some((h) => h.action === "match.referee_call_closed"));
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("a roster player who is not the leader sees Game Day and may call the referee, but acts only through the leader", async () => {
  const t = await createTournament(db, owner, orgId, base({ participantType: "team", teamSize: 2, maxParticipants: 2 }));
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  const caps = await Promise.all([1, 2].map((i) => mk(`gdcap${i}`)));
  const mates = await Promise.all([1, 2].map((i) => mk(`gdmate${i}`)));
  for (const i of [0, 1]) {
    const team = await createTeam(db, caps[i], { name: `Game Day Team ${i}`, tag: `GD${i}`, game: "cs2" });
    await db.query("insert into team_members (team_id, user_id) values ($1, $2)", [team.id, mates[i].id]);
    await register(db, caps[i], t.id, team.id);
  }
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const e = (await stepOf(mates[0], t.id))!;
  assert.ok(e.matchId);
  assert.equal(e.leader, false, "a roster player does not act for the team");
  assert.equal(e.step.key, "check_in");
  await rejects(matchCheckIn(db, mates[0], e.matchId!), "not_participant");
  assert.equal((await callReferee(db, mates[0], e.matchId!, "Our captain lost connection")).created, true);
  assert.equal((await stepOf(caps[0], t.id))!.leader, true);
});

test("groups then playoff: a player who did not reach the playoff is out, a qualifier plays on", async () => {
  const t = await createTournament(
    db,
    owner,
    orgId,
    base({
      format: "groups",
      settings: { groupCount: "2", groupAdvance: "1", playoffFormat: "single_elimination", pointsWin: "3", pointsDraw: "1", pointsLoss: "0" },
    } as Partial<TournamentInput>),
  );
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  const players = await Promise.all([1, 2, 3, 4].map((i) => mk(`gdg${i}`)));
  for (const p of players) await register(db, p, t.id);
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const groupMatches = await db.query<{ id: string }>("select id from matches where tournament_id = $1 and stage = 1 order by group_no, round, position", [t.id]);
  // Mid-group a loser waits for the stage to finish rather than being out.
  await officialResult(db, owner, groupMatches[0].id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  const [first] = await db.query<{ b_reg: string }>("select b_reg from matches where id = $1", [groupMatches[0].id]);
  const [lu] = await db.query<{ user_id: string }>("select user_id from registrations where id = $1", [first.b_reg]);
  const groupLoser = players.find((p) => p.id === lu.user_id)!;
  assert.equal((await stepOf(groupLoser, t.id))!.step.key, "waiting_round", "a group loss does not end the event before the stage is over");
  for (const m of groupMatches.slice(1)) await officialResult(db, owner, m.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  const [stage] = await db.query<{ stage: number }>("select stage from tournaments where id = $1", [t.id]);
  assert.equal(stage.stage, 2, "the playoff exists once the groups are finished");
  assert.equal((await stepOf(groupLoser, t.id))!.step.key, "out");
  const [finalist] = await db.query<{ user_id: string }>(
    "select r.user_id from matches m join registrations r on r.id = m.a_reg where m.tournament_id = $1 and m.stage = 2 limit 1",
    [t.id],
  );
  const qualifier = players.find((p) => p.id === finalist.user_id)!;
  const q = (await stepOf(qualifier, t.id))!;
  assert.notEqual(q.step.key, "out");
  assert.ok(q.matchId);
});
