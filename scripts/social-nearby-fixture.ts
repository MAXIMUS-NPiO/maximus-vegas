/** Disposable local data only; browser session tokens stay in ignored artifacts. */
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/server/db.ts";
import { signUp, sessionUser } from "../src/server/auth.ts";
import { saveSocialProfile } from "../src/server/social.ts";
import { saveNearby } from "../src/server/social-nearby.ts";
import { NEARBY_CONSENT, coarseCell } from "../src/lib/nearby.ts";
const url = process.env.PG_TEST_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname) || !new URL(url).pathname.startsWith("/c27_")) throw Error("A local c27_ database is required");
const db = await openDatabase({ url }), suffix = randomUUID().slice(0, 8);
const accounts: Record<string, { id: string; token: string; username: string }> = {};
try {
  for (const name of ["alice", "bob", "charlie", "dana"]) {
    const username = `c27_${name}_${suffix}`;
    const session = await signUp(db, { username, displayName: `Local ${name}`, email: `${username}@example.com`, password: `isolated-${randomUUID()}`, adult: true, terms: true });
    const user = (await sessionUser(db, session.token))!;
    await saveSocialProfile(db, user, { intent: "gaming", age: 28, city: "Test", game: "cs2", languages: "English", bio: "Local nearby discovery acceptance", consent: true, gamingConsent: name !== "dana" });
    await db.query("insert into ratings(user_id,game,matches,rating) values($1,'cs2',4,1000)", [user.id]);
    if (name === "charlie") await saveNearby(db, user, { ...coarseCell(24.4539, 54.3773), revision: 0, consent: NEARBY_CONSENT });
    accounts[name] = { id: user.id, token: session.token, username };
  }
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/c27-fixture.json", JSON.stringify({ accounts }), { mode: 0o600 });
  console.log("C-27 fixture ready; disposable credentials remain private.");
} finally { await db.close(); }
