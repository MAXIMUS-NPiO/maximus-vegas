/** Isolated browser records; provider assertions here are fixtures, never a live provider acceptance. */
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/server/db.ts";
import { signUp, sessionUser } from "../src/server/auth.ts";
import { createTeam } from "../src/server/teams.ts";
const dataDir = process.env.MV_DATA_DIR;
if (!dataDir?.startsWith("/tmp/c31-")) throw new Error("Isolated /tmp/c31- data directory required");
const db = await openDatabase({ embedded: true, dataDir });
try {
  await mkdir("artifacts", { recursive: true }); const tag = randomUUID().slice(0, 8);
  async function account(prefix: string, displayName: string) {
    const username = `${prefix}_${tag}`, email = `${username}@example.test`;
    const session = await signUp(db, { username, displayName, email, password: `test-${randomUUID()}`, adult: true, terms: true });
    await db.query("update users set email_verified_at=now(),profile_public=true where username=$1", [username]);
    await writeFile(`artifacts/c31-${prefix}-state.json`, JSON.stringify({ cookies: [{ name: "mv_session", value: session.token, domain: "127.0.0.1", path: "/", httpOnly: true, secure: false, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 86400 }], origins: [] }), { mode: 0o600 });
    return { user: (await sessionUser(db, session.token))!, email };
  }
  const captain = await account("leader", "Invitation captain"), player = await account("veteran", "Experienced player"), stranger = await account("other", "Another player");
  const team = await createTeam(db, captain.user, { name: "Player passport acceptance", tag: "C31", game: "cs2" });
  const steamId = "76561198000000001";
  await db.query("insert into player_experience_identities(user_id,steam_id,consent_version) values($1,$2,'acceptance-fixture')", [player.user.id, steamId]);
  const records = [{ game: "dota2", sourceUrl: "https://www.opendota.com/players/39734273", rank: "Ancient IV", metrics: { matches: 1842, wins: 1031 }, recentMatches: [{ id: "9000000001", playedAt: "2026-10-03T12:00:00Z", sourceUrl: "https://www.opendota.com/matches/9000000001", result: "win", metrics: { kills: 12, deaths: 3, assists: 18 } }] }];
  const [connection] = await db.query<{ id: string }>("insert into player_experience_connections(user_id,provider,external_id,display_name,status,shared,consent_version,verified_at,last_success_at,next_sync_at,records) values($1,'opendota','39734273','Veteran external fixture','available',true,'acceptance-fixture',now(),now(),now()+interval '1 day',$2) returning id", [player.user.id, JSON.stringify(records)]);
  await writeFile("artifacts/c31-fixture.json", JSON.stringify({ captain: captain.user.username, player: player.user.username, playerEmail: player.email, stranger: stranger.user.username, team, connectionId: connection.id, newUsername: `new_${tag}`, newEmail: `new_${tag}@example.test` }), { mode: 0o600 });
  console.log("C31 isolated invitation and experience records prepared.");
} finally { await db.close(); }
