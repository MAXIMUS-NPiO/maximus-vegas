import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { addOrgMember, createOrg } from "../src/server/teams.ts";
import { createTournament, matchCheckIn, register, transition, type TournamentInput } from "../src/server/tournaments.ts";
import { confirmResult, markNoShow, officialResult, submitResult } from "../src/server/matches.ts";
import { callReferee } from "../src/server/gameday.ts";
import {
  assignIncident,
  escalateIncident,
  incidentQueue,
  openIncident,
  overdue,
  pauseMatch,
  resolveIncident,
  resumeMatch,
  setIncidentPriority,
} from "../src/server/liveops.ts";
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
  name: `Live Ops ${++seq}`,
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
const notes = (userId: string, kind: string) => db.query("select data from notifications where user_id = $1 and kind = $2", [userId, kind]);

let owner: SessionUser, admin: SessionUser, ref: SessionUser, stranger: SessionUser;
let orgId: string;
test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  owner = await mk("loowner");
  admin = await mk("loadmin");
  ref = await mk("loref");
  stranger = await mk("lostranger");
  orgId = (await createOrg(db, owner, { name: "Live Ops Org", description: "" })).id;
  await addOrgMember(db, owner, orgId, admin.username, "admin");
  await addOrgMember(db, owner, orgId, ref.username, "referee");
});
test.after(async () => {
  await db.close();
});

async function started(tag: string) {
  const t = await createTournament(db, owner, orgId, base());
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  const players = await Promise.all([1, 2, 3, 4].map((i) => mk(`${tag}${i}`)));
  for (const p of players) await register(db, p, t.id);
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const ms = await db.query<{ id: string; a_reg: string; b_reg: string }>("select id, a_reg, b_reg from matches where tournament_id = $1 and round = 1 order by position", [t.id]);
  const byReg = async (reg: string) => {
    const [r] = await db.query<{ user_id: string }>("select user_id from registrations where id = $1", [reg]);
    return players.find((p) => p.id === r.user_id)!;
  };
  return { t, ms, a: await byReg(ms[0].a_reg), b: await byReg(ms[0].b_reg), c: await byReg(ms[1].a_reg), d: await byReg(ms[1].b_reg) };
}

test("incident queue: staff log, assign, prioritise, escalate and resolve; order and access", async () => {
  const { t, ms, a } = await started("loq");
  await rejects(openIncident(db, stranger, t.id, { kind: "technical", message: "Not staff" }), "forbidden");
  await rejects(openIncident(db, a, t.id, { kind: "technical", message: "Players use the referee call" }), "forbidden");
  await rejects(openIncident(db, ref, t.id, { kind: "referee_call", message: "Kind reserved for participants" }), "invalid_input");
  await rejects(openIncident(db, ref, t.id, { kind: "technical", priority: "panic", message: "Bad priority" }), "invalid_input");
  const low = await openIncident(db, ref, t.id, { kind: "other", priority: "low", message: "Lights flicker in hall B" });
  const tech = await openIncident(db, admin, t.id, { kind: "technical", matchId: ms[0].id, message: "Station 3 lost network" });
  const urgent = await openIncident(db, ref, t.id, { kind: "conduct", priority: "urgent", matchId: ms[1].id, message: "Abusive chat reported" });
  let q = await incidentQueue(db, t.id);
  assert.deepEqual(q.open.map((i) => i.id), [urgent.id, tech.id, low.id], "urgent first, then normal, then low");
  assert.equal(q.open.find((i) => i.id === tech.id)!.assigned_to, "loadmin", "the reporter holds what they logged");
  // Assignment: only the event's staff; the new assignee hears about it.
  await rejects(assignIncident(db, ref, tech.id, stranger.id), "invalid_input");
  assert.deepEqual(await assignIncident(db, ref, tech.id, ref.id), { changed: true });
  assert.deepEqual(await assignIncident(db, ref, tech.id, "me"), { changed: false });
  assert.equal((await notes(ref.id, "incident_assigned")).length, 0, "taking an incident yourself notifies nobody");
  assert.deepEqual(await assignIncident(db, ref, low.id, admin.id), { changed: true });
  assert.equal((await notes(admin.id, "incident_assigned")).length, 1);
  assert.deepEqual(await assignIncident(db, ref, low.id, ""), { changed: true }, "an assignee can be cleared");
  await rejects(setIncidentPriority(db, ref, low.id, "panic"), "invalid_input");
  assert.deepEqual(await setIncidentPriority(db, ref, low.id, "high"), { changed: true });
  q = await incidentQueue(db, t.id);
  assert.deepEqual(q.open.map((i) => i.id), [urgent.id, low.id, tech.id]);
  // Escalation reaches the space's owner and administrator, except the one escalating; once.
  assert.deepEqual(await escalateIncident(db, ref, low.id, "Need the venue manager"), { escalated: true });
  assert.deepEqual(await escalateIncident(db, ref, low.id, "Again"), { escalated: false });
  assert.equal((await notes(owner.id, "incident_escalated")).length, 1);
  assert.equal((await notes(admin.id, "incident_escalated")).length, 1);
  q = await incidentQueue(db, t.id);
  assert.equal(q.open.find((i) => i.id === low.id)!.priority, "urgent", "escalation raises the priority");
  assert.equal(q.open[0].id, low.id, "an escalated urgent incident comes first");
  // Resolution: the reporter hears back once; a resolved incident is closed for changes.
  assert.deepEqual(await resolveIncident(db, ref, tech.id, "Cable replaced"), { matchId: ms[0].id, closed: true });
  assert.deepEqual(await resolveIncident(db, ref, tech.id, "Again"), { matchId: ms[0].id, closed: false });
  assert.equal((await notes(admin.id, "incident_resolved")).length, 1);
  await rejects(assignIncident(db, ref, tech.id, "me"), "not_editable");
  await rejects(resolveIncident(db, a, urgent.id, "Not staff"), "forbidden");
  q = await incidentQueue(db, t.id);
  assert.deepEqual(q.resolved.map((i) => [i.id, i.resolution, i.resolved_by]), [[tech.id, "Cable replaced", "loref"]]);
  const history = await tournamentHistory(db, t.id);
  for (const action of ["tournament.incident_opened", "tournament.incident_assigned", "tournament.incident_priority", "tournament.incident_escalated", "tournament.incident_resolved"])
    assert.ok(history.some((h) => h.action === action), action);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("a call repeated after the answer time escalates once; the queue marks unanswered calls", async () => {
  const { t, ms, a } = await started("loe");
  const call = await callReferee(db, a, ms[0].id, "Opponent left the server");
  assert.deepEqual(await callReferee(db, a, ms[0].id, "Still nothing"), { id: call.id, created: false, escalated: false }, "too early to escalate");
  let [item] = (await incidentQueue(db, t.id)).open;
  assert.equal(overdue(item), false);
  await db.query("update incidents set created_at = now() - interval '10 minutes' where id = $1", [call.id]);
  [item] = (await incidentQueue(db, t.id)).open;
  assert.equal(overdue(item), true, "unassigned for longer than the answer time");
  assert.deepEqual(await callReferee(db, a, ms[0].id, "Please, anyone"), { id: call.id, created: false, escalated: true });
  assert.deepEqual(await callReferee(db, a, ms[0].id, "Again"), { id: call.id, created: false, escalated: false }, "escalated only once");
  assert.equal((await notes(owner.id, "incident_escalated")).filter((n) => (n.data as { matchId?: string }).matchId === ms[0].id).length, 1);
  await assignIncident(db, ref, call.id, "me");
  [item] = (await incidentQueue(db, t.id)).open;
  assert.equal(overdue(item), false, "an assigned call is not overdue");
  assert.equal((await resolveIncident(db, ref, call.id, "Rejoined; restart from round 7")).closed, true);
  assert.equal((await notes(a.id, "referee_call_closed")).length, 1, "a call resolved from the queue answers the caller");
});

test("pause holds results, confirmations, check-ins and no-shows until resumed or decided", async () => {
  const { ms, a, b } = await started("lop");
  await rejects(pauseMatch(db, a, ms[0].id, "I want a break"), "forbidden");
  await rejects(pauseMatch(db, ref, ms[0].id, "x"), "invalid_input");
  assert.deepEqual(await pauseMatch(db, ref, ms[0].id, "Server restart"), { changed: true });
  assert.deepEqual(await pauseMatch(db, ref, ms[0].id, "Server restart"), { changed: false });
  assert.equal((await notes(b.id, "match_paused")).length, 1);
  await rejects(matchCheckIn(db, a, ms[0].id), "match_paused");
  await rejects(submitResult(db, a, ms[0].id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" }), "match_paused");
  await rejects(markNoShow(db, ref, ms[0].id, "b"), "match_paused");
  assert.deepEqual(await resumeMatch(db, ref, ms[0].id), { changed: true });
  assert.deepEqual(await resumeMatch(db, ref, ms[0].id), { changed: false });
  assert.equal((await notes(a.id, "match_resumed")).length, 1);
  await submitResult(db, a, ms[0].id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  await pauseMatch(db, ref, ms[0].id, "Checking the demo");
  await rejects(confirmResult(db, b, ms[0].id), "match_paused");
  // A referee decision ends the hold; it agrees with the reported score, so no reason is needed.
  await officialResult(db, ref, ms[0].id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  const [m] = await db.query<{ status: string; paused_at: Date | null }>("select status, paused_at from matches where id = $1", [ms[0].id]);
  assert.deepEqual([m.status, m.paused_at], ["completed", null]);
  await rejects(pauseMatch(db, ref, ms[0].id, "Too late"), "match_not_ready");
});

test("a decision against the reported score or on a disputed match needs a documented reason", async () => {
  const { ms, a, c, d } = await started("loo");
  await submitResult(db, a, ms[0].id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  await rejects(officialResult(db, ref, ms[0].id, { scoreA: 0, scoreB: 2, evidenceUrl: "", note: "" }), "override_reason_required");
  await officialResult(db, ref, ms[0].id, { scoreA: 0, scoreB: 2, evidenceUrl: "", note: "", resolution: "Demo shows side B won both maps" } as never);
  const [audit] = await db.query<{ data: Record<string, unknown> }>(
    "select data from audit_log where action = 'match.official_result' and entity_id = $1 order by id desc limit 1",
    [ms[0].id],
  );
  assert.equal(audit.data.override, true);
  assert.equal(audit.data.reason, "Demo shows side B won both maps");
  // Conflicting reports open a dispute; settling it needs a reason too.
  await submitResult(db, c, ms[1].id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" });
  await submitResult(db, d, ms[1].id, { scoreA: 1, scoreB: 2, evidenceUrl: "", note: "" });
  const [disputed] = await db.query<{ status: string }>("select status from matches where id = $1", [ms[1].id]);
  assert.equal(disputed.status, "disputed");
  await rejects(officialResult(db, ref, ms[1].id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" }), "override_reason_required");
  await officialResult(db, ref, ms[1].id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "", resolution: "Server log confirms A" } as never);
  assert.equal((await verifyAuditChain(db)).valid, true);
});
