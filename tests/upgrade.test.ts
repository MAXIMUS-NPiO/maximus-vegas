/**
 * Upgrade path: a database holding release-1 data (migration 1 only, as in production) is migrated to
 * the current schema without losing or breaking anything, and a release-1 tournament can be finished.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrate, type Database } from "../src/server/db.ts";
import { migrations } from "../src/server/schema.ts";
import { hashPassword, signIn, sessionUser } from "../src/server/auth.ts";
import { officialResult } from "../src/server/matches.ts";
import { needsTermsAcceptance } from "../src/server/accounts.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { roundRobinSchedule } from "../src/server/roundrobin.ts";
import { stageTables } from "../src/server/rounds.ts";
import { computePlacements } from "../src/server/tournaments.ts";

function wrap(pg: PGlite): Database {
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  return {
    kind: "embedded",
    query: (text, params) => exclusive(async () => (await pg.query(text, params)).rows as never),
    tx: (fn) => exclusive(() => pg.transaction(async (t) => fn({ query: async (text, params) => (await t.query(text, params)).rows as never }))),
    close: () => pg.close(),
  };
}

test("release-1 data survives the upgrade and a release-1 tournament can still be completed", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  const db = wrap(pg);
  await db.query("create table schema_migrations (id int primary key, name text not null, applied_at timestamptz not null default now())");
  for (const s of migrations[0].statements) await db.query(s);
  await db.query("insert into schema_migrations (id, name) values (1, 'core_portal')");

  // Release-1 rows, written with release-1 columns only.
  const hash = await hashPassword("correct horse battery");
  const ids: string[] = [];
  for (const name of ["legacyorg", "legacya", "legacyb"]) {
    const [u] = await db.query<{ id: string }>(
      "insert into users (email, username, display_name, password_hash, adult_confirmed_at) values ($1, $2, $3, $4, now()) returning id",
      [`${name}@example.com`, name, name, hash],
    );
    ids.push(u.id);
  }
  const [org] = await db.query<{ id: string }>("insert into organizations (slug, name, created_by) values ('legacy', 'Legacy', $1) returning id", [ids[0]]);
  await db.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'owner')", [org.id, ids[0]]);
  const [t] = await db.query<{ id: string }>(
    `insert into tournaments (slug, org_id, name, game, participant_type, max_participants, starts_at, status, created_by, started_at)
     values ('legacy-cup', $1, 'Legacy Cup', 'cs2', 'solo', 8, now(), 'IN_PROGRESS', $2, now()) returning id`,
    [org.id, ids[0]],
  );
  const regs: string[] = [];
  for (const uid of ids.slice(1)) {
    const [r] = await db.query<{ id: string }>("insert into registrations (tournament_id, user_id, registered_by, status, seed) values ($1, $2, $2, 'registered', 1) returning id", [t.id, uid]);
    await db.query("insert into roster_entries (registration_id, tournament_id, user_id) values ($1, $2, $3)", [r.id, t.id, uid]);
    regs.push(r.id);
  }
  const matchId = randomUUID();
  await db.query("insert into matches (id, tournament_id, round, position, a_reg, b_reg, status) values ($1, $2, 1, 0, $3, $4, 'ready')", [matchId, t.id, regs[0], regs[1]]);

  await migrate(db);
  const applied = await db.query<{ id: number }>("select id from schema_migrations order by id");
  assert.deepEqual(applied.map((r) => r.id), migrations.map((m) => m.id));

  const [m] = await db.query<{ bracket: string; a_void: boolean }>("select bracket, a_void from matches where id = $1", [matchId]);
  assert.equal(m.bracket, "W", "existing matches belong to the winners bracket");
  assert.equal(m.a_void, false);
  const [u] = await db.query<{ onboarded_at: Date | null; status: string }>("select onboarded_at, status from users where id = $1", [ids[1]]);
  assert.ok(u.onboarded_at, "existing accounts never see the first-run flow");
  const consents = await db.query<{ kind: string; version: string }>("select kind, version from consents where user_id = $1 order by kind", [ids[1]]);
  assert.deepEqual(consents.map((c) => `${c.kind}@${c.version}`), ["privacy@2026-09-27", "terms@2026-09-27"], "the accepted release-1 versions are recorded");
  assert.equal(await needsTermsAcceptance(db, ids[1]), true, "existing accounts are asked to accept the new version");

  // The release-1 tournament finishes normally on the new engine.
  const s = await signIn(db, { login: "legacyorg", password: "correct horse battery" });
  const owner = (await sessionUser(db, s.token))!;
  await officialResult(db, owner, matchId, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" });
  const [done] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
  assert.equal(done.status, "COMPLETED");
  const placements = await db.query<{ placement: number }>("select placement from registrations where tournament_id = $1 order by placement", [t.id]);
  assert.deepEqual(placements.map((p) => p.placement), [1, 2]);
  assert.equal((await verifyAuditChain(db)).valid, true);
  await db.close();
});

test("release-6 data: a groups event in its playoff finishes after the chain migration (MV-STAGES-2)", async () => {
  const pg = new PGlite();
  await pg.waitReady;
  const db = wrap(pg);
  // The schema of release 6: migrations 1–9.
  await db.query("create table schema_migrations (id int primary key, name text not null, applied_at timestamptz not null default now())");
  for (const m of migrations.filter((m) => m.id <= 9)) {
    for (const s of m.statements) await db.query(s);
    await db.query("insert into schema_migrations (id, name) values ($1, $2)", [m.id, m.name]);
  }

  // A release-6 groups + single-elimination event: two groups of four decided, the playoff of four created.
  const hash = await hashPassword("correct horse battery");
  const users: string[] = [];
  for (const name of ["sixorg", ...Array.from({ length: 8 }, (_, i) => `sixp${i + 1}`)]) {
    const [u] = await db.query<{ id: string }>(
      "insert into users (email, username, display_name, password_hash, adult_confirmed_at) values ($1, $2, $3, $4, now()) returning id",
      [`${name}@example.com`, name, name, hash],
    );
    users.push(u.id);
  }
  const [org] = await db.query<{ id: string }>("insert into organizations (slug, name, created_by) values ('six', 'Six', $1) returning id", [users[0]]);
  await db.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'owner')", [org.id, users[0]]);
  const settings = {
    v: 1,
    points: { win: 3, draw: 1, loss: 0, bye: 0 },
    allowDraws: false,
    standings: "MV-STANDINGS-1",
    legs: 1,
    disqualification: "annul",
    groups: { count: 2, advance: 2 },
    playoff: { format: "single_elimination", size: 4 },
    roundHours: 0,
    stages: "MV-STAGES-1",
  };
  const [t] = await db.query<{ id: string }>(
    `insert into tournaments (slug, org_id, name, game, participant_type, max_participants, starts_at, status, created_by, started_at, format, format_settings, stage)
     values ('six-cup', $1, 'Six Cup', 'cs2', 'solo', 8, now(), 'IN_PROGRESS', $2, now(), 'groups', $3, 2) returning id`,
    [org.id, users[0], JSON.stringify(settings)],
  );
  const seeds = new Map<number, string>();
  const groupOf = (seed: number) => ([1, 4, 5, 8].includes(seed) ? 1 : 2);
  for (let seed = 1; seed <= 8; seed++) {
    const uid = users[seed];
    const [r] = await db.query<{ id: string }>(
      "insert into registrations (tournament_id, user_id, registered_by, status, seed, group_no) values ($1, $2, $2, 'registered', $3, $4) returning id",
      [t.id, uid, seed, groupOf(seed)],
    );
    await db.query("insert into roster_entries (registration_id, tournament_id, user_id) values ($1, $2, $3)", [r.id, t.id, uid]);
    seeds.set(seed, r.id);
  }
  // Group round robins, the better seed winning 2:0; positions continue across groups within a round.
  const next = new Map<number, number>();
  for (const group of [1, 2]) {
    const members = [1, 2, 3, 4, 5, 6, 7, 8].filter((s) => groupOf(s) === group);
    for (const m of roundRobinSchedule(members).matches) {
      const position = next.get(m.round) ?? 0;
      next.set(m.round, position + 1);
      const winner = Math.min(m.a, m.b);
      await db.query(
        `insert into matches (id, tournament_id, stage, bracket, round, position, group_no, a_reg, b_reg, winner_reg, score_a, score_b, status, outcome, completed_at)
         values ($1, $2, 1, 'RR', $3, $4, $5, $6, $7, $8, $9, $10, 'completed', 'played', now())`,
        [randomUUID(), t.id, m.round, position, group, seeds.get(m.a), seeds.get(m.b), seeds.get(winner), winner === m.a ? 2 : 0, winner === m.a ? 0 : 2],
      );
    }
  }
  // The playoff field: group winners (1, 2), then runners-up (4, 3); seeds 1 v 4 and 2 v 3.
  const field = [1, 2, 4, 3];
  for (let i = 0; i < field.length; i++)
    await db.query("insert into stage_entries (tournament_id, stage, registration_id, seed, group_no, source_rank) values ($1, 2, $2, $3, $4, $5)", [
      t.id,
      seeds.get(field[i]),
      i + 1,
      groupOf(field[i]),
      i < 2 ? 1 : 2,
    ]);
  const finalId = randomUUID();
  await db.query("insert into matches (id, tournament_id, stage, bracket, round, position, status) values ($1, $2, 2, 'W', 2, 0, 'pending')", [finalId, t.id]);
  const semis = [randomUUID(), randomUUID()];
  for (const [i, [a, b]] of [
    [1, 3],
    [2, 4],
  ].entries())
    await db.query(
      `insert into matches (id, tournament_id, stage, bracket, round, position, a_reg, b_reg, status, next_match_id, next_slot)
       values ($1, $2, 2, 'W', 1, $3, $4, $5, 'ready', $6, $7)`,
      [semis[i], t.id, i, seeds.get(a), seeds.get(b), finalId, i === 0 ? "a" : "b"],
    );

  await migrate(db);
  assert.deepEqual((await db.query<{ id: number }>("select id from schema_migrations order by id")).map((r) => r.id), migrations.map((m) => m.id));
  const checks = await db.query<{ def: string }>(
    "select pg_get_constraintdef(oid) as def from pg_constraint where conname in ('tournaments_stage_check', 'matches_stage_check', 'stage_entries_stage_check') order by conname",
  );
  assert.equal(checks.length, 3);
  assert.ok(checks.every((c) => /8/.test(c.def)), "stages up to 8 are allowed");
  const [slot] = await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'matches_slot_key'");
  assert.equal(slot.def.replace(/"/g, ""), "UNIQUE (tournament_id, bracket, round, position)", "the slot key is unchanged, so earlier code keeps working");

  // The group tables read the same on the new code, and the playoff finishes.
  const [row] = await db.query<{ id: string; format: string; format_settings: unknown; series_rules: unknown }>("select id, format, format_settings, series_rules from tournaments where id = $1", [t.id]);
  const tables = (await stageTables(db, row, 1))!.tables;
  assert.deepEqual(
    tables.map((g) => g.rows.map((r) => r.rank)),
    [
      [1, 2, 3, 4],
      [1, 2, 3, 4],
    ],
  );
  const s = await signIn(db, { login: "sixorg", password: "correct horse battery" });
  const owner = (await sessionUser(db, s.token))!;
  for (const id of semis) await officialResult(db, owner, id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  await officialResult(db, owner, finalId, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" });
  const [done] = await db.query<{ status: string; stage: number }>("select status, stage from tournaments where id = $1", [t.id]);
  assert.deepEqual(done, { status: "COMPLETED", stage: 2 });
  const placeOf = async () => {
    const rows = await db.query<{ seed: number; placement: number | null }>("select seed, placement from registrations where tournament_id = $1 order by seed", [t.id]);
    return Object.fromEntries(rows.map((r) => [r.seed, r.placement]));
  };
  const places = await placeOf();
  assert.deepEqual(places, { 1: 1, 2: 2, 3: 3, 4: 3, 5: 5, 6: 5, 7: 7, 8: 7 }, "the playoff, then one shared place per group rank");
  await db.tx((q) => computePlacements(q, t.id));
  assert.deepEqual(await placeOf(), places, "recomputed from the saved data, the places stay");
  assert.equal((await verifyAuditChain(db)).valid, true);
  await db.close();
});
