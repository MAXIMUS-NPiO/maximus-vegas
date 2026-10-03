/** Disposable local acceptance data. No production venue or account is created. */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { openDatabase } from "../src/server/db.ts";
import { signUp, sessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { createVenue, submitVenue, reviewVenue } from "../src/server/venues.ts";
import { startEnrolment, confirmEnrolment, base32Decode, totp } from "../src/server/mfa.ts";
const url = process.env.PG_TEST_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname) || !new URL(url).pathname.startsWith("/c28_")) throw Error("Local c28_ database required");
const db = await openDatabase({ url }), suffix = randomUUID().slice(0, 8);
async function account(name: string, staff = false) {
  const username = `c28_${name}_${suffix}`;
  const s = await signUp(db, { username, displayName: `Local ${name}`, email: `${username}@example.com`, password: `isolated-${randomUUID()}`, adult: true, terms: true });
  let user = (await sessionUser(db, s.token))!;
  if (staff) {
    await db.query("insert into user_roles(user_id,role) values($1,'support')", [user.id]); user = (await sessionUser(db, s.token))!;
    const e = await startEnrolment(db, user); await confirmEnrolment(db, user, totp(base32Decode(e.secret))); user = (await sessionUser(db, s.token))!;
  }
  return { user, token: s.token };
}
try {
  const owner = await account("owner"), staff = await account("staff", true), outsider = await account("outsider");
  const org = await createOrg(db, owner.user, { name: `Isolated discovery ${suffix}`, description: "Local browser acceptance only" });
  const base = { kind: "clubhouse", address: "Local fixture entrance 12", city: "Dubai", country: "AE", description: "Local test record; not an operating venue", website: "" };
  const venues = [];
  for (const data of [
    { name: `Local map ${suffix}`, latitude: "25.204849", longitude: "55.270783", games: ["cs2"] },
    { name: `Local list ${suffix}`, games: ["dota2"] },
    { name: `<img src=x onerror=alert(1)> ${suffix}`, latitude: "24.4539", longitude: "54.3773", games: ["cs2"], city: "Abu Dhabi", kind: "arena" },
  ]) {
    const v = await createVenue(db, owner.user, org.id, { ...base, ...data }); await submitVenue(db, owner.user, v.id); await reviewVenue(db, staff.user, v.id, "confirm", "Local isolated fixture", "0"); venues.push({ ...v, name: data.name });
  }
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/c28-fixture.json", JSON.stringify({ suffix, accounts: { owner, staff, outsider }, org, venues }), { mode: 0o600 });
  console.log("C-28 local fixtures ready; credentials kept in ignored artifacts.");
} finally { await db.close(); }
