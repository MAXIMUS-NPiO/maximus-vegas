import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, migrate, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { createVenue, updateVenue, submitVenue, reviewVenue, discoverVenues, venueView, type VenueInput } from "../src/server/venues.ts";
import { venueMapPoints } from "../src/lib/venue-discovery.ts";
import { DomainError } from "../src/server/errors.ts";
let db: Database, owner: SessionUser, staff: SessionUser, stranger: SessionUser, org: string;
const input = (over: Partial<VenueInput> = {}): VenueInput => ({ name: `Venue ${randomUUID().slice(0, 8)}`, kind: "clubhouse", address: "Local test entrance 12", city: "Dubai", country: "AE", description: "Isolated venue discovery acceptance", website: "", ...over });
const reject = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code);
async function account(database: Database) {
  const name = `v28_${randomUUID().slice(0, 8)}`;
  const s = await signUp(database, { username: name, email: `${name}@example.com`, displayName: name, password: "isolated strong passphrase", adult: true, terms: true });
  return (await sessionUser(database, s.token))!;
}
async function confirmed(data: VenueInput) {
  const v = await createVenue(db, owner, org, data); await submitVenue(db, owner, v.id); await reviewVenue(db, staff, v.id, "confirm", "", "0"); return v;
}
test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  owner = await account(db); staff = { ...await account(db), roles: ["support"] }; stranger = await account(db);
  org = (await createOrg(db, owner, { name: "Local discovery tests", description: "" })).id;
});
test.after(async () => { await db.close(); });

test("Venue migration preserves old venues, defaults to no map/game claim and is idempotent", async () => {
  const v = await confirmed(input({ name: "Pre-migration venue" }));
  await db.query("drop index venues_discovery_city");
  await db.query("alter table venues drop column lat_e6, drop column lng_e6, drop column games, drop column review_version");
  await db.query("delete from schema_migrations where id=37"); await migrate(db); await migrate(db);
  const row = (await venueView(db, v.slug, null))!.venue;
  assert.equal(row.name, "Pre-migration venue"); assert.equal(row.status, "confirmed");
  assert.equal(row.lat_e6, null); assert.equal(row.lng_e6, null); assert.deepEqual(row.games, []); assert.equal(row.review_version, 0);
  assert.deepEqual(venueMapPoints([row]), []);
});

test("Venue coordinates are paired, bounded and canonical; games are known, deduplicated and bounded", async () => {
  for (const over of [{ latitude: "25" }, { latitude: "", longitude: "55" }, { latitude: "NaN", longitude: "0" }, { latitude: "85.051129", longitude: "0" }, { latitude: "0", longitude: "180.000001" }, { latitude: "1e1", longitude: "0" }, { latitude: 25, longitude: 55 }, { latitude: "1.1234567", longitude: "1" }]) await reject(createVenue(db, owner, org, input(over)), "venue_coordinates");
  for (const games of ["cs2", ["unknown"], [null], Array(17).fill("cs2")]) await reject(createVenue(db, owner, org, input({ games })), "invalid_input");
  const v = await confirmed(input({ latitude: "-85.051128", longitude: "180", games: ["dota2", "cs2", "cs2"] }));
  const row = (await venueView(db, v.slug, null))!.venue;
  assert.equal(row.lat_e6, -85051128); assert.equal(row.lng_e6, -180000000); assert.deepEqual(row.games, ["cs2", "dota2"]);
  for (const sql of ["lat_e6=null", "lng_e6=180000000", "lat_e6=85051129", "games=ARRAY[null]::text[]"]) await assert.rejects(db.query(`update venues set ${sql} where id=$1`, [v.id]));
});

test("Only managers edit; new coordinates, games and kind require review; stale browser decisions fail", async () => {
  const data = input({ latitude: "25.204849", longitude: "55.270783", games: ["cs2"] }), v = await confirmed(data);
  await reject(updateVenue(db, stranger, v.id, data), "forbidden");
  assert.deepEqual(await updateVenue(db, owner, v.id, { ...data, latitude: "25.21" }), { resubmitted: true });
  assert.equal(await venueView(db, v.slug, null), null);
  await reject(reviewVenue(db, staff, v.id, "confirm", "", "0"), "venue_changed");
  await reject(reviewVenue(db, staff, v.id, "confirm", "", ""), "venue_changed");
  await reviewVenue(db, staff, v.id, "confirm", "", "1");
  assert.deepEqual(await updateVenue(db, owner, v.id, { ...data, latitude: "25.21", games: ["dota2"] }), { resubmitted: true });
  await reviewVenue(db, staff, v.id, "confirm", "", "2");
  assert.deepEqual(await updateVenue(db, owner, v.id, { ...data, latitude: "25.21", games: ["dota2"], kind: "arena" }), { resubmitted: true });
  const row = (await venueView(db, v.slug, owner))!.venue;
  assert.deepEqual(venueMapPoints([row]), [], "unreviewed coordinates never reach a public map");
  await reviewVenue(db, staff, v.id, "reject", "Coordinates need operator evidence", "3");
  assert.equal(await venueView(db, v.slug, null), null);
});

test("Old update payloads preserve discovery fields; explicit clearing hides the venue pending review", async () => {
  const data = input(), v = await confirmed({ ...data, latitude: "0", longitude: "0", games: ["cs2"] });
  assert.deepEqual(await updateVenue(db, owner, v.id, { ...data, description: "Updated description only" }), { resubmitted: false });
  const row = (await venueView(db, v.slug, null))!.venue;
  assert.equal(row.lat_e6, 0); assert.equal(row.lng_e6, 0); assert.deepEqual(row.games, ["cs2"]);
  assert.deepEqual(await updateVenue(db, owner, v.id, { ...data, latitude: "", longitude: "", games: [] }), { resubmitted: true });
  await reviewVenue(db, staff, v.id, "confirm", "", "2");
  assert.deepEqual(venueMapPoints([(await venueView(db, v.slug, null))!.venue]), []);
});

test("Directory intersects literal name, city, country, game and kind; map payload contains only public fields", async () => {
  const name = "Map 100%_exact", v = await confirmed(input({ name, latitude: "25", longitude: "55", games: ["cs2", "dota2"] }));
  await confirmed(input({ name: "Map 100otherexact", city: "Abu Dhabi", games: ["cs2"], kind: "arena" }));
  const filters = { name: "%_", city: "DUBAI", country: "ae", game: "cs2", kind: "clubhouse" };
  const r = await discoverVenues(db, filters); assert.deepEqual(r.items.map(p => p.id), [v.id]); assert.equal(r.more, false);
  for (const bad of [{ city: "London" }, { country: "GB" }, { game: "lol" }, { kind: "arena" }, { name: "\\" }]) assert.equal((await discoverVenues(db, { ...filters, ...bad })).items.length, 0);
  assert.deepEqual(Object.keys(venueMapPoints(r.items)[0]).sort(), ["slug", "name", "address", "city", "lat", "lng"].sort());
  await reviewVenue(db, staff, v.id, "suspend", "Local acceptance suspension", "0");
  assert.equal((await discoverVenues(db, filters)).items.length, 0);
});

test("Eligibility and filters precede the result window, with an explicit limit flag", async () => {
  await db.query(`insert into venues(org_id,slug,name,kind,address,city,country_code,status,games,created_by)
    select $1,'bulk-c28-'||i,'Bulk venue '||lpad(i::text,3,'0'),'clubhouse','Local test 12','Limit City','AE','confirmed',array['cs2'],$2 from generate_series(1,205) i`, [org, owner.id]);
  const all = await discoverVenues(db, { city: "Limit City" }); assert.equal(all.items.length, 200); assert.equal(all.more, true);
  const last = await discoverVenues(db, { city: "Limit City", name: "205" }); assert.equal(last.items.length, 1); assert.equal(last.more, false);
  await db.query("update venues set status='submitted' where slug like 'bulk-c28-%' and name not like '%205'");
  assert.equal((await discoverVenues(db, { city: "Limit City" })).items.length, 1);
});

const pgUrl = process.env.PG_TEST_URL;
test("PostgreSQL: concurrent edit/review cannot publish a location that changed after the reviewed version", { skip: !pgUrl }, async () => {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(pgUrl!).hostname) && /^\/c(?:25|28)_/.test(new URL(pgUrl!).pathname), "disposable local database required");
  const pg = await openDatabase({ url: pgUrl });
  try {
    const a = await account(pg), b: SessionUser = { ...await account(pg), roles: ["support"] };
    const o = await createOrg(pg, a, { name: `Race ${randomUUID().slice(0, 8)}`, description: "" });
    const data = input({ latitude: "25", longitude: "55", games: ["cs2"] }), v = await createVenue(pg, a, o.id, data);
    await submitVenue(pg, a, v.id);
    const result = await Promise.allSettled([reviewVenue(pg, b, v.id, "confirm", "", "0"), updateVenue(pg, a, v.id, { ...data, latitude: "26" })]);
    assert.equal(result[1].status, "fulfilled");
    const row = (await venueView(pg, v.slug, a))!.venue;
    assert.equal(row.status, "submitted"); assert.equal(row.lat_e6, 26000000); assert.equal(await venueView(pg, v.slug, null), null);
    await reviewVenue(pg, b, v.id, "confirm", "", "1"); assert.equal((await venueView(pg, v.slug, null))?.venue.lat_e6, 26000000);
  } finally { await pg.close(); }
});
