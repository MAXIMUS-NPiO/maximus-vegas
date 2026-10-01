import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { createTournament, register, transition, type TournamentInput } from "../src/server/tournaments.ts";
import { correctResult, officialResult } from "../src/server/matches.ts";
import { previewRepair, repairBracket } from "../src/server/repair.ts";
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
  name: `Repair ${++seq}`,
  game: "cs2",
  participantType: "solo",
  teamSize: 1,
  maxParticipants: 8,
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
  owner = await mk("rpowner");
  orgId = (await createOrg(db, owner, { name: "Repair Org", description: "" })).id;
});
test.after(async () => {
  await db.close();
});

type M = { id: string; round: number; position: number; a_reg: string | null; b_reg: string | null; winner_reg: string | null; status: string };
/** Positions are numbered from 1 here; the engine stores them from 0. */
const matchAt = async (tid: string, round: number, position: number) =>
  (await db.query<M>("select id, round, position, a_reg, b_reg, winner_reg, status from matches where tournament_id = $1 and bracket = 'W' and round = $2 and position = $3", [tid, round, position - 1]))[0];
/** Decides a match for side A (2:0) as the referee. */
const winA = (id: string) => officialResult(db, owner, id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });

async function started(tag: string, n: number) {
  const t = await createTournament(db, owner, orgId, base({ maxParticipants: n }));
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  const players = await Promise.all(Array.from({ length: n }, (_, i) => mk(`${tag}${i}`)));
  for (const p of players) await register(db, p, t.id);
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  return { t, players };
}

test("repair after the semi-final was played: preview, stale plan refused, replay, then the event finishes", async () => {
  const { t, players } = await started("rps", 8);
  for (let p = 1; p <= 4; p++) await winA((await matchAt(t.id, 1, p)).id);
  const qf1 = await matchAt(t.id, 1, 1);
  const sf1 = await matchAt(t.id, 2, 1);
  await winA(sf1.id);
  // The plain correction is blocked by the played semi-final.
  await rejects(correctResult(db, owner, qf1.id, { scoreA: 0, scoreB: 2, evidenceUrl: "", note: "Wrong side entered" }), "dependent_match_played");
  const plan = await previewRepair(db, qf1.id, { scoreA: 0, scoreB: 2 });
  assert.deepEqual(plan.steps.map((s) => `${s.kind}:${s.matchId}`), [`replay:${sf1.id}`, `replace:${(await matchAt(t.id, 3, 1)).id}`]);
  const player = players[0];
  await rejects(repairBracket(db, player, qf1.id, { scoreA: 0, scoreB: 2, note: "Not a referee", plan: plan.hash }), "forbidden");
  await rejects(repairBracket(db, owner, qf1.id, { scoreA: 0, scoreB: 2, note: "x", plan: plan.hash }), "invalid_input");
  await rejects(repairBracket(db, owner, qf1.id, { scoreA: 0, scoreB: 2, note: "Demo shows B won", plan: "0000" }), "repair_plan_changed");
  await repairBracket(db, owner, qf1.id, { scoreA: 0, scoreB: 2, note: "Demo shows B won", plan: plan.hash });
  const after = { qf1: await matchAt(t.id, 1, 1), sf1: await matchAt(t.id, 2, 1), f: await matchAt(t.id, 3, 1) };
  assert.equal(after.qf1.winner_reg, qf1.b_reg);
  assert.deepEqual([after.sf1.a_reg, after.sf1.status, after.sf1.winner_reg], [qf1.b_reg, "ready", null], "the semi-final is replayed with the corrected winner");
  assert.deepEqual([after.f.a_reg, after.f.status], [null, "pending"], "the final waits for the replayed semi-final");
  const versions = await db.query<{ status: string }>("select status from match_results where match_id = $1", [sf1.id]);
  assert.ok(versions.length && versions.every((r) => r.status === "superseded"), "the semi-final's result is kept as superseded, not deleted");
  const [n] = await db.query<{ n: number }>("select count(*)::int as n from notifications where kind = 'bracket_repaired'");
  assert.ok(n.n >= 3, "entrants of the corrected and affected matches are told");
  // The repaired bracket plays to the end.
  await winA(after.sf1.id);
  await winA((await matchAt(t.id, 2, 2)).id);
  await winA((await matchAt(t.id, 3, 1)).id);
  const [ts] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
  assert.equal(ts.status, "COMPLETED");
  const [champion] = await db.query<{ id: string }>("select id from registrations where tournament_id = $1 and placement = 1", [t.id]);
  assert.equal(champion.id, qf1.b_reg, "the corrected winner went on to win");
  const [log] = await db.query<{ data: { plan: string; steps: unknown[] } }>("select data from audit_log where action = 'match.bracket_repaired' and entity_id = $1", [qf1.id]);
  assert.equal(log.data.plan, plan.hash);
  assert.equal(log.data.steps.length, 2);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("repair of a finished event reopens it and settles the places again after the new final", async () => {
  const { t } = await started("rpf", 4);
  await winA((await matchAt(t.id, 1, 1)).id);
  await winA((await matchAt(t.id, 1, 2)).id);
  await winA((await matchAt(t.id, 2, 1)).id);
  let [ts] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
  assert.equal(ts.status, "COMPLETED");
  const sf1 = await matchAt(t.id, 1, 1);
  const plan = await previewRepair(db, sf1.id, { scoreA: 1, scoreB: 2 });
  assert.equal(plan.reopens, true);
  await repairBracket(db, owner, sf1.id, { scoreA: 1, scoreB: 2, note: "Referee report: B won", plan: plan.hash });
  [ts] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
  assert.equal(ts.status, "IN_PROGRESS");
  const [placed] = await db.query<{ n: number }>("select count(*)::int as n from registrations where tournament_id = $1 and placement is not null", [t.id]);
  assert.equal(placed.n, 0, "places wait for the new final");
  const final = await matchAt(t.id, 2, 1);
  assert.deepEqual([final.a_reg, final.status], [sf1.b_reg, "ready"]);
  await winA(final.id);
  [ts] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
  assert.equal(ts.status, "COMPLETED");
  const [champion] = await db.query<{ id: string }>("select id from registrations where tournament_id = $1 and placement = 1", [t.id]);
  assert.equal(champion.id, sf1.b_reg);
});

test("a repair with nothing to replay is the ordinary correction", async () => {
  const { t } = await started("rpo", 4);
  const sf1 = await matchAt(t.id, 1, 1);
  await winA(sf1.id);
  const plan = await previewRepair(db, sf1.id, { scoreA: 0, scoreB: 2 });
  assert.deepEqual(plan.steps.map((s) => s.kind), ["replace"]);
  await repairBracket(db, owner, sf1.id, { scoreA: 0, scoreB: 2, note: "Scores were swapped", plan: plan.hash });
  assert.equal((await matchAt(t.id, 2, 1)).a_reg, sf1.b_reg);
  const [log] = await db.query<{ n: number }>("select count(*)::int as n from audit_log where action = 'match.result_corrected' and entity_id = $1", [sf1.id]);
  assert.equal(log.n, 1, "recorded as a correction");
});
