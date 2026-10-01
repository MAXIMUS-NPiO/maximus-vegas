import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import {
  balance,
  buyCosmetic,
  claimObjective,
  claimPassTier,
  equipCosmetic,
  grantXp,
  moveCoins,
  objectiveStates,
  rankFor,
  redeemReferral,
  referralCode,
  SEASON,
  unlockPremium,
} from "../src/server/progression.ts";
import {
  cancelChallenge,
  confirmChallenge,
  createChallenge,
  disputeChallenge,
  reportChallenge,
  resolveChallenge,
  respondChallenge,
} from "../src/server/challenges.ts";
import { answerReadyCheck, joinQuickMatch } from "../src/server/quickmatch.ts";
import { createSponsor, activeSponsors } from "../src/server/sponsors.ts";
import { sniffImage } from "../src/server/media.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}
async function mk(name: string): Promise<SessionUser> {
  const s = await signUp(db, { email: `${name}@example.com`, username: name, displayName: name, password: "correct horse battery", adult: "on", terms: "on" });
  return (await sessionUser(db, s.token))!;
}

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
});
test.after(async () => {
  await db.close();
});

test("coins are earn-only and idempotent; balances never go negative", async () => {
  const u = await mk("coiner");
  assert.equal(await moveCoins(db, u.id, 100, "test", "", "k1"), true);
  assert.equal(await moveCoins(db, u.id, 100, "test", "", "k1"), false, "same key never credits twice");
  assert.equal(await balance(db, u.id), 100);
  await rejects(moveCoins(db, u.id, -101, "spend", "", "k2"), "insufficient_coins");
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => moveCoins(db, u.id, -30, "spend", "", `race-${i}`).catch((e) => (e as DomainError).code)));
  assert.equal(results.filter((r) => r === true).length, 3);
  assert.equal(await balance(db, u.id), 10);
});

test("objectives are evaluated against real state and paid once", async () => {
  const u = await mk("achiever");
  await rejects(claimObjective(db, u, "link_game"), "objective_incomplete");
  await db.query("insert into linked_game_accounts (user_id, game, handle) values ($1, 'cs2', 'achiever_cs')", [u.id]);
  await claimObjective(db, u, "link_game");
  await rejects(claimObjective(db, u, "link_game"), "already_claimed");
  assert.equal(await balance(db, u.id), 50);
  const states = await objectiveStates(db, u.id);
  assert.equal(states.find((s) => s.id === "link_game")?.claimed, true);
  assert.equal(states.find((s) => s.id === "first_win")?.achieved, false);
});

test("ranks, shop, pass tiers and the premium track", async () => {
  assert.equal(rankFor(0).rank.key, "rookie");
  assert.equal(rankFor(250).rank.key, "bronze");
  assert.equal(rankFor(16000).next, null);
  const u = await mk("passer");
  await rejects(buyCosmetic(db, u, "violet"), "insufficient_coins");
  await moveCoins(db, u.id, 2000, "test", "", "seed-passer");
  await buyCosmetic(db, u, "violet");
  await rejects(buyCosmetic(db, u, "violet"), "already_owned");
  await rejects(buyCosmetic(db, u, "neon"), "not_found", );
  await equipCosmetic(db, u, "violet");
  await rejects(equipCosmetic(db, u, "gold"), "not_owned");
  await rejects(claimPassTier(db, u, 2, "free"), "tier_locked");
  await grantXp(db, [u.id], 600, "test", "", "", "xp-passer");
  await claimPassTier(db, u, 2, "free");
  await rejects(claimPassTier(db, u, 2, "free"), "already_claimed");
  await rejects(claimPassTier(db, u, 1, "premium"), "premium_locked");
  await unlockPremium(db, u);
  await claimPassTier(db, u, 1, "premium");
  assert.equal(await balance(db, u.id), 2000 - 200 + 50 - SEASON.premiumPrice + 60);
});

test("referrals: one redemption, not your own code, reward to the referrer only after a real match", async () => {
  const a = await mk("referrer");
  const b = await mk("referee");
  const code = await referralCode(db, a.id);
  assert.equal(await referralCode(db, a.id), code, "stable code");
  await rejects(redeemReferral(db, a, code), "invalid_referral");
  await rejects(redeemReferral(db, b, "ZZZZZZZZ"), "invalid_referral");
  await redeemReferral(db, b, code);
  await rejects(redeemReferral(db, b, code), "already_claimed");
  assert.equal(await balance(db, b.id), 100);
  assert.equal(await balance(db, a.id), 0, "no reward before the referee plays");
  await grantXp(db, [b.id], 20, "match_played", "cs2", "m1", "match:m1:played");
  assert.equal(await balance(db, a.id), 100);
  await grantXp(db, [b.id], 20, "match_played", "cs2", "m2", "match:m2:played");
  assert.equal(await balance(db, a.id), 100, "rewarded once");
});

test("challenges: stake-free, named opponent, report → confirm; disputes go to staff", async () => {
  const a = await mk("challenger");
  const b = await mk("defender");
  const staff = await mk("support1");
  await db.query("insert into user_roles (user_id, role) values ($1, 'support')", [staff.id]);
  const staffUser = { ...staff, roles: ["support" as const] };
  await rejects(createChallenge(db, a, { opponent: "challenger", game: "cs2", message: "" }), "cannot_challenge_self");
  const id = await createChallenge(db, a, { opponent: "defender", game: "cs2", message: "gg" });
  await rejects(createChallenge(db, a, { opponent: "defender", game: "cs2", message: "" }), "challenge_exists");
  const [cols] = await db.query<{ n: number }>("select count(*)::int as n from information_schema.columns where table_name = 'challenges' and column_name like '%stake%'");
  assert.equal(cols.n, 0, "there is no stake field at all");
  await rejects(respondChallenge(db, a, id, true), "forbidden");
  await respondChallenge(db, b, id, true);
  await rejects(reportChallenge(db, a, id, { result: "won", myScore: "1", theirScore: "2", evidenceUrl: "" }), "invalid_input");
  await reportChallenge(db, a, id, { result: "won", myScore: "2", theirScore: "1", evidenceUrl: "" });
  await rejects(confirmChallenge(db, a, id), "own_result");
  await confirmChallenge(db, b, id);
  const [done] = await db.query<{ status: string; winner_id: string }>("select status, winner_id from challenges where id = $1", [id]);
  assert.equal(done.status, "completed");
  assert.equal(done.winner_id, a.id);
  const id2 = await createChallenge(db, b, { opponent: "challenger", game: "cs2", message: "" });
  await respondChallenge(db, a, id2, true);
  await reportChallenge(db, b, id2, { result: "won", myScore: "", theirScore: "", evidenceUrl: "" });
  await disputeChallenge(db, a, id2, "I actually won that one");
  await rejects(resolveChallenge(db, a, id2, a.id, "self decision"), "forbidden");
  await resolveChallenge(db, staffUser, id2, a.id, "Replay reviewed");
  const [r] = await db.query<{ winner_id: string }>("select winner_id from challenges where id = $1", [id2]);
  assert.equal(r.winner_id, a.id);
  const id3 = await createChallenge(db, a, { opponent: "defender", game: "dota2", message: "" });
  await cancelChallenge(db, a, id3);
});

test("quick match pairs only real queued players for the same game, never the player with themselves", async () => {
  const x = await mk("quickx");
  const y = await mk("quicky");
  const z = await mk("quickz");
  const first = await joinQuickMatch(db, x, "valorant");
  assert.equal(first.readyCheck, null, "nobody waiting: queued, not matched with an invented opponent");
  await rejects(joinQuickMatch(db, x, "valorant"), "already_queued");
  const other = await joinQuickMatch(db, z, "lol");
  assert.equal(other.readyCheck, null, "different game does not pair");
  const second = await joinQuickMatch(db, y, "valorant");
  assert.ok(second.readyCheck, "a real waiting player is found; both confirm before the match exists");
  assert.equal((await answerReadyCheck(db, x, second.readyCheck, true)).status, "pending");
  const done = await answerReadyCheck(db, y, second.readyCheck, true);
  assert.equal(done.status, "passed");
  const [c] = await db.query<{ kind: string; status: string; challenger_id: string; opponent_id: string }>("select * from challenges where id = $1", [done.challengeId]);
  assert.equal(c.kind, "quick");
  assert.equal(c.status, "accepted");
  assert.deepEqual([c.challenger_id, c.opponent_id].sort(), [x.id, y.id].sort());
  const [left] = await db.query<{ n: number }>("select count(*)::int as n from quick_queue where user_id in ($1, $2)", [x.id, y.id]);
  assert.equal(left.n, 0);
});

test("sponsors are admin records; uploads are identified by signature, not by claimed type", async () => {
  const u = await mk("notadmin");
  await rejects(createSponsor(db, u, { name: "Acme", tier: "gold", website: "" }), "forbidden");
  assert.equal((await activeSponsors(db)).length, 0, "no sponsor is shown until a real record exists");
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>")), null, "SVG and HTML are refused");
});
