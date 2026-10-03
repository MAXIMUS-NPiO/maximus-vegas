import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, migrate, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { saveSocialProfile, discover, blockProfile, withdrawSocialProfile, socialExport, eraseSocial, reportSocialProfile, resolveSocialReport, restoreSocialProfile } from "../src/server/social.ts";
import { saveNearby, disableNearby, nearbyStatus, expireNearby } from "../src/server/social-nearby.ts";
import { coarseCell, NEARBY_CONSENT } from "../src/lib/nearby.ts";
import { DomainError } from "../src/server/errors.ts";
import { issueSanction } from "../src/server/conduct.ts";
import { gate } from "../src/server/system.ts";
let db: Database;
const profile = { intent: "gaming", age: 28, city: "Nearby", game: "cs2", bio: "Isolated nearby discovery profile", consent: true };
async function account(database = db, city = "Nearby") {
  const username = `n27_${randomUUID().slice(0, 8)}`;
  const session = await signUp(database, { username, displayName: username, email: `${username}@example.com`, password: "isolated strong passphrase", adult: true, terms: true });
  const user = (await sessionUser(database, session.token))!;
  await saveSocialProfile(database, user, { ...profile, city }); return user;
}
const reject = (value: Promise<unknown>, code: string) => assert.rejects(value, (e: unknown) => e instanceof DomainError && e.code === code);
async function enable(user: SessionUser, latitude = 0, longitude = 0, database = db) {
  return saveNearby(database, user, { ...coarseCell(latitude, longitude), consent: NEARBY_CONSENT, revision: (await nearbyStatus(database, user.id)).revision });
}
const within = async (a: SessionUser, b: SessionUser, radius = "25", extra = {}) => (await discover(db, a, { radius, ...extra })).some(p => p.user_id === b.id);
test.before(async () => { db = await openDatabase({ embedded: true, dataDir: "memory://" }); });
test.after(async () => { await db.close(); });

test("Nearby migration preserves existing profile data and leaves old accounts opted out", async () => {
  const a = await account();
  await db.query("drop table social_locations");
  await db.query("alter table social_profiles drop column nearby_revision, drop column nearby_updated_at");
  await db.query("delete from schema_migrations where id=36");
  await migrate(db); await migrate(db);
  assert.equal((await socialExport(db, a.id)).profile?.bio, profile.bio);
  assert.deepEqual(await nearbyStatus(db, a.id), { active: false, revision: 0, expiresAt: null, nextUpdateAt: null });
  assert.equal((await db.query("select 1 from social_locations")).length, 0);
});

test("Browser cells round before transport and canonicalize dateline/poles; API refuses precise or malformed data", async () => {
  assert.deepEqual(coarseCell(25.204849, 55.270783), { latCell: 252, lngCell: 553 });
  assert.deepEqual(coarseCell(0, 180), coarseCell(0, -180));
  assert.deepEqual(coarseCell(90, 163.4), { latCell: 900, lngCell: 0 });
  for (const [a, b] of [[NaN, 1], [0, Infinity], [91, 0], [0, -181]]) assert.throws(() => coarseCell(a, b));
  const a = await account(), valid = { latCell: 0, lngCell: 0, revision: 0, consent: NEARBY_CONSENT };
  await reject(saveNearby(db, a, { ...valid, consent: true }), "consent_required");
  for (const bad of [{ latCell: 25.1234 }, { latCell: 901 }, { lngCell: 1800 }, { latCell: 900, lngCell: 1 }, { revision: -1 }, { latCell: "0" }, { latitude: 25.123456 }, { userId: randomUUID() }]) await reject(saveNearby(db, a, { ...valid, ...bad }), "invalid_input");
  const status = await enable(a, 25.204849, 55.270783);
  assert.equal(status.active, true); assert.equal(status.revision, 1);
  assert.ok(Math.abs(Date.parse(status.expiresAt!) - Date.now() - 7 * 86400_000) < 3000);
  const exported = await socialExport(db, a.id);
  assert.equal(exported.nearby.length, 1); assert.equal(exported.nearby[0].lat_cell, 252);
  assert.ok(!JSON.stringify(status).includes("lat_cell"));
  const audit = JSON.stringify(await db.query("select data from audit_log where entity_id=$1 and action='social.nearby_enabled'", [a.id]));
  assert.ok(!/lat|lng|252|553/.test(audit));
  await reject(enable(a), "request_limit");
  await disableNearby(db, a); await reject(enable(a), "request_limit");
});

test("Approximate radii handle equator, dateline and poles without disclosing locations or distances", async () => {
  const a = await account(), b = await account(), c = await account();
  await enable(a); await enable(b, 0.2); await enable(c, 0.3);
  assert.equal(await within(a, b), true); assert.equal(await within(a, c), false); assert.equal(await within(a, c, "50"), true);
  for (const row of await discover(db, a, { radius: "50" })) assert.ok(!Object.keys(row).some(k => /lat_cell|lng_cell|distance|expires_at|revision|consent/.test(k)));
  await reject(discover(db, a, { radius: "1" }), "invalid_input");
  const d = await account(), e = await account(); await enable(d, 0, 179.9); await enable(e, 0, -179.9);
  assert.equal(await within(d, e), true); assert.equal(await within(d, a, "250"), false);
  const poleA = await account(), poleB = await account(); await enable(poleA, 89, 0); await enable(poleB, 89, 180);
  assert.equal(await within(poleA, poleB, "250"), true); assert.equal(await within(poleA, poleB, "100"), false);
});

test("Bilateral nearby consent retains age, game, intent, city, gaming ranking and bidirectional blocks", async () => {
  const a = await account(), b = await account(); await enable(a);
  assert.equal(await within(a, b), false); assert.equal(await within(b, a), false);
  assert.equal((await discover(db, a)).some(p => p.user_id === b.id), true);
  await enable(b); assert.equal(await within(a, b), true);
  for (const extra of [{ city: "Elsewhere" }, { game: "dota2" }, { minAge: "40" }]) assert.equal(await within(a, b, "25", extra), false);
  for (const u of [a, b]) { await saveSocialProfile(db, u, { ...profile, gamingConsent: true }); await db.query("insert into ratings(user_id,game,matches) values($1,'cs2',2)", [u.id]); }
  assert.equal((await discover(db, a, { radius: "25" })).find(p => p.user_id === b.id)?.gaming_points, 25);
  await blockProfile(db, b, a.id); assert.equal(await within(a, b), false); assert.equal(await within(b, a), false);
  await blockProfile(db, b, a.id, true); assert.equal(await within(a, b), true);
  await saveSocialProfile(db, b, { ...profile, intent: "dating" }); assert.equal(await within(a, b), false);
});

test("Expiry removes both sides from nearby results before maintenance; refresh needs new consent", async () => {
  const a = await account(), b = await account(); await enable(a); await enable(b);
  await db.query("update social_locations set updated_at=now()-interval '8 days',expires_at=now()-interval '1 day' where user_id=$1", [a.id]);
  await db.query("update social_profiles set nearby_updated_at=now()-interval '8 days' where user_id=$1", [a.id]);
  assert.equal((await nearbyStatus(db, a.id)).active, false); assert.equal(await within(a, b), false); assert.equal(await within(b, a), false);
  await expireNearby(db); assert.equal((await socialExport(db, a.id)).nearby.length, 0);
  await enable(a); assert.equal(await within(a, b), true);
});

test("Geographical filtering happens before the result limit, preserving an older nearby candidate", async () => {
  const city = randomUUID(), a = await account(db, city), b = await account(db, city); await enable(a); await enable(b);
  await db.query("update social_profiles set updated_at='2000-01-01' where user_id=$1", [b.id]);
  for (let i = 0; i < 41; i++) { const far = await account(db, city); await enable(far, 40); }
  const rows = await discover(db, a, { city, radius: "25" });
  assert.deepEqual(rows.map(r => r.user_id), [b.id]);
});

test("Opt-out fences delayed uploads; withdrawal, moderation and account erasure remove the cell", async () => {
  const a = await account(), b = await account(), staff = { ...await account(), roles: ["moderation"] } as SessionUser;
  await disableNearby(db, a);
  await reject(saveNearby(db, a, { consent: NEARBY_CONSENT, latCell: 0, lngCell: 0, revision: 0 }), "request_state");
  await enable(a); await withdrawSocialProfile(db, a);
  assert.equal((await socialExport(db, a.id)).nearby.length, 0);
  await reject(enable(a), "consent_required");
  await saveSocialProfile(db, a, profile); assert.equal((await nearbyStatus(db, a.id)).active, false);
  await db.query("update social_profiles set nearby_updated_at=now()-interval '2 hours' where user_id=$1", [a.id]);
  await enable(a); await reportSocialProfile(db, b, a.id, "Isolated location moderation case", "");
  const [report] = await db.query<{ id: string }>("select id from social_reports where subject_id=$1", [a.id]);
  await resolveSocialReport(db, staff, report.id, "Independent moderation decision", true);
  assert.equal((await socialExport(db, a.id)).nearby.length, 0);
  await restoreSocialProfile(db, staff, a.id, "Independent restoration review");
  await saveSocialProfile(db, a, profile); assert.equal((await nearbyStatus(db, a.id)).active, false);
  await db.query("update social_profiles set nearby_updated_at=now()-interval '2 hours' where user_id=$1", [a.id]);
  await enable(a); await db.tx(q => eraseSocial(q, a.id));
  assert.equal((await socialExport(db, a.id)).nearby.length, 0);
});

test("Account restrictions remove location immediately; privacy deletion works during maintenance", async () => {
  const a = await account(), staff = { ...await account(), roles: ["moderation"] } as SessionUser;
  await enable(a); const [rule] = await db.query<{ code: string }>("select code from conduct_rules where retired_at is null limit 1");
  await issueSanction(db, staff, { username: a.username, kind: "suspension", confidence: "high", rule: rule.code, days: 1, protective: false, hours: "", report: "", decision: "Independent isolated nearby acceptance", evidence: "https://example.com/isolated-evidence" });
  assert.equal((await socialExport(db, a.id)).nearby.length, 0); await reject(enable(a), "account_restricted");
  await db.query("insert into feature_flags(key,enabled,note) values('maintenance',true,'Isolated test')");
  await gate(db, "social.nearby_disable", a); await disableNearby(db, a);
  await reject(gate(db, "social.nearby_enable", a), "maintenance");
  await db.query("delete from feature_flags where key='maintenance'");
  await db.query("insert into feature_flags(key,enabled,note) values('connections',false,'Isolated test')");
  const fresh = { query: db.query };
  await reject(gate(fresh, "social.nearby_enable", a), "feature_disabled");
  await gate(fresh, "social.nearby_disable", a);
});

const pgUrl = process.env.PG_TEST_URL;
if (pgUrl && (!['localhost', '127.0.0.1'].includes(new URL(pgUrl).hostname) || !/^\/c2[567]_/.test(new URL(pgUrl).pathname))) throw Error("Nearby concurrency requires a local c25_, c26_ or c27_ database");
test("PostgreSQL: concurrent enable/revoke/withdraw cannot resurrect a location or duplicate consent", { skip: !pgUrl }, async () => {
  const pg = await openDatabase({ url: pgUrl });
  try {
    const a = await account(pg), input = { consent: NEARBY_CONSENT, latCell: 0, lngCell: 0, revision: 0 };
    const both = await Promise.allSettled([saveNearby(pg, a, input), saveNearby(pg, a, input)]);
    assert.equal(both.filter(r => r.status === "fulfilled").length, 1);
    await disableNearby(pg, a);
    await pg.query("update social_profiles set nearby_updated_at=now()-interval '2 hours' where user_id=$1", [a.id]);
    const revision = (await nearbyStatus(pg, a.id)).revision;
    await Promise.allSettled([saveNearby(pg, a, { ...input, revision }), disableNearby(pg, a)]);
    assert.equal((await socialExport(pg, a.id)).nearby.length, 0);
    await pg.query("update social_profiles set nearby_updated_at=now()-interval '2 hours' where user_id=$1", [a.id]);
    const next = (await nearbyStatus(pg, a.id)).revision;
    await Promise.allSettled([saveNearby(pg, a, { ...input, revision: next }), withdrawSocialProfile(pg, a)]);
    assert.equal((await socialExport(pg, a.id)).nearby.length, 0);
    assert.equal((await nearbyStatus(pg, a.id)).active, false);
  } finally { await pg.close(); }
});
