/** Isolated browser fixture. Session secrets are never committed or printed. */
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/server/db.ts";
import { signUp, sessionUser } from "../src/server/auth.ts";
import { saveSocialProfile, likeProfile } from "../src/server/social.ts";
const url = process.env.PG_TEST_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname) || !new URL(url).pathname.startsWith("/c26_")) throw Error("A local c26_ database is required");
const db = await openDatabase({ url }), suffix = randomUUID().slice(0, 8);
const accounts: Record<string, { id: string; token: string; username: string }> = {};
try {
  for (const name of ["alice", "bob", "charlie", "dana"]) {
    const username = `c26_${name}_${suffix}`;
    const session = await signUp(db, { username, displayName: `Test ${name}`, email: `${username}@example.com`, password: `isolated-${randomUUID()}`, adult: true, terms: true });
    const user = (await sessionUser(db, session.token))!;
    await saveSocialProfile(db, user, { intent: "gaming", age: 28, city: "Test", game: "cs2", languages: "English", bio: "Local browser acceptance fixture", consent: true, gamingConsent: name !== "dana" });
    await db.query("insert into ratings(user_id,game,matches,rating) values($1,'cs2',4,1000)", [user.id]);
    accounts[name] = { id: user.id, token: session.token, username };
  }
  const a = (await sessionUser(db, accounts.alice.token))!, b = (await sessionUser(db, accounts.bob.token))!;
  await likeProfile(db, a, b.id); const matchId = await likeProfile(db, b, a.id);
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/c26-fixture.json", JSON.stringify({ accounts, matchId }), { mode: 0o600 });
  console.log("Local C-26 browser fixture ready; credentials remain private.");
} finally { await db.close(); }
