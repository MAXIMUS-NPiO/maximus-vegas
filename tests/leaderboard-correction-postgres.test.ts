import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { createTournament, register, transition } from "../src/server/tournaments.ts";
import { submitScore, reviewScore } from "../src/server/leaderboard.ts";
import { verifyAuditChain } from "../src/server/audit.ts";

test("two organizers correcting the same revision commit only one replacement", { skip: !process.env.PG_TEST_URL, timeout: 30_000 }, async () => {
  const db = await openDatabase({ url: process.env.PG_TEST_URL });
  try {
    const run = Date.now().toString(36), users = [];
    for (const name of ["raceowner", "raceplayer", "racereviewer"]) {
      const username = name + run;
      const signed = await signUp(db, { email: `${username}@example.test`, username, displayName: name, password: "isolated concurrent correction", adult: true, terms: true });
      users.push((await sessionUser(db, signed.token))!);
    }
    const [owner, player, reviewer] = users;
    const org = await createOrg(db, owner, { name: `Correction race ${run}`, description: "" });
    await db.query("insert into org_members(org_id,user_id,role) values($1,$2,'referee')", [org.id, reviewer.id]);
    const t = await createTournament(db, owner, org.id, { name: "Correction race", game: "pubg", format: "leaderboard", participantType: "solo", teamSize: 1, maxParticipants: 2, startsAt: "2030-01-01T12:00", timeZone: "UTC", checkInRequired: "", region: "", description: "", rules: "" });
    await transition(db, owner, t.id, "PUBLISHED");
    await transition(db, owner, t.id, "REGISTRATION_OPEN");
    await register(db, player, t.id); await register(db, reviewer, t.id);
    await transition(db, owner, t.id, "REGISTRATION_CLOSED");
    await transition(db, owner, t.id, "IN_PROGRESS");
    const original = { matchRef: `correction-race-${run}`, kills: 3, evidenceUrl: "https://example.test/proof" };
    const entry = await submitScore(db, player, t.id, original);
    await reviewScore(db, reviewer, entry.id, "reject", "Needs a corrected replay", 1);
    const [reg] = await db.query<{ id: string }>("select id from registrations where tournament_id=$1 and user_id=$2", [t.id, player.id]);
    let arrivals = 0, release!: () => void;
    const bothReady = new Promise<void>(resolve => { release = resolve; });
    const racing: Database = { ...db, tx: fn => db.tx(q => fn({ query: async <T>(sql: string, params?: unknown[]) => {
      if (/from tournaments.*for update/s.test(sql)) {
        if (++arrivals === 2) release();
        await bothReady;
      }
      return q.query<T>(sql, params);
    } })) };
    const correction = { ...original, registration: reg.id, replaces: entry.id, expectedRevision: 1, correctionReason: "Correction from original replay" };
    const outcomes = await Promise.allSettled([
      submitScore(racing, owner, t.id, { ...correction, kills: 4 }, true),
      submitScore(racing, reviewer, t.id, { ...correction, kills: 5 }, true),
    ]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    const loser = outcomes.find(r => r.status === "rejected");
    assert.equal(loser?.reason?.code, "stale_submission");
    const [stored] = await db.query<{ revision: number; review: string; kills: number }>("select revision,review,kills from score_entries where id=$1", [entry.id]);
    assert.equal(stored.revision, 2); assert.equal(stored.review, "pending");
    assert.equal(stored.kills, outcomes[0].status === "fulfilled" ? 4 : 5);
    assert.equal((await db.query("select 1 from score_entries where tournament_id=$1", [t.id])).length, 1);
    assert.equal((await db.query("select 1 from score_entry_revisions where entry_id=$1", [entry.id])).length, 1);
    assert.equal((await db.query("select 1 from audit_log where entity_id=$1 and action='score.resubmitted'", [t.id])).length, 1);
    assert.equal((await db.query("select 1 from xp_events where ref=$1 and reason='leaderboard_entry'", [t.id])).length, 0);
    assert.equal((await verifyAuditChain(db)).valid, true);
  } finally { await db.close(); }
});
