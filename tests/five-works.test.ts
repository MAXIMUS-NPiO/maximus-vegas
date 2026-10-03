import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, exportAccount, deleteAccount, type SessionUser } from "../src/server/auth.ts";
import { DomainError } from "../src/server/errors.ts";
import { grantXp, balance, currentSeason } from "../src/server/progression.ts";
import { claimMission, missionWindow, missionStates, setMissionPreference } from "../src/server/missions.ts";
import { saveSocialProfile, discover, likeProfile, conversation, sendSocialMessage, blockProfile, withdrawSocialProfile, reportSocialProfile, resolveSocialReport, socialProfile } from "../src/server/social.ts";

let db: Database, seq = 0;
const password = "secure passphrase for test";
async function account() {
  const name = `work${++seq}`;
  const s = await signUp(db, { email: `${name}@example.com`, username: name, displayName: name, password, adult: "on", terms: "on" });
  return (await sessionUser(db, s.token))!;
}
const reject = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code);
const profile = { intent: "gaming", age: 28, city: "Dubai", game: "cs2", languages: "English", bio: "Looking for friendly teammates", consent: "on" };
test.before(async () => { db = await openDatabase({ embedded: true, dataDir: "memory://" }); });
test.after(async () => { await db.close(); });

test("Pass periods cross UTC day, week and season boundaries without overlap", () => {
  assert.equal(missionWindow("week", new Date("2026-10-04T23:59:59Z")).start.toISOString(), "2026-09-28T00:00:00.000Z");
  assert.equal(missionWindow("week", new Date("2026-10-05T00:00:00Z")).start.toISOString(), "2026-10-05T00:00:00.000Z");
  const first = currentSeason(new Date("2026-09-27T00:00:00Z")), next = currentSeason(first.endsAt);
  assert.equal(next.id, "s2"); assert.equal(next.startsAt.getTime(), first.endsAt.getTime());
});
test("Pass counts distinct confirmed matches, freezes assigned game, and pays once under replay", async () => {
  const u = await account();
  await setMissionPreference(db, u, "cs2");
  const states = await missionStates(db, u.id); assert.equal(states.find(s => s.mission === "daily_play")?.game, "cs2");
  await reject(claimMission(db, u, "daily_play"), "objective_incomplete");
  await setMissionPreference(db, u, "dota2");
  await grantXp(db, [u.id], 50, "match_win", "dota2", "other-game", "other-game");
  await reject(claimMission(db, u, "daily_play"), "objective_incomplete");
  await grantXp(db, [u.id], 50, "match_win", "cs2", "match-one", "one-win");
  await grantXp(db, [u.id], 20, "match_played", "cs2", "match-one", "one-played");
  const results = await Promise.allSettled([claimMission(db, u, "daily_play"), claimMission(db, u, "daily_play")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(await balance(db, u.id), 15);
  assert.equal((await missionStates(db, u.id)).find(s => s.mission === "weekly_play")?.progress, 1);
  const tomorrow = new Date(Date.now() + 86400_000);
  await reject(claimMission(db, u, "daily_play", tomorrow), "objective_incomplete");
});
test("Dating keeps private profiles out, requires reciprocal consent, and restricts conversation access", async () => {
  const a = await account(), b = await account(), outsider = await account();
  await reject(saveSocialProfile(db, a, { ...profile, consent: "" }), "consent_required");
  await saveSocialProfile(db, a, profile); assert.equal((await discover(db, a)).some(p => p.user_id === b.id), false);
  await saveSocialProfile(db, b, { ...profile, intent: "dating" });
  await reject(likeProfile(db, a, b.id), "consent_required");
  await saveSocialProfile(db, b, profile);
  assert.equal(await likeProfile(db, a, b.id), null);
  const match = (await likeProfile(db, b, a.id))!; assert.ok(match);
  await reject(conversation(db, outsider, match), "not_found");
  const client = randomUUID();
  assert.equal(await sendSocialMessage(db, a, match, "Hello teammate", client), await sendSocialMessage(db, a, match, "Hello teammate", client));
  assert.equal((await conversation(db, b, match)).messages.length, 1);
  await blockProfile(db, b, a.id);
  await reject(sendSocialMessage(db, a, match, "Cannot bypass block", randomUUID()), "request_state");
  await reject(likeProfile(db, a, b.id), "not_found");
  await blockProfile(db, b, a.id, true);
  assert.equal(await likeProfile(db, a, b.id), null, "unblocking does not restore consent");
  await likeProfile(db, b, a.id); await withdrawSocialProfile(db, b);
  await reject(sendSocialMessage(db, a, match, "Cannot bypass withdrawal", randomUUID()), "request_state");
});
test("Dating reports disclose only messages addressed to the reporter; moderation suspension cannot be self-cleared", async () => {
  const a = await account(), b = await account(), stranger = await account(), moderator = { ...(await account()), roles: ["moderation"] } as SessionUser;
  await saveSocialProfile(db, a, profile); await saveSocialProfile(db, b, profile);
  await likeProfile(db, a, b.id); const match = (await likeProfile(db, b, a.id))!;
  const id = await sendSocialMessage(db, a, match, "Reported message", randomUUID());
  await reject(reportSocialProfile(db, stranger, a.id, "Not part of the conversation", String(id)), "not_found");
  await reportSocialProfile(db, b, a.id, "Please review the attached message", String(id));
  const [report] = await db.query<{ id: string; excerpt: string }>("select id,excerpt from social_reports where reporter_id=$1", [b.id]);
  assert.equal(report.excerpt, "Reported message");
  await resolveSocialReport(db, moderator, report.id, "Profile hidden following review", true);
  await reject(saveSocialProfile(db, a, profile), "account_restricted");
  assert.equal((await socialProfile(db, a.id))?.visible, false);
  const exported = await exportAccount(db, a); assert.equal(exported.connections.messages.length, 1);
  await deleteAccount(db, a, password);
  assert.equal((await conversation(db, b, match)).messages.length, 0);
  assert.equal((await db.query<{ excerpt: string }>("select excerpt from social_reports where id=$1", [report.id]))[0].excerpt, "");
});
