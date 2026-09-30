import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg, createTeam } from "../src/server/teams.ts";
import { createTournament, register, transition, updateTournament, type TournamentInput } from "../src/server/tournaments.ts";
import { officialResult } from "../src/server/matches.ts";
import {
  circuitBySlug,
  circuitStandings,
  closeSeason,
  createCircuit,
  eventPoints,
  frozenStandings,
  lockCircuit,
  parsePointsTable,
  removeCircuitMember,
  seasonHistory,
  setCircuitMember,
  updateCircuit,
  type CircuitInput,
} from "../src/server/circuits.ts";
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

const circuitInput = (over: Partial<CircuitInput> = {}): CircuitInput => ({
  name: `Series ${++seq}`,
  season: "2026",
  game: "cs2",
  participantType: "solo",
  description: "",
  pointsTable: "100, 70, 50, 30",
  participationPoints: "10",
  qualifyTop: "2",
  divisions: "",
  promote: "",
  relegate: "",
  ...over,
});

const tInput = (over: Partial<TournamentInput> = {}): TournamentInput => ({
  name: `Stop ${++seq}`,
  game: "cs2",
  participantType: "solo",
  teamSize: 1,
  maxParticipants: 16,
  checkInRequired: "",
  region: "",
  startsAt: "2030-01-01T12:00",
  timeZone: "UTC",
  description: "",
  rules: "",
  ...over,
});

type M = { id: string; round: number; position: number; a_reg: string | null; b_reg: string | null; status: string };

let owner: SessionUser;
let orgId: string;

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  owner = await mk("circuitowner");
  orgId = (await createOrg(db, owner, { name: "Circuit Org", description: "" })).id;
});
test.after(async () => {
  await db.close();
});

/** Runs a linked event: registers the players in order, starts it and lets the stronger side (lower index) win. */
async function runEvent(players: SessionUser[], over: Partial<TournamentInput>) {
  const t = await createTournament(db, owner, orgId, tInput(over));
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  for (const p of players) await register(db, p, t.id);
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const strength = new Map<string, number>();
  const regs = await db.query<{ id: string; user_id: string }>("select id, user_id from registrations where tournament_id = $1", [t.id]);
  for (const r of regs) strength.set(r.id, players.length - players.findIndex((p) => p.id === r.user_id));
  for (let guard = 0; guard < 200; guard++) {
    const [m] = await db.query<M>("select * from matches where tournament_id = $1 and status = 'ready' order by round, position limit 1", [t.id]);
    if (!m) break;
    const aWins = strength.get(m.a_reg!)! > strength.get(m.b_reg!)!;
    await officialResult(db, owner, m.id, { scoreA: aWins ? 2 : 0, scoreB: aWins ? 0 : 2, evidenceUrl: "", note: "" });
  }
  const [row] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
  assert.equal(row.status, "COMPLETED");
  return t;
}

test("circuit points: weighted per event, shared places share points, qualification from the table", async () => {
  assert.equal(eventPoints([100, 70, 50, 30], 10, 2, 125), 88, "87.5 rounds half up");
  assert.equal(eventPoints([100, 70, 50, 30], 10, 7, 125), 13, "below the table: participation points, weighted");
  assert.equal(eventPoints([100, 70, 50, 30], 10, 1, 100), 100);
  assert.deepEqual(parsePointsTable("25; 18 15,12"), [25, 18, 15, 12]);
  await rejects(Promise.resolve().then(() => parsePointsTable("10, 20")), "invalid_points_table");
  await rejects(createCircuit(db, owner, orgId, circuitInput({ pointsTable: "10, 5", participationPoints: "6" })), "invalid_points_table");
  await rejects(createCircuit(db, owner, orgId, circuitInput({ game: "fortnite" })), "invalid_game");
  await rejects(createCircuit(db, owner, orgId, circuitInput({ promote: "1" })), "invalid_input");

  const c = await createCircuit(db, owner, orgId, circuitInput({ name: "Pro Series" }));
  const circuit = await lockCircuit(db, c.id);
  const P = await Promise.all(Array.from({ length: 5 }, (_, i) => mk(`cp${i + 1}`)));
  // Event 1, single elimination, ×1: P1 wins, P2 runner-up, P3 and P4 share third.
  await runEvent([P[0], P[1], P[2], P[3]], { circuit: { circuitId: c.id, circuitWeight: "100" } });
  // Event 2, round robin, ×2: P2 > P1 > P5.
  await runEvent([P[1], P[0], P[4]], { format: "round_robin", circuit: { circuitId: c.id, circuitWeight: "200" } });
  const table = (await circuitStandings(db, circuit)).get(1)!;
  const pts = Object.fromEntries(table.map((r) => [r.userId, r.points]));
  assert.equal(pts[P[0].id], 100 + 140);
  assert.equal(pts[P[1].id], 70 + 200);
  assert.equal(pts[P[2].id], 50, "shared third place earns the third row");
  assert.equal(pts[P[3].id], 50);
  assert.equal(pts[P[4].id], 100);
  assert.deepEqual(table.slice(0, 3).map((r) => r.userId), [P[1].id, P[0].id, P[4].id]);
  assert.deepEqual(table.filter((r) => r.qualified).map((r) => r.userId), [P[1].id, P[0].id], "top two qualify");
  assert.equal(table[0].titles, 1);
  assert.equal(table[0].events, 2);
  // The points table is locked once an event has completed; other fields stay editable.
  await rejects(updateCircuit(db, owner, c.id, circuitInput({ name: "Pro Series", pointsTable: "120, 70, 50, 30" })), "points_table_locked");
  await updateCircuit(db, owner, c.id, circuitInput({ name: "Pro Series Renamed" }));
  const page = await circuitBySlug(db, c.slug);
  assert.equal(page?.events.length, 2);
  assert.equal(page?.circuit.name, "Pro Series Renamed");

  // Qualification: a finals event admits only qualified entrants.
  const finals = await createTournament(db, owner, orgId, tInput({ circuit: { qualifierCircuitId: c.id } }));
  await transition(db, owner, finals.id, "PUBLISHED");
  await transition(db, owner, finals.id, "REGISTRATION_OPEN");
  await rejects(register(db, P[2], finals.id), "not_qualified");
  await register(db, P[0], finals.id);
  await register(db, P[1], finals.id);
  assert.equal((await circuitBySlug(db, c.slug))?.finals.length, 1);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("circuit links are validated: same space, game and entry type; a match format; frozen after registrations", async () => {
  const c = await createCircuit(db, owner, orgId, circuitInput({ qualifyTop: "0" }));
  await rejects(createTournament(db, owner, orgId, tInput({ game: "fortnite", format: "leaderboard", circuit: { circuitId: c.id } })), "circuit_mismatch");
  await rejects(createTournament(db, owner, orgId, tInput({ game: "lol", circuit: { circuitId: c.id } })), "circuit_mismatch");
  await rejects(createTournament(db, owner, orgId, tInput({ participantType: "team", teamSize: 2, circuit: { circuitId: c.id } })), "circuit_mismatch");
  await rejects(createTournament(db, owner, orgId, tInput({ circuit: { qualifierCircuitId: c.id } })), "circuit_mismatch", );
  const other = await mk(`otherorg${seq}`);
  const otherOrg = (await createOrg(db, other, { name: `Other ${seq}`, description: "" })).id;
  await rejects(createTournament(db, other, otherOrg, tInput({ circuit: { circuitId: c.id } })), "circuit_mismatch");
  // Linking is allowed before anyone registers and frozen after.
  const t = await createTournament(db, owner, orgId, tInput());
  await updateTournament(db, owner, t.id, { ...tInput({ name: "Linked Later" }), circuit: { circuitId: c.id, circuitWeight: "150" } });
  const [row] = await db.query<{ circuit_id: string; circuit_weight: number }>("select circuit_id, circuit_weight from tournaments where id = $1", [t.id]);
  assert.equal(row.circuit_id, c.id);
  assert.equal(row.circuit_weight, 150);
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  await register(db, await mk(`linked${seq}`), t.id);
  await rejects(updateTournament(db, owner, t.id, { ...tInput({ name: "Linked Later" }), circuit: { circuitId: "" } }), "not_editable");
  // Omitting the circuit fields keeps the link (older forms, API clients).
  await updateTournament(db, owner, t.id, tInput({ name: "Linked Later 2" }));
  const [kept] = await db.query<{ circuit_id: string }>("select circuit_id from tournaments where id = $1", [t.id]);
  assert.equal(kept.circuit_id, c.id);
  // Team circuits take team slugs as members.
  const teamCircuit = await createCircuit(db, owner, orgId, circuitInput({ participantType: "team", divisions: "2", promote: "1", relegate: "1", qualifyTop: "" }));
  const captain = await mk(`captain${seq}`);
  const team = await createTeam(db, captain, { name: `Circuit Team ${seq}`, tag: "CT", game: "cs2" });
  await setCircuitMember(db, owner, teamCircuit.id, team.slug, "2");
  const lolTeam = await createTeam(db, captain, { name: `Lol Team ${seq}`, tag: "LT", game: "lol" });
  await rejects(setCircuitMember(db, owner, teamCircuit.id, lolTeam.slug, "1"), "team_game_mismatch");
  await removeCircuitMember(db, owner, teamCircuit.id, team.slug);
  await rejects(removeCircuitMember(db, owner, teamCircuit.id, team.slug), "not_found");
});

test("divisions: entry by division, promotion and relegation at season close, frozen history and the next season", async () => {
  const c = await createCircuit(db, owner, orgId, circuitInput({ name: "League", pointsTable: "10, 6, 3", participationPoints: "0", qualifyTop: "1", divisions: "2", promote: "1", relegate: "1" }));
  const single = await createCircuit(db, owner, orgId, circuitInput());
  const U = await Promise.all(Array.from({ length: 7 }, (_, i) => mk(`lg${seq}_${i + 1}`)));
  await rejects(setCircuitMember(db, owner, single.id, U[0].username, "1"), "invalid_input");
  for (const [i, u] of U.slice(0, 6).entries()) await setCircuitMember(db, owner, c.id, u.username, i < 3 ? "1" : "2");
  await rejects(setCircuitMember(db, owner, c.id, U[0].username, "3"), "invalid_input");
  // Division 1 event: a non-member and a division 2 member are refused.
  const d1 = await createTournament(db, owner, orgId, tInput({ format: "round_robin", circuit: { circuitId: c.id, circuitDivision: "1" } }));
  await rejects(createTournament(db, owner, orgId, tInput({ circuit: { circuitId: c.id } })), "invalid_input");
  await transition(db, owner, d1.id, "PUBLISHED");
  await transition(db, owner, d1.id, "REGISTRATION_OPEN");
  await rejects(register(db, U[6], d1.id), "not_in_division");
  await rejects(register(db, U[3], d1.id), "not_in_division");
  // A forgotten draft blocks the close until it is cancelled.
  const draft = await createTournament(db, owner, orgId, tInput({ circuit: { circuitId: c.id, circuitDivision: "2" } }));
  await rejects(closeSeason(db, owner, c.id, {}), "circuit_open_events");
  await transition(db, owner, draft.id, "CANCELLED");
  await rejects(closeSeason(db, owner, c.id, {}), "circuit_open_events");
  await transition(db, owner, d1.id, "CANCELLED");
  // Play one event per division: the lower index is stronger.
  await runEvent(U.slice(0, 3), { format: "round_robin", circuit: { circuitId: c.id, circuitDivision: "1" } });
  await runEvent(U.slice(3, 6), { format: "swiss", circuit: { circuitId: c.id, circuitDivision: "2" } });
  const live = await circuitStandings(db, await lockCircuit(db, c.id));
  assert.deepEqual(live.get(1)!.map((r) => [r.userId, r.points, r.movement]), [
    [U[0].id, 10, "stayed"],
    [U[1].id, 6, "stayed"],
    [U[2].id, 3, "relegated"],
  ]);
  assert.deepEqual(live.get(2)!.map((r) => [r.userId, r.points, r.movement]), [
    [U[3].id, 10, "promoted"],
    [U[4].id, 6, "stayed"],
    [U[5].id, 3, "stayed"],
  ]);
  assert.deepEqual(live.get(1)!.filter((r) => r.qualified).map((r) => r.userId), [U[0].id]);
  await rejects(closeSeason(db, owner, c.id, { createNext: "on", nextSeason: "2026" }), "invalid_input");
  const res = await closeSeason(db, owner, c.id, { createNext: "on", nextSeason: "2027" });
  assert.ok(res.nextSlug);
  // The closed season is frozen exactly as it stood.
  const frozen = await frozenStandings(db, c.id);
  for (const d of [1, 2]) assert.deepEqual(frozen.get(d)!.map((r) => [r.userId, r.rank, r.points, r.movement, r.qualified]), live.get(d)!.map((r) => [r.userId, r.rank, r.points, r.movement, r.qualified]));
  await rejects(updateCircuit(db, owner, c.id, circuitInput({ name: "League" })), "circuit_closed");
  await rejects(setCircuitMember(db, owner, c.id, U[6].username, "1"), "circuit_closed");
  await rejects(closeSeason(db, owner, c.id, {}), "circuit_closed");
  await rejects(createTournament(db, owner, orgId, tInput({ circuit: { circuitId: c.id, circuitDivision: "1" } })), "circuit_mismatch");
  // Next season: members moved between divisions, with where they came from.
  const next = await circuitBySlug(db, res.nextSlug!);
  assert.equal(next?.previous?.slug, (await lockCircuit(db, c.id)).slug);
  const members = await db.query<{ user_id: string; division: number; source: string }>("select user_id, division, source from circuit_members where circuit_id = $1", [next!.circuit.id]);
  const where = Object.fromEntries(members.map((m) => [m.user_id, [m.division, m.source]]));
  assert.deepEqual(where[U[3].id], [1, "promoted"]);
  assert.deepEqual(where[U[2].id], [2, "relegated"]);
  assert.deepEqual(where[U[0].id], [1, "stayed"]);
  assert.deepEqual(where[U[5].id], [2, "stayed"]);
  // Players are told, and the passport keeps the season.
  const kinds = await db.query<{ user_id: string; kind: string }>("select user_id, kind from notifications where kind like 'circuit_%'");
  assert.ok(kinds.some((k) => k.user_id === U[3].id && k.kind === "circuit_promoted"));
  assert.ok(kinds.some((k) => k.user_id === U[2].id && k.kind === "circuit_relegated"));
  assert.ok(kinds.some((k) => k.user_id === U[0].id && k.kind === "circuit_qualified"));
  const history = await seasonHistory(db, { userId: U[2].id, teamId: null });
  assert.equal(history.length, 1);
  assert.equal(history[0].movement, "relegated");
  assert.equal(history[0].rank, 3);
  // A qualifier can point at a closed season: its frozen top qualifies.
  const finals = await createTournament(db, owner, orgId, tInput({ circuit: { qualifierCircuitId: c.id } }));
  await transition(db, owner, finals.id, "PUBLISHED");
  await transition(db, owner, finals.id, "REGISTRATION_OPEN");
  await rejects(register(db, U[1], finals.id), "not_qualified");
  await register(db, U[0], finals.id);
  assert.equal((await verifyAuditChain(db)).valid, true);
});
