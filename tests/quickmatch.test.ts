import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { deleteAccount, exportAccount, signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { challengesFor, confirmChallenge, reportChallenge } from "../src/server/challenges.ts";
import {
  answerReadyCheck,
  createParty,
  inviteToParty,
  joinQuickMatch,
  leaveParty,
  leaveQuickMatch,
  partyView,
  pulseQueue,
  queueView,
  removeFromParty,
  respondPartyInvite,
  revokePartyInvite,
} from "../src/server/quickmatch.ts";
import { ratingHistory, ratingsFor } from "../src/server/rating.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
const PASSWORD = "correct horse battery";
async function mk(name: string): Promise<SessionUser> {
  const s = await signUp(db, { email: `${name}@example.com`, username: name, displayName: name.toUpperCase(), password: PASSWORD, adult: "on", terms: "on" });
  return (await sessionUser(db, s.token))!;
}
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}
const notes = (userId: string, kind: string) => db.query<{ data: Record<string, string> }>("select data from notifications where user_id = $1 and kind = $2", [userId, kind]);
const queued = async (game: string) =>
  (await db.query<{ user_id: string; party_id: string | null; held_by: string | null }>("select user_id, party_id, held_by from quick_queue where game = $1 order by user_id", [game]));
async function party(leader: SessionUser, game: string, mates: SessionUser[]) {
  await createParty(db, leader, game);
  for (const m of mates) {
    await inviteToParty(db, leader, m.username);
    const [inv] = await db.query<{ id: string }>("select id from party_invites where user_id = $1 and status = 'pending'", [m.id]);
    await respondPartyInvite(db, m, inv.id, true);
  }
}
/** Moves a ready check's deadline into the past, as if 90 seconds went by. */
const expire = (checkId: string) => db.query("update ready_checks set expires_at = now() - interval '1 second' where id = $1", [checkId]);

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
});
test.after(async () => {
  await db.close();
});

test("solo ready check: both confirm, the match exists, the confirmed result moves both ratings once", async () => {
  const a = await mk("qa_solo");
  const b = await mk("qb_solo");
  assert.equal((await joinQuickMatch(db, a, "cs2", "MENA")).readyCheck, null);
  const { readyCheck } = await joinQuickMatch(db, b, "cs2", "mena");
  assert.ok(readyCheck);
  assert.equal((await notes(a.id, "ready_check")).length, 1, "both players are called to confirm");
  // A queue place that runs out during the check keeps the check visible until it ends.
  await db.query("update quick_queue set expires_at = now() - interval '1 second' where user_id = $1", [a.id]);
  const view = await queueView(db, a.id);
  assert.equal(view.check?.id, readyCheck);
  assert.equal(view.check?.reasons.region, "same");
  assert.deepEqual(view.check?.other, { total: 1, ready: 0 }, "the opponent is shown as a count, not by name");
  assert.equal((await answerReadyCheck(db, a, readyCheck, true)).status, "pending");
  assert.equal((await answerReadyCheck(db, a, readyCheck, true)).status, "pending", "a repeated confirmation changes nothing");
  const done = await answerReadyCheck(db, b, readyCheck, true);
  assert.equal(done.status, "passed");
  await rejects(answerReadyCheck(db, a, readyCheck, false), "ready_check_closed");
  assert.equal((await queued("cs2")).length, 0, "the players leave the queue");
  const [members] = await db.query<{ n: number }>("select count(*)::int as n from challenge_members where challenge_id = $1", [done.challengeId]);
  assert.equal(members.n, 2);
  // Result: the challenger reports, the opponent confirms; ratings move once.
  const [c] = await db.query<{ challenger_id: string }>("select challenger_id from challenges where id = $1", [done.challengeId]);
  const [first, second] = c.challenger_id === a.id ? [a, b] : [b, a];
  await reportChallenge(db, first, done.challengeId!, { result: "won", myScore: "13", theirScore: "9", evidenceUrl: "" });
  await confirmChallenge(db, second, done.challengeId!);
  const [r1] = await ratingsFor(db, first.id);
  const [r2] = await ratingsFor(db, second.id);
  assert.deepEqual([r1.rating, r1.wins, r1.matches, r1.peak], [1020, 1, 1, 1020]);
  assert.deepEqual([r2.rating, r2.losses, r2.matches, r2.peak], [980, 1, 1, 1000]);
  const [h] = await ratingHistory(db, second.id, "cs2");
  assert.deepEqual([h.result, h.before, h.after, h.delta], ["loss", 1000, 980, -20]);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("a decline sends the decliner out with a cooldown; the other player keeps their place and pairs again", async () => {
  const a = await mk("qa_dec");
  const b = await mk("qb_dec");
  const c = await mk("qc_dec");
  await joinQuickMatch(db, a, "valorant");
  const [aRow] = await db.query<{ joined_at: Date }>("select joined_at from quick_queue where user_id = $1", [a.id]);
  const { readyCheck } = await joinQuickMatch(db, b, "valorant");
  await answerReadyCheck(db, a, readyCheck, true);
  assert.equal((await answerReadyCheck(db, b, readyCheck, false)).status, "failed");
  const rows = await queued("valorant");
  assert.deepEqual(rows.map((r) => [r.user_id, r.held_by]), [[a.id, null]], "the player who confirmed is back; the decliner is out");
  const [again] = await db.query<{ joined_at: Date }>("select joined_at from quick_queue where user_id = $1", [a.id]);
  assert.equal(new Date(again.joined_at).getTime(), new Date(aRow.joined_at).getTime(), "back in the original place");
  assert.equal((await notes(a.id, "ready_check_returned")).length, 1);
  assert.equal((await notes(b.id, "ready_check_dodged"))[0]?.data.minutes, "5");
  await rejects(joinQuickMatch(db, b, "valorant"), "queue_cooldown");
  assert.ok((await queueView(db, b.id)).cooldownUntil, "the page shows until when");
  // A third player pairs with the returned one at once.
  const next = await joinQuickMatch(db, c, "valorant");
  assert.ok(next.readyCheck);
  // Leaving the queue during a check counts as declining it.
  assert.deepEqual(await leaveQuickMatch(db, c), { left: true });
  assert.deepEqual((await queued("valorant")).map((r) => [r.user_id, r.held_by]), [[a.id, null]]);
  assert.equal((await notes(c.id, "ready_check_dodged")).length, 1);
  assert.deepEqual(await leaveQuickMatch(db, a), { left: true });
  assert.deepEqual(await leaveQuickMatch(db, a), { left: false });
});

test("an expired ready check returns the players who confirmed and removes the silent ones", async () => {
  const a = await mk("qa_exp");
  const b = await mk("qb_exp");
  await joinQuickMatch(db, a, "apex");
  const { readyCheck } = await joinQuickMatch(db, b, "apex");
  await answerReadyCheck(db, a, readyCheck, true);
  await expire(readyCheck!);
  // The late answer settles the overdue check and is refused.
  const late = await answerReadyCheck(db, b, readyCheck, true);
  assert.deepEqual(late, { status: "failed", challengeId: null, expired: true });
  assert.deepEqual((await queued("apex")).map((r) => [r.user_id, r.held_by]), [[a.id, null]]);
  const [dodge] = await db.query<{ kind: string }>("select kind from quick_dodges where user_id = $1", [b.id]);
  assert.equal(dodge.kind, "missed");
  // Without any answer the next view of the queue settles it.
  const c = await mk("qc_exp");
  const second = await joinQuickMatch(db, c, "apex");
  await expire(second.readyCheck!);
  assert.deepEqual(await pulseQueue(db, "apex"), { settled: 1, opened: 0 });
  assert.equal((await queued("apex")).length, 0, "nobody confirmed: both leave the queue");
  const last = await queueView(db, a.id);
  assert.equal(last.last?.outcome, "dodged");
});

test("parties: invitations, leader-only search, atomic queueing, same-size pairing, frozen roster, shared result and ratings", async () => {
  const [l1, m1, l2, m2, solo] = [await mk("qp_l1"), await mk("qp_m1"), await mk("qp_l2"), await mk("qp_m2"), await mk("qp_solo")];
  await createParty(db, l1, "dota2");
  await rejects(createParty(db, l1, "dota2"), "already_in_party");
  await rejects(inviteToParty(db, m1, l1.username), "not_in_party");
  assert.deepEqual(await inviteToParty(db, l1, m1.username), { created: true });
  assert.deepEqual(await inviteToParty(db, l1, m1.username), { created: false }, "one pending invitation per player");
  await rejects(joinQuickMatch(db, l1, "dota2"), "party_too_small");
  const [inv] = await db.query<{ id: string }>("select id from party_invites where user_id = $1 and status = 'pending'", [m1.id]);
  await respondPartyInvite(db, m1, inv.id, true);
  assert.equal((await notes(l1.id, "party_joined")).length, 1);
  await rejects(joinQuickMatch(db, m1, "dota2"), "not_party_leader");
  await party(l2, "dota2", [m2]);
  // A solo player waiting first does not meet a party.
  await joinQuickMatch(db, solo, "dota2");
  assert.equal((await joinQuickMatch(db, l1, "dota2")).readyCheck, null, "a party of two does not meet a solo player");
  const rows = await queued("dota2");
  const p1 = rows.filter((r) => r.party_id);
  assert.equal(p1.length, 2, "the party is queued whole");
  await rejects(joinQuickMatch(db, m1, "dota2"), "not_party_leader");
  // The second party arrives: a 2 v 2 ready check holds both parties.
  const { readyCheck } = await joinQuickMatch(db, l2, "dota2");
  assert.ok(readyCheck);
  const view = await queueView(db, m2.id);
  assert.equal(view.check?.size, 2);
  assert.equal(view.check?.own.length, 2);
  await rejects(leaveParty(db, m1), "ready_check_pending");
  await rejects(inviteToParty(db, l1, solo.username), "party_queued");
  for (const p of [l1, m1, l2]) assert.equal((await answerReadyCheck(db, p, readyCheck, true)).status, "pending");
  const done = await answerReadyCheck(db, m2, readyCheck, true);
  assert.equal(done.status, "passed");
  assert.deepEqual((await queued("dota2")).map((r) => r.user_id), [solo.id], "only the solo player still waits");
  // Every player sees the match; only the two leaders act.
  const seen = (await challengesFor(db, m1.id)).find((c) => c.id === done.challengeId);
  assert.ok(seen);
  assert.equal(seen.side_size, 2);
  const [match] = await db.query<{ challenger_id: string; opponent_id: string }>("select challenger_id, opponent_id from challenges where id = $1", [done.challengeId]);
  assert.deepEqual([match.challenger_id, match.opponent_id].sort(), [l1.id, l2.id].sort(), "the match is between the leaders");
  await rejects(reportChallenge(db, m1, done.challengeId!, { result: "won", myScore: "", theirScore: "", evidenceUrl: "" }), "forbidden");
  const winnerLeader = match.challenger_id === l1.id ? l1 : l2;
  const loserLeader = winnerLeader === l1 ? l2 : l1;
  await reportChallenge(db, winnerLeader, done.challengeId!, { result: "won", myScore: "", theirScore: "", evidenceUrl: "" });
  await confirmChallenge(db, loserLeader, done.challengeId!);
  const winners = winnerLeader === l1 ? [l1, m1] : [l2, m2];
  const losers = winnerLeader === l1 ? [l2, m2] : [l1, m1];
  for (const w of winners) assert.equal((await ratingsFor(db, w.id))[0].rating, 1020);
  for (const l of losers) assert.equal((await ratingsFor(db, l.id))[0].rating, 980);
  const [xp] = await db.query<{ n: number }>("select count(*)::int as n from xp_events where ref = $1", [done.challengeId]);
  assert.equal(xp.n, 4, "every player of both sides gets XP");
  // After the match the roster can change again.
  assert.deepEqual(await removeFromParty(db, l1, m1.id), { changed: true });
  assert.equal((await notes(m1.id, "party_removed")).length, 1);
  assert.deepEqual(await leaveParty(db, l2), { disbanded: true });
  assert.equal((await partyView(db, m2.id)).party, null, "the leader leaving disbands the party");
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("a party member cancelling the search takes the whole party out; a decline inside a party removes the party only", async () => {
  const [l1, m1, l2, m2] = [await mk("qx_l1"), await mk("qx_m1"), await mk("qx_l2"), await mk("qx_m2")];
  await party(l1, "pubg", [m1]);
  await party(l2, "pubg", [m2]);
  await joinQuickMatch(db, l1, "pubg");
  assert.deepEqual(await leaveQuickMatch(db, m1), { left: true });
  assert.equal((await queued("pubg")).length, 0, "any member cancels the party's search");
  assert.equal((await notes(l1.id, "party_queue_left")).length, 1);
  await joinQuickMatch(db, l1, "pubg");
  const { readyCheck } = await joinQuickMatch(db, l2, "pubg");
  await answerReadyCheck(db, l1, readyCheck, true);
  await answerReadyCheck(db, m2, readyCheck, false);
  const rows = await queued("pubg");
  assert.deepEqual(rows.map((r) => r.user_id).sort(), [l1.id, m1.id].sort(), "the declining player's party leaves; the other party keeps its place");
  assert.ok(rows.every((r) => r.held_by === null));
  assert.equal((await notes(l2.id, "ready_check_removed")).length, 1, "the decliner's leader learns why");
  assert.equal((await db.query("select 1 from quick_dodges where user_id = $1", [l2.id])).length, 0, "only the player who declined gets a cooldown");
});

test("party limits: five players with pending invitations, joining a queued party is refused, invitations can be withdrawn", async () => {
  const leader = await mk("ql_lead");
  const others = [await mk("ql_p1"), await mk("ql_p2"), await mk("ql_p3"), await mk("ql_p4"), await mk("ql_p5")];
  await createParty(db, leader, "fortnite");
  for (const p of others.slice(0, 4)) await inviteToParty(db, leader, p.username);
  await rejects(inviteToParty(db, leader, others[4].username), "party_full");
  const [last] = await db.query<{ id: string }>("select id from party_invites where user_id = $1 and status = 'pending'", [others[3].id]);
  assert.deepEqual(await revokePartyInvite(db, leader, last.id), { changed: true });
  await rejects(respondPartyInvite(db, others[3], last.id, true), "invite_not_found");
  const [first] = await db.query<{ id: string }>("select id from party_invites where user_id = $1 and status = 'pending'", [others[0].id]);
  await respondPartyInvite(db, others[0], first.id, true);
  await joinQuickMatch(db, leader, "fortnite");
  const [second] = await db.query<{ id: string }>("select id from party_invites where user_id = $1 and status = 'pending'", [others[1].id]);
  await rejects(respondPartyInvite(db, others[1], second.id, true), "party_queued");
  await respondPartyInvite(db, others[1], second.id, false);
  assert.equal((await notes(leader.id, "party_declined")).length, 1);
  // A queued solo player cannot join a party.
  const loner = await mk("ql_loner");
  await joinQuickMatch(db, loner, "cs2");
  await rejects(createParty(db, loner, "cs2"), "already_queued");
});

test("rating window: a large gap waits until the window opens; account deletion erases parties, ratings and cooldowns", async () => {
  const strong = await mk("qr_strong");
  const weak = await mk("qr_weak");
  await db.query("insert into ratings (user_id, game, rating, matches, peak) values ($1, 'lol', 1700, 40, 1700)", [strong.id]);
  await joinQuickMatch(db, strong, "lol");
  assert.equal((await joinQuickMatch(db, weak, "lol")).readyCheck, null, "a 700-point gap is outside the first window");
  await db.query("update quick_queue set joined_at = now() - interval '6 minutes' where user_id = $1", [strong.id]);
  assert.deepEqual(await pulseQueue(db, "lol"), { settled: 0, opened: 1 }, "after five minutes of waiting any gap is accepted");
  const view = await queueView(db, weak.id);
  assert.equal(view.check?.reasons.window, null);
  assert.equal(view.check?.reasons.gap, 700);
  // Export and erasure.
  await leaveQuickMatch(db, weak);
  const data = (await exportAccount(db, strong)) as unknown as { quickRatings: unknown[]; queueCooldowns: unknown[] };
  assert.equal(data.quickRatings.length, 1);
  assert.equal(data.queueCooldowns.length, 0);
  const mate = await mk("qr_mate");
  await party(weak, "lol", [mate]);
  await deleteAccount(db, weak, PASSWORD);
  assert.equal((await partyView(db, mate.id)).party, null, "the deleted leader's party is disbanded");
  await deleteAccount(db, strong, PASSWORD);
  const [left] = await db.query<{ ratings: number; dodges: number }>(
    "select (select count(*)::int from ratings where user_id = $1) as ratings, (select count(*)::int from quick_dodges where user_id = $2) as dodges",
    [strong.id, weak.id],
  );
  assert.deepEqual(left, { ratings: 0, dodges: 0 });
});
