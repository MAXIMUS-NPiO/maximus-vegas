import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { createTournament, register, transition } from "../src/server/tournaments.ts";
import { confirmResult, submitResult } from "../src/server/matches.ts";
import { verifyAuditChain } from "../src/server/audit.ts";

// Runs against a real multi-connection PostgreSQL: PG_TEST_URL=postgres://… npm test
const url = process.env.PG_TEST_URL;

test("concurrent registrations, confirmations and audit writes stay consistent", { skip: !url }, async () => {
  const db: Database = await openDatabase({ url });
  const run = Date.now().toString(36);
  const mk = async (name: string): Promise<SessionUser> => {
    const s = await signUp(db, { email: `${name}${run}@example.com`, username: `${name}${run}`.slice(0, 24), displayName: name, password: "correct horse battery", adult: "on", terms: "on" });
    return (await sessionUser(db, s.token))!;
  };
  const org = await mk("co");
  const space = await createOrg(db, org, { name: `Conc ${run}`, description: "" });
  const t = await createTournament(db, org, space.id, {
    name: `Conc Cup ${run}`, game: "cs2", participantType: "solo", teamSize: 1, maxParticipants: 8,
    checkInRequired: "", region: "", startsAt: "2030-01-01T12:00", timeZone: "UTC", description: "", rules: "",
  });
  await transition(db, org, t.id, "PUBLISHED");
  await transition(db, org, t.id, "REGISTRATION_OPEN");
  const players = await Promise.all(Array.from({ length: 12 }, (_, i) => mk(`cp${i}`)));
  // 12 players race for 8 slots, each also double-submits.
  const results = await Promise.allSettled(players.flatMap((p) => [register(db, p, t.id), register(db, p, t.id)]));
  const ok = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ status: string }>).value);
  assert.equal(ok.length, 12, "exactly one entry per player");
  assert.equal(ok.filter((r) => r.status === "registered").length, 8, "capacity respected under contention");
  assert.equal(ok.filter((r) => r.status === "waitlisted").length, 4);
  await transition(db, org, t.id, "REGISTRATION_CLOSED");
  await transition(db, org, t.id, "IN_PROGRESS");
  const [m] = await db.query<{ id: string; a_reg: string; b_reg: string }>(
    "select id, a_reg, b_reg from matches where tournament_id = $1 and round = 1 order by position limit 1",
    [t.id],
  );
  const leader = async (reg: string) => {
    const [r] = await db.query<{ user_id: string }>("select user_id from registrations where id = $1", [reg]);
    return players.find((p) => p.id === r.user_id)!;
  };
  const a = await leader(m.a_reg);
  const b = await leader(m.b_reg);
  await submitResult(db, a, m.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  // Ten simultaneous confirmations: one wins, the winner advances exactly once.
  const confirms = await Promise.allSettled(Array.from({ length: 10 }, () => confirmResult(db, b, m.id)));
  assert.equal(confirms.filter((r) => r.status === "fulfilled").length, 1);
  const [next] = await db.query<{ a_reg: string | null; b_reg: string | null }>(
    "select n.a_reg, n.b_reg from matches m join matches n on n.id = m.next_match_id where m.id = $1",
    [m.id],
  );
  assert.equal([next.a_reg, next.b_reg].filter((x) => x === m.a_reg).length, 1);
  const [versions] = await db.query<{ n: number }>("select count(*)::int as n from match_results where match_id = $1 and status = 'confirmed'", [m.id]);
  assert.equal(versions.n, 1);
  const chain = await verifyAuditChain(db);
  assert.equal(chain.valid, true, "audit chain intact after concurrent writes");
  await db.close();
});
