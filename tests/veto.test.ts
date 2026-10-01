import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { cloneTournament, createTournament, matchCheckIn, register, transition, updateTournament, type TournamentInput } from "../src/server/tournaments.ts";
import { resetVeto, vetoFor, vetoMap } from "../src/server/veto.ts";
import { pauseMatch, resumeMatch } from "../src/server/liveops.ts";
import { gameDay } from "../src/server/gameday.ts";
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
const POOL = "Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf";
const base = (over: Partial<TournamentInput> = {}): TournamentInput => ({
  name: `Veto ${++seq}`,
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
  owner = await mk("vtowner");
  orgId = (await createOrg(db, owner, { name: "Veto Org", description: "" })).id;
});
test.after(async () => {
  await db.close();
});

async function started(tag: string, over: Partial<TournamentInput> = {}) {
  const t = await createTournament(db, owner, orgId, base({ mapPool: POOL, ...over }));
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  const players = await Promise.all([1, 2, 3, 4].map((i) => mk(`${tag}${i}`)));
  for (const p of players) await register(db, p, t.id);
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const [m] = await db.query<{ id: string; a_reg: string; b_reg: string }>("select id, a_reg, b_reg from matches where tournament_id = $1 and round = 1 order by position limit 1", [t.id]);
  const byReg = async (reg: string) => {
    const [r] = await db.query<{ user_id: string }>("select user_id from registrations where id = $1", [reg]);
    return players.find((p) => p.id === r.user_id)!;
  };
  return { t, m, a: await byReg(m.a_reg), b: await byReg(m.b_reg), players };
}

test("a Bo1 veto: six bans in turn, the last map is the decider; turns, maps and completion are enforced", async () => {
  const { t, m, a, b, players } = await started("vtb");
  const outsider = players.find((p) => p.id !== a.id && p.id !== b.id)!;
  let v = (await vetoFor(db, m.id, a.id))!;
  assert.equal(v.bestOf, 1);
  assert.deepEqual([v.state.turns.length, v.myTurn], [6, true]);
  assert.equal((await vetoFor(db, m.id, b.id))!.myTurn, false);
  // Game Day puts the veto before play once both sides are checked in.
  await matchCheckIn(db, a, m.id);
  await matchCheckIn(db, b, m.id);
  const step = async (u: SessionUser) => (await gameDay(db, u)).find((e) => e.tournament.id === t.id)!.step;
  assert.deepEqual(await step(a), { key: "veto_turn", action: "veto", deadline: null });
  assert.equal((await step(b)).key, "veto_wait");
  await rejects(vetoMap(db, b, m.id, "Alpha"), "not_your_turn");
  await rejects(vetoMap(db, outsider, m.id, "Alpha"), "not_your_turn");
  await rejects(vetoMap(db, a, m.id, "Zulu"), "invalid_input");
  await vetoMap(db, a, m.id, "Golf");
  await rejects(vetoMap(db, b, m.id, "Golf"), "invalid_input");
  assert.equal((await db.query("select 1 from notifications where user_id = $1 and kind = 'veto_turn'", [b.id])).length, 1, "the next side is told");
  for (const [u, map] of [[b, "Alpha"], [a, "Bravo"], [b, "Charlie"], [a, "Delta"]] as const) await vetoMap(db, u, m.id, map);
  const last = await vetoMap(db, b, m.id, "Echo");
  assert.equal(last.complete, true);
  assert.deepEqual(last.maps, [{ map: "Foxtrot", by: null }]);
  await rejects(vetoMap(db, a, m.id, "Foxtrot"), "veto_complete");
  assert.equal((await db.query("select 1 from notifications where user_id = $1 and kind = 'veto_done'", [a.id])).length, 1);
  assert.deepEqual(await step(a), { key: "play", action: "report", deadline: null });
  // The pool is frozen once a veto has started.
  await rejects(updateTournament(db, owner, t.id, base({ name: "Renamed", mapPool: "Alpha, Bravo" })), "not_editable");
  // A referee can reset it; a player cannot.
  await rejects(resetVeto(db, a, m.id, "Start over"), "forbidden");
  assert.deepEqual(await resetVeto(db, owner, m.id, "Wrong map list announced"), { changed: true });
  v = (await vetoFor(db, m.id, a.id))!;
  assert.deepEqual([v.state.done.length, v.myTurn], [0, true]);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("a Bo3 final gets picks; a paused match waits; copies keep the pool; no pool means no veto", async () => {
  const { t, m, a, b } = await started("vtp", { series: { seriesBestOf: "3" } } as Partial<TournamentInput>);
  assert.equal((await vetoFor(db, m.id, a.id))!.bestOf, 3);
  await pauseMatch(db, owner, m.id, "Lights out");
  await rejects(vetoMap(db, a, m.id, "Alpha"), "match_paused");
  await resumeMatch(db, owner, m.id);
  for (const [u, map] of [[a, "Alpha"], [b, "Bravo"], [a, "Charlie"], [b, "Delta"], [a, "Echo"]] as const) await vetoMap(db, u, m.id, map);
  const done = await vetoMap(db, b, m.id, "Foxtrot");
  assert.deepEqual(done.maps, [
    { map: "Charlie", by: "a" },
    { map: "Delta", by: "b" },
    { map: "Golf", by: null },
  ]);
  const copy = await cloneTournament(db, owner, t.id, { name: "Veto copy" });
  const [c] = await db.query<{ map_pool: string[] }>("select map_pool from tournaments where id = $1", [copy.id]);
  assert.deepEqual(c.map_pool, POOL.split(", "));
  // Without a pool there is no veto at all.
  const plain = await started("vtn", { mapPool: "" });
  assert.equal(await vetoFor(db, plain.m.id, plain.a.id), null);
  await rejects(vetoMap(db, plain.a, plain.m.id, "Alpha"), "veto_unavailable");
  await rejects(createTournament(db, owner, orgId, base({ mapPool: "Only one" })), "invalid_input");
});
