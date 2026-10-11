import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrate, type Database, type Queryable } from "../src/server/db.ts";
import { migrations } from "../src/server/schema.ts";
import { audit, verifyAuditChain } from "../src/server/audit.ts";

const originalEvidence = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

// Open an explicit memory database: these upgrade fixtures never consume a database URL.
async function legacyDatabase(): Promise<Database> {
  const pg = new PGlite("memory://");
  await pg.waitReady;
  return {
    kind: "embedded",
    query: async (sql, params) => (await pg.query(sql, params)).rows as never,
    tx: (fn) => pg.transaction((q) => fn({
      query: async (sql, params) => (await q.query(sql, params)).rows as never,
    })),
    close: () => pg.close(),
  };
}

async function applyThrough(db: Database, version: number) {
  await db.tx(async (q) => {
    await q.query("create table if not exists schema_migrations(id int primary key, name text not null, applied_at timestamptz not null default now())");
    const applied = new Set((await q.query<{ id: number }>("select id from schema_migrations")).map((m) => m.id));
    for (const migration of migrations.filter((m) => m.id <= version && !applied.has(m.id))) {
      for (const sql of migration.statements) await q.query(sql);
      await q.query("insert into schema_migrations(id,name) values($1,$2)", [migration.id, migration.name]);
    }
  });
}

async function seedLegacy(db: Database) {
  const users: string[] = [];
  for (const name of ["upgradeowner", "upgradefirst", "upgradesecond"]) {
    const [row] = await db.query<{ id: string }>(
      "insert into users(email,username,display_name,password_hash,adult_confirmed_at) values($1,$2,$2,'fixture-not-a-login-hash',now()) returning id",
      [`${name}@example.test`, name],
    );
    users.push(row.id);
  }
  const [owner, first, second] = users;
  const [org] = await db.query<{ id: string }>("insert into organizations(slug,name,created_by) values('upgrade-fixture','Upgrade fixture',$1) returning id", [owner]);
  await db.query("insert into org_members(org_id,user_id,role) values($1,$2,'owner')", [org.id, owner]);
  const [media] = await db.query<{ id: string }>(
    "insert into media(owner_id,kind,content_type,bytes,sha256,data) values($1,'evidence','image/png',$2,$3,$4) returning id",
    [first, originalEvidence.length, digest(originalEvidence), originalEvidence],
  );
  const events: Record<string, string> = {};
  let currentEntry = "", legacyBlankEntry = "";
  for (const status of ["COMPLETED", "ARCHIVED", "IN_PROGRESS"]) {
    const [event] = await db.query<{ id: string }>(
      `insert into tournaments(slug,org_id,name,game,format,participant_type,max_participants,starts_at,status,created_by,best_of,started_at,completed_at)
       values($1,$2,$1,'pubg','leaderboard','solo',2,'2026-09-01T12:00Z',$3,$4,1,'2026-09-01T12:00Z',$5) returning id`,
      [`upgrade-${status.toLowerCase()}`, org.id, status, owner, status === "IN_PROGRESS" ? null : "2026-09-02T12:00Z"],
    );
    events[status] = event.id;
    for (const [index, user] of [first, second].entries()) {
      const placement = status === "IN_PROGRESS" ? null : index + 1;
      const [registration] = await db.query<{ id: string }>(
        "insert into registrations(tournament_id,user_id,registered_by,status,seed,placement) values($1,$2,$2,'registered',$3,$4) returning id",
        [event.id, user, index + 1, placement],
      );
      await db.query("insert into roster_entries(registration_id,tournament_id,user_id) values($1,$2,$3)", [registration.id, event.id, user]);
      // Blank historical match references must survive all four upgrade routes unchanged.
      const reference = index === 0 ? "" : `legacy-${status.toLowerCase()}`;
      const review = status === "IN_PROGRESS" ? (index === 0 ? "pending" : "rejected") : (index === 0 ? "accepted" : "approved");
      const [entry] = await db.query<{ id: string }>(
        `insert into score_entries(tournament_id,registration_id,submitted_by,source,kills,assists,deaths,headshots,damage,distance,placement,match_ref,evidence_url,review,review_note)
         values($1,$2,$3,'participant',$4,2,1,3,250,100,1,$5,$6,$7,'Original review') returning id`,
        [event.id, registration.id, user, 10 - index, reference, `https://example.test/api/media/${media.id}`, review],
      );
      if (status === "IN_PROGRESS") {
        if (index === 0) legacyBlankEntry = entry.id;
        else currentEntry = entry.id;
      } else if (index === 0) {
        await db.query("insert into tournament_awards(tournament_id,registration_id,kind,coins) values($1,$2,'champion',0)", [event.id, registration.id]);
        await db.query("insert into xp_events(user_id,amount,reason,game,ref,idem_key) values($1,50,'tournament_champion','pubg',$2,$3)", [user, event.id, `upgrade:${event.id}`]);
      }
    }
    await db.tx((q) => audit(q, {
      actorId: owner, action: "tournament.fixture_recorded", entity: "tournament", entityId: event.id,
      data: { status, placements: status === "IN_PROGRESS" ? [] : [1, 2], evidenceId: media.id },
    }));
  }
  return { owner, first, second, media: media.id, events, currentEntry, legacyBlankEntry };
}

async function seedVersioned(db: Database, version: number, fixture: Awaited<ReturnType<typeof seedLegacy>>) {
  if (version >= 44) {
    await db.query("update tournaments set eligible_game_limit=10 where id=$1", [fixture.events.IN_PROGRESS]);
    await db.tx(async (q) => {
      const [previous] = await q.query("select * from score_entries where id=$1", [fixture.currentEntry]);
      await q.query("insert into score_entry_revisions(entry_id,revision,previous,reason,actor_id) values($1,1,$2,'Corrected from retained evidence',$3)", [fixture.currentEntry, JSON.stringify(previous), fixture.second]);
      await q.query("update score_entries set revision=2,kills=8,review='pending',payload_hash=$2 where id=$1", [fixture.currentEntry, digest(Buffer.from("corrected score fixture"))]);
      await q.query("insert into score_match_claims(game,account_id,match_ref,entry_id) values('pubg',$1,'legacy-in_progress',$2)", [fixture.second, fixture.currentEntry]);
      await audit(q, { actorId: fixture.second, action: "score.resubmitted", entity: "tournament", entityId: fixture.events.IN_PROGRESS, data: { entryId: fixture.currentEntry, previousRevision: 1 } });
    });
  }
  if (version >= 45) {
    // One already preserved original plus one untouched legacy image exercise both states.
    await db.query(
      `insert into media(owner_id,kind,content_type,bytes,sha256,data,original_data,original_sha256,original_bytes,original_content_type)
       values($1,'evidence','image/png',$2,$3,$4,$4,$3,$2,'image/png')`,
      [fixture.second, originalEvidence.length, digest(originalEvidence), originalEvidence],
    );
  }
  if (version >= 46) {
    await db.query("insert into game_api_limits(provider,requests,window_at,retry_at) values('pubg',3,'2026-09-01T12:00Z','2026-09-01T13:00Z')");
    await db.query("insert into game_account_bindings(game,user_id,account_id,proof_reference,verified_by) values('pubg',$1,'isolated-account','synthetic-proof-reference',$2)", [fixture.second, fixture.owner]);
    await db.query("insert into score_verification_receipts(game,account_id,match_id,entry_id,revision,receipt) values('pubg','isolated-account','legacy-in_progress',$1,2,$2)", [fixture.currentEntry, JSON.stringify({ synthetic: true, evidenceId: fixture.media, kills: 8 })]);
  }
}

// Compare every pre-existing field, including IDs, bytea data, JSON and timestamps.
async function snapshot(q: Queryable, version: number, requirePopulated = true) {
  const tables = [
    "users", "organizations", "org_members", "tournaments", "registrations", "roster_entries",
    "score_entries", "media", "tournament_awards", "xp_events", "audit_log",
    ...(version >= 44 ? ["score_match_claims", "score_entry_revisions"] : []),
    ...(version >= 46 ? ["game_api_limits", "game_account_bindings", "score_verification_receipts"] : []),
  ];
  const result: Record<string, unknown[]> = {};
  for (const table of tables) {
    const addedColumns = version < 44 && table === "tournaments" ? ["eligible_game_limit"]
      : version < 44 && table === "score_entries" ? ["revision", "payload_hash"]
      : version < 45 && table === "media" ? ["original_data", "original_sha256", "original_bytes", "original_content_type"] : [];
    result[table] = await q.query(`select to_jsonb(row) - $1::text[] as data from ${table} row order by (to_jsonb(row) - $1::text[])::text`, [addedColumns]);
    if (requirePopulated) assert.ok(result[table].length > 0, `${table} must be populated at version ${version}`);
  }
  return result;
}

for (const version of [43, 44, 45, 46]) {
  test(`populated ${version}->47 preserves placements, evidence, revisions and audit; repeated migrate is unchanged`, async () => {
    const db = await legacyDatabase();
    try {
      await applyThrough(db, 43);
      const fixture = await seedLegacy(db);
      await applyThrough(db, version);
      await seedVersioned(db, version, fixture);
      const before = await snapshot(db, version);
      const appliedBefore = await db.query("select * from schema_migrations order by id");
      const auditBefore = await verifyAuditChain(db);
      assert.equal(auditBefore.valid, true);
      assert.ok(auditBefore.records >= 3);

      await migrate(db);
      assert.deepEqual(await snapshot(db, version), before, "upgrade must not rewrite historical records");
      assert.deepEqual(await verifyAuditChain(db), auditBefore);
      assert.deepEqual(await db.query("select * from schema_migrations where id<=$1 order by id", [version]), appliedBefore);
      assert.deepEqual((await db.query<{ id: number }>("select id from schema_migrations order by id")).map((m) => m.id), migrations.map((m) => m.id));
      const placements = await db.query<{ status: string; placements: number[] }>(
        "select t.status,array_agg(r.placement order by r.placement) as placements from tournaments t join registrations r on r.tournament_id=t.id where t.status in ('COMPLETED','ARCHIVED') group by t.status order by t.status",
      );
      assert.deepEqual(placements, [{ status: "ARCHIVED", placements: [1, 2] }, { status: "COMPLETED", placements: [1, 2] }]);
      const [legacyMedia] = await db.query<{ data: Uint8Array; sha256: string; original_data: Uint8Array | null; original_bytes: number }>("select data,sha256,original_data,original_bytes from media where id=$1", [fixture.media]);
      assert.deepEqual(Buffer.from(legacyMedia.data), originalEvidence);
      assert.equal(legacyMedia.sha256, digest(originalEvidence));
      assert.equal(legacyMedia.original_data, null, "migration must not invent or convert an original");
      assert.equal(legacyMedia.original_bytes, 0);
      if (version === 43) {
        assert.equal((await db.query("select 1 from score_entries where revision<>1 or payload_hash<>''")).length, 0);
        assert.equal((await db.query("select 1 from score_match_claims")).length, 0, "historical match claims are not invented");
        assert.equal((await db.query("select 1 from score_entry_revisions")).length, 0);
      }
      const [limit] = await db.query<{ eligible_game_limit: number }>("select eligible_game_limit from tournaments where id=$1", [fixture.events.IN_PROGRESS]);
      assert.equal(limit.eligible_game_limit, version === 43 ? 20 : 10);

      // Reopening an upgraded database cannot replay migrations or duplicate historical data.
      const upgraded = await snapshot(db, 47, false);
      const ledger = await db.query("select * from schema_migrations order by id");
      for (let retry = 0; retry < 2; retry++) {
        await migrate(db);
        assert.deepEqual(await snapshot(db, 47, false), upgraded);
        assert.deepEqual(await db.query("select * from schema_migrations order by id"), ledger);
        assert.deepEqual(await verifyAuditChain(db), auditBefore);
      }

      // Migration 47 replaces the NOT VALID check: legacy review can proceed,
      // but inserts and changes to a blank match reference remain prohibited.
      await db.tx(async (q) => {
        await q.query("update score_entries set review='rejected',review_note='Missing historical match reference' where id=$1", [fixture.legacyBlankEntry]);
        await audit(q, { actorId: fixture.owner, action: "score.rejected", entity: "tournament", entityId: fixture.events.IN_PROGRESS, data: { entryId: fixture.legacyBlankEntry, legacyReference: true } });
      });
      const checkViolation = (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "23514");
      await assert.rejects(db.query("update score_entries set match_ref=' ' where id=$1", [fixture.currentEntry]), checkViolation);
      await assert.rejects(db.query(
        `insert into score_entries(tournament_id,registration_id,submitted_by,source,kills,assists,deaths,headshots,damage,distance,match_ref,review)
         select tournament_id,registration_id,submitted_by,source,0,0,0,0,0,0,'','pending' from score_entries where id=$1`,
        [fixture.legacyBlankEntry],
      ), checkViolation);
      assert.deepEqual(await verifyAuditChain(db), { valid: true, records: auditBefore.records + 1, brokenAt: null });
    } finally {
      await db.close();
    }
  });
}
