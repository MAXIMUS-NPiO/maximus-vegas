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
