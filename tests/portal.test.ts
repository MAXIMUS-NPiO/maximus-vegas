import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, signIn, sessionUser, changePassword, type SessionUser } from "../src/server/auth.ts";
import { createOrg, createTeam, inviteToTeam, respondToInvite, addOrgMember } from "../src/server/teams.ts";
import {
  createTournament,
  transition,
  register,
  withdraw,
  checkIn,
  setCheckInOpen,
  disqualify,
} from "../src/server/tournaments.ts";
import { submitResult, confirmResult, disputeResult, officialResult, correctResult, markNoShow } from "../src/server/matches.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { createApplication } from "../src/server/admin.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
const users = new Map<string, SessionUser>();

async function user(name: string): Promise<SessionUser> {
  if (users.has(name)) return users.get(name)!;
  const s = await signUp(db, {
    email: `${name}@example.com`,
    username: name,
    displayName: name.toUpperCase(),
    password: "correct horse battery",
    adult: "on",
    terms: "on",
  });
  const u = (await sessionUser(db, s.token))!;
  users.set(name, u);
  return u;
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}

const soon = () => {
  const d = new Date(Date.now() + 86400_000);
  return d.toISOString().slice(0, 16);
};

async function matches(tournamentId: string) {
  return db.query<{
    id: string; round: number; position: number; a_reg: string | null; b_reg: string | null;
    winner_reg: string | null; status: string; outcome: string | null; next_match_id: string | null;
  }>("select * from matches where tournament_id = $1 order by round, position", [tournamentId]);
}

async function leaderOf(regId: string): Promise<SessionUser> {
  const [r] = await db.query<{ username: string }>(
    "select u.username from registrations r join users u on u.id = r.user_id where r.id = $1",
    [regId],
  );
  return users.get(r.username)!;
}

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
});
test.after(async () => {
  await db.close();
});

test("accounts: sign-up, duplicate protection, sign-in, rate limiting and password change", async () => {
  const org = await user("organizer");
  assert.equal(org.username, "organizer");
  await rejects(signUp(db, { email: "organizer@example.com", username: "other", displayName: "Other", password: "correct horse battery", adult: "on", terms: "on" }), "email_taken");
  await rejects(signUp(db, { email: "x@example.com", username: "organizer", displayName: "Xx", password: "correct horse battery", adult: "on", terms: "on" }), "username_taken");
  await rejects(signUp(db, { email: "y@example.com", username: "young", displayName: "Young", password: "correct horse battery", adult: "", terms: "on" }), "adult_required");
  await rejects(signUp(db, { email: "z@example.com", username: "shorty", displayName: "Shorty", password: "short", adult: "on", terms: "on" }), "weak_password");
  const ok = await signIn(db, { login: "ORGANIZER", password: "correct horse battery" });
  assert.ok(ok.token);
  for (let i = 0; i < 8; i++) await rejects(signIn(db, { login: "organizer", password: "wrong password!" }), "invalid_credentials");
  await rejects(signIn(db, { login: "organizer", password: "correct horse battery" }), "too_many_attempts");
  const p = await user("pwchange");
  await rejects(changePassword(db, p, "bad", "new strong password"), "wrong_password");
  await changePassword(db, p, "correct horse battery", "new strong password");
  assert.ok((await signIn(db, { login: "pwchange", password: "new strong password" })).token);
});

test("solo tournament: registration, check-in, byes, results, dispute, correction, placements", async () => {
  const org = await user("organizer");
  const space = await createOrg(db, org, { name: "Dubai Open Series", description: "" });
  const t = await createTournament(db, org, space.id, {
    name: "Dubai Duel Cup",
    game: "cs2",
    participantType: "solo",
    teamSize: 1,
    maxParticipants: 16,
    checkInRequired: "on",
    region: "MENA",
    startsAt: soon(),
    timeZone: "Asia/Dubai",
    description: "",
    rules: "Best of one.",
  });
  const p1 = await user("player1");
  await rejects(register(db, p1, t.id), "registration_closed");
  await rejects(transition(db, p1, t.id, "PUBLISHED"), "forbidden");
  await rejects(transition(db, org, t.id, "IN_PROGRESS"), "invalid_transition");
  await transition(db, org, t.id, "PUBLISHED");
  await transition(db, org, t.id, "REGISTRATION_OPEN");
  const players: SessionUser[] = [];
  for (let i = 1; i <= 6; i++) players.push(await user(`player${i}`));
  for (const p of players) await register(db, p, t.id);
  await rejects(register(db, players[0], t.id), "already_registered");
  await rejects(checkIn(db, players[0], t.id), "check_in_closed");
  await setCheckInOpen(db, org, t.id, true);
  for (const p of players.slice(0, 5)) await checkIn(db, p, t.id);
  await checkIn(db, players[0], t.id); // idempotent
  await transition(db, org, t.id, "REGISTRATION_CLOSED");
  await transition(db, org, t.id, "IN_PROGRESS");
  const [notChecked] = await db.query<{ status: string }>(
    "select r.status from registrations r where r.user_id = $1 and r.tournament_id = $2",
    [players[5].id, t.id],
  );
  assert.equal(notChecked.status, "not_checked_in");

  let ms = await matches(t.id);
  assert.equal(ms.length, 7, "5 participants → bracket of 8 → 7 matches");
  const byes = ms.filter((m) => m.round === 1 && m.outcome === "bye");
  assert.equal(byes.length, 3);
  const r1Ready = ms.filter((m) => m.round === 1 && m.status === "ready");
  assert.equal(r1Ready.length, 1);

  // Round 1 played match: A reports, B confirms; confirming twice is rejected.
  const m1 = r1Ready[0];
  const a = await leaderOf(m1.a_reg!);
  const b = await leaderOf(m1.b_reg!);
  await rejects(submitResult(db, a, m1.id, { scoreA: 13, scoreB: 13, evidenceUrl: "", note: "" }), "draw_not_allowed");
  await rejects(submitResult(db, players[5], m1.id, { scoreA: 13, scoreB: 7, evidenceUrl: "", note: "" }), "not_participant");
  await submitResult(db, a, m1.id, { scoreA: 13, scoreB: 7, evidenceUrl: "https://example.com/demo", note: "" });
  await rejects(confirmResult(db, a, m1.id), "own_result");
  await confirmResult(db, b, m1.id);
  await rejects(confirmResult(db, b, m1.id), "already_completed");

  ms = await matches(t.id);
  const semis = ms.filter((m) => m.round === 2);
  assert.ok(semis.every((m) => m.status === "ready"), "both semi-finals ready after byes and first result");

  // Semi-final 1: dispute resolved by the organiser.
  const s1 = semis[0];
  const s1a = await leaderOf(s1.a_reg!);
  const s1b = await leaderOf(s1.b_reg!);
  await submitResult(db, s1a, s1.id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" });
  await disputeResult(db, s1b, s1.id, "Score was 1-2, screenshot attached");
  await rejects(officialResult(db, s1a, s1.id, { scoreA: 1, scoreB: 2, evidenceUrl: "", note: "" }), "forbidden");
  await officialResult(db, org, s1.id, { scoreA: 1, scoreB: 2, evidenceUrl: "", note: "Reviewed evidence", resolution: "Evidence supports B" });
  const [dispute] = await db.query<{ status: string }>("select status from disputes where match_id = $1", [s1.id]);
  assert.equal(dispute.status, "resolved");

  // Correction before the dependent match is played swaps the finalist.
  await correctResult(db, org, s1.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "Referee report corrected" });
  let final = (await matches(t.id)).find((m) => m.round === 3)!;
  assert.equal(final.a_reg, s1.a_reg);

  // Semi-final 2: both sides report the same score → confirmed automatically.
  const s2 = semis[1];
  await submitResult(db, await leaderOf(s2.a_reg!), s2.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  await submitResult(db, await leaderOf(s2.b_reg!), s2.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  final = (await matches(t.id)).find((m) => m.round === 3)!;
  assert.equal(final.status, "ready");

  // Correcting a semi-final whose final has a reported result is refused.
  await submitResult(db, await leaderOf(final.a_reg!), final.id, { scoreA: 16, scoreB: 10, evidenceUrl: "", note: "" });
  await rejects(correctResult(db, org, s2.id, { scoreA: 0, scoreB: 2, evidenceUrl: "", note: "Late correction" }), "dependent_match_played");
  await confirmResult(db, await leaderOf(final.b_reg!), final.id);

  const [done] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
  assert.equal(done.status, "COMPLETED");
  const places = await db.query<{ placement: number | null }>(
    "select placement from registrations where tournament_id = $1 and status = 'registered' order by placement nulls last",
    [t.id],
  );
  assert.deepEqual(places.map((p) => p.placement), [1, 2, 3, 3, 5]);
});

test("waitlist promotion, no-show and disqualification walkovers", async () => {
  const org = await user("organizer");
  const [space] = await db.query<{ id: string }>("select id from organizations limit 1");
  const t = await createTournament(db, org, space.id, {
    name: "Small Cup", game: "cs2", participantType: "solo", teamSize: 1, maxParticipants: 4,
    checkInRequired: "", region: "", startsAt: soon(), timeZone: "UTC", description: "", rules: "",
  });
  await transition(db, org, t.id, "PUBLISHED");
  await transition(db, org, t.id, "REGISTRATION_OPEN");
  const ps: SessionUser[] = [];
  for (let i = 1; i <= 5; i++) ps.push(await user(`small${i}`));
  const results = [];
  for (const p of ps) results.push(await register(db, p, t.id));
  assert.equal(results[4].status, "waitlisted");
  await withdraw(db, ps[0], t.id);
  const [promoted] = await db.query<{ status: string }>("select status from registrations where id = $1", [results[4].id]);
  assert.equal(promoted.status, "registered");
  await transition(db, org, t.id, "REGISTRATION_CLOSED");
  await transition(db, org, t.id, "IN_PROGRESS");
  const ms = await matches(t.id);
  const [m1, m2] = ms.filter((m) => m.round === 1);
  await markNoShow(db, org, m1.id, "b");
  const [r1] = await db.query<{ outcome: string; winner_reg: string }>("select outcome, winner_reg from matches where id = $1", [m1.id]);
  assert.equal(r1.outcome, "no_show");
  assert.equal(r1.winner_reg, m1.a_reg);
  await disqualify(db, org, t.id, m2.a_reg!, "Rule 4.2 violation");
  const final = (await matches(t.id)).find((m) => m.round === 2)!;
  assert.equal(final.status, "ready");
  assert.equal(final.b_reg, m2.b_reg);
});

test("teams: invitations, team registration and roster conflicts", async () => {
  const org = await user("organizer");
  const [space] = await db.query<{ id: string }>("select id from organizations limit 1");
  const cap = await user("captain1");
  const mate = await user("mate1");
  const cap2 = await user("captain2");
  const team = await createTeam(db, cap, { name: "Falcons Test", tag: "fal", game: "cs2" });
  const invite = await inviteToTeam(db, cap, team.id, "mate1");
  await rejects(inviteToTeam(db, cap, team.id, "mate1"), "already_invited");
  await respondToInvite(db, mate, invite.id, true);
  const team2 = await createTeam(db, cap2, { name: "Second Team", tag: "", game: "cs2" });
  const inv2 = await inviteToTeam(db, cap2, team2.id, "mate1");
  await respondToInvite(db, mate, inv2.id, true);
  const t = await createTournament(db, org, space.id, {
    name: "Duo Cup", game: "cs2", participantType: "team", teamSize: 2, maxParticipants: 8,
    checkInRequired: "", region: "", startsAt: soon(), timeZone: "UTC", description: "", rules: "",
  });
  await transition(db, org, t.id, "PUBLISHED");
  await transition(db, org, t.id, "REGISTRATION_OPEN");
  await rejects(register(db, mate, t.id, team.id), "not_team_leader");
  await rejects(register(db, cap, t.id), "wrong_participant_type");
  await register(db, cap, t.id, team.id);
  await rejects(register(db, cap2, t.id, team2.id), "roster_conflict");
  const other = await createTeam(db, cap2, { name: "Valorant Squad", tag: "", game: "valorant" });
  await rejects(register(db, cap2, t.id, other.id), "team_game_mismatch");
});

test("organiser staff roles and partner applications", async () => {
  const org = await user("organizer");
  const ref = await user("referee1");
  const [space] = await db.query<{ id: string }>("select id from organizations limit 1");
  await addOrgMember(db, org, space.id, "referee1", "referee");
  await rejects(addOrgMember(db, ref, space.id, "player1", "admin"), "forbidden");
  const id = await createApplication(db, { kind: "partner", name: "Club Owner", email: "club@example.com", company: "Arena", message: "We run a venue", lang: "ru", consent: "on" }, null);
  assert.ok(id);
  await rejects(createApplication(db, { kind: "casino", name: "x", email: "x@example.com", company: "", message: "", lang: "ru", consent: "on" }, null), "invalid_input");
});

test("audit chain verifies and detects tampering", async () => {
  const before = await verifyAuditChain(db);
  assert.equal(before.valid, true);
  assert.ok(before.records > 20);
  await db.query("update audit_log set data = '{\"tampered\":true}' where id = (select min(id) + 3 from audit_log)");
  const after = await verifyAuditChain(db);
  assert.equal(after.valid, false);
});
