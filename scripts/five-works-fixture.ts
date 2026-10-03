/** Fixtures require an explicitly named local PostgreSQL database; never use production. */
import { mkdir, writeFile } from "node:fs/promises";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { openDatabase } from "../src/server/db.ts";
import { signUp, sessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { createVenue, submitVenue, reviewVenue, issueGuestPass, myPasses } from "../src/server/venues.ts";
import { setClubHours } from "../src/server/clubhouse.ts";
import { createPassReward } from "../src/server/missions.ts";
import { grantXp } from "../src/server/progression.ts";
import { startEnrolment, confirmEnrolment, base32Decode, totp } from "../src/server/mfa.ts";
const suffix = randomUUID().slice(0, 8), dataDir = `${process.cwd()}/.data/c24-${suffix}`;
const url = process.env.PG_TEST_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || !new URL(url).pathname.startsWith("/c24_")) throw new Error("PG_TEST_URL must name a local c24_ test database");
const db = await openDatabase({ url });
const accounts: Record<string, Awaited<ReturnType<typeof account>>> = {};
async function account(name: string, roles: string[] = []) {
  const username = `c24_${name}_${suffix}`, password = `isolated-fixture-${randomUUID()}`;
  const signup = await signUp(db, { username, email: `${username}@example.com`, displayName: `Test ${name}`, password, adult: "on", terms: "on" });
  let user = (await sessionUser(db, signup.token))!;
  for (const role of roles) await db.query("insert into user_roles(user_id,role,granted_by) values($1,$2,$1)", [user.id, role]);
  if (roles.length) { user = (await sessionUser(db, signup.token))!; const enrol = await startEnrolment(db, user); await confirmEnrolment(db, user, totp(base32Decode(enrol.secret))); user = (await sessionUser(db, signup.token))!; }
  return { user, token: signup.token };
}
try {
  for (const name of ["alice", "bob", "owner", "scanner"]) accounts[name] = await account(name);
  accounts.staff = await account("staff", ["admin"]);
  const org = await createOrg(db, accounts.owner.user, { name: `Isolated Club ${suffix}`, description: "Local browser acceptance fixtures" });
  await db.query("insert into org_members(org_id,user_id,role) values($1,$2,'referee')", [org.id, accounts.scanner.user.id]);
  const venue = await createVenue(db, accounts.owner.user, org.id, { name: `Test Clubhouse ${suffix}`, kind: "clubhouse", city: "Dubai", country: "AE", address: "Test fixture address", description: "Local testing only", website: "" });
  await submitVenue(db, accounts.owner.user, venue.id); await reviewVenue(db, accounts.staff.user, venue.id, "confirm", "Isolated local fixture, not an operating partner");
  await setClubHours(db, accounts.owner.user, venue.id, { timeZone: "UTC", opens: 0, closes: 1440 }, ["0","1","2","3","4","5","6"]);
  await createPassReward(db, accounts.owner.user, venue.id, { title: "Test club gift", description: "Isolated stock fixture, collect at reception", tier: 1, quantity: 2 });
  await grantXp(db, [accounts.alice.user.id], 300, "match_win", "cs2", "browser-fixture-match", "browser-fixture-match");
  const pass = await issueGuestPass(db, accounts.owner.user, venue.id, { username: accounts.alice.user.username, from: new Date(Date.now()-60_000).toISOString().slice(0,16), until: new Date(Date.now()+3600_000).toISOString().slice(0,16), tz: "UTC", note: "Offline browser check" });
  const token = (await myPasses(db, accounts.alice.user.id)).find(p => p.id === pass.id)!.token;
  const keys = generateKeyPairSync("ed25519");
  const fixture = { databaseUrl: url, dataDir, accounts, org, venue, pass: { id: pass.id, token }, privateKey: keys.privateKey.export({type:"pkcs8",format:"pem"}).toString(), publicKey: keys.publicKey.export({type:"spki",format:"pem"}).toString() };
  await mkdir("artifacts", { recursive: true }); await writeFile("artifacts/c24-fixture.json", JSON.stringify(fixture), { mode: 0o600 });
  console.log("Isolated PostgreSQL fixture ready. Credentials stay in ignored artifacts.");
} finally { await db.close(); }
