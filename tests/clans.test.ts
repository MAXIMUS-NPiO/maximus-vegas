import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { deleteAccount, exportAccount, signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import {
  answerWar,
  cancelWar,
  clanBySlug,
  clanLadder,
  clanOf,
  clanRecord,
  clanSeason,
  clanWars,
  confirmWar,
  createClan,
  decideWar,
  disputeWar,
  inviteToClan,
  ladderSeasons,
  leaveClan,
  listClans,
  myClanInvites,
  openWarDisputes,
  playerLadder,
  proposeWar,
  removeClanMember,
  reportWar,
  respondClanInvite,
  setClanRole,
  setWarLineup,
  settleWars,
} from "../src/server/clans.ts";
import { seasonOf } from "../src/server/ladder-rules.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
const PASSWORD = "correct horse battery";
const tokens = new Map<string, string>();
async function mk(name: string): Promise<SessionUser> {
  const s = await signUp(db, { email: `${name}@example.com`, username: name, displayName: name.toUpperCase(), password: PASSWORD, adult: "on", terms: "on" });
  tokens.set(name, s.token);
  return (await sessionUser(db, s.token))!;
}
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}
async function join(clanId: string, leader: SessionUser, player: SessionUser) {
  const invite = await inviteToClan(db, leader, clanId, player.username);
  await respondClanInvite(db, player, invite.id, true);
}
/** A start time `minutes` from now as the form sends it: wall clock in UTC. */
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().slice(0, 16);
const war = (id: string) => db.query<Record<string, unknown>>("select * from clan_wars where id = $1", [id]).then((r) => r[0]);
const ladder = async (game: string, season: string) => (await clanLadder(db, season, game)).map((r) => `${r.tag}:${r.rating}:${r.wins}-${r.losses}`);

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
});
test.after(async () => {
  await db.close();
});

test("clans: one clan per player, unique tag and name, invitations, officers, ownership, leaving and disbanding", async () => {
  const [o, p1, p2, p3, other] = [await mk("cl_o"), await mk("cl_p1"), await mk("cl_p2"), await mk("cl_p3"), await mk("cl_other")];
  await rejects(createClan(db, o, { name: "Vegas Lions", tag: "V", description: "" }), "invalid_clan_tag");
  const lions = await createClan(db, o, { name: "Vegas Lions", tag: " vgl ", description: "Играем по вечерам." });
  const data = (await clanBySlug(db, lions.slug))!;
  assert.equal(data.clan.tag, "VGL");
  assert.deepEqual(data.members.map((m) => `${m.username}:${m.role}`), ["cl_o:owner"]);
  await rejects(createClan(db, o, { name: "Second", tag: "SEC", description: "" }), "clan_already_member");
  await rejects(createClan(db, other, { name: "Copycats", tag: "VGL", description: "" }), "clan_tag_taken");
  await rejects(createClan(db, other, { name: "vegas lions", tag: "VGX", description: "" }), "clan_name_taken");
  const rivals = await createClan(db, other, { name: "Rivals", tag: "RIV", description: "" });

  const invite = await inviteToClan(db, o, lions.id, p1.username);
  await rejects(inviteToClan(db, o, lions.id, p1.username), "already_invited");
  await rejects(inviteToClan(db, o, lions.id, other.username), "clan_already_member");
  await respondClanInvite(db, p1, invite.id, true);
  await rejects(inviteToClan(db, p1, lions.id, p2.username), "not_clan_leader");
  await setClanRole(db, o, lions.id, p1.id, "officer");
  // p2 has two invitations; joining one clan lets the other lapse.
  const fromRivals = await inviteToClan(db, other, rivals.id, p2.username);
  await join(lions.id, p1, p2);
  assert.equal((await myClanInvites(db, p2.id)).length, 0);
  await rejects(respondClanInvite(db, p2, fromRivals.id, true), "invite_not_found");
  await join(lions.id, o, p3);
  await setClanRole(db, o, lions.id, p2.id, "officer");
  await rejects(removeClanMember(db, p1, lions.id, p2.id), "forbidden");
  await rejects(removeClanMember(db, p1, lions.id, o.id), "forbidden");
  await removeClanMember(db, p1, lions.id, p3.id);
  await rejects(leaveClan(db, o, lions.id), "clan_owner_cannot_leave");
  await rejects(setClanRole(db, p1, lions.id, p2.id, "member"), "forbidden");
  await setClanRole(db, o, lions.id, p1.id, "owner");
  const roles = (await clanBySlug(db, lions.slug))!.members.map((m) => `${m.username}:${m.role}`);
  assert.deepEqual(roles, ["cl_p1:owner", "cl_o:officer", "cl_p2:officer"]);
  assert.equal((await clanOf(db, o.id))?.role, "officer");
  await leaveClan(db, o, lions.id);
  await leaveClan(db, p2, lions.id);
  assert.deepEqual(await leaveClan(db, p1, lions.id), { disbanded: true });
  assert.equal((await clanBySlug(db, lions.slug))!.clan.status, "disbanded");
  assert.ok(!(await listClans(db)).some((c) => c.id === lions.id), "a disbanded clan leaves the list");
  // The tag is free again once the clan is gone.
  const again = await createClan(db, p1, { name: "Vegas Lions", tag: "VGL", description: "" });
  assert.notEqual(again.slug, lions.slug);
  assert.equal((await listClans(db, "vgl")).length, 1);
  assert.equal((await listClans(db, "%")).length, 0, "wildcards are literal");
});

test("clan war: proposal rules, lineups, report, confirmation, ladder; repeat pair within 7 days is unrated", async () => {
  const [a1, a2, a3, b1, b2, b3, s1] = [await mk("w_a1"), await mk("w_a2"), await mk("w_a3"), await mk("w_b1"), await mk("w_b2"), await mk("w_b3"), await mk("w_s1")];
  const A = await createClan(db, a1, { name: "Alpha Clan", tag: "ALP", description: "" });
  const B = await createClan(db, b1, { name: "Bravo Clan", tag: "BRV", description: "" });
  const S = await createClan(db, s1, { name: "Solo Clan", tag: "SOL", description: "" });
  await join(A.id, a1, a2);
  await join(A.id, a1, a3);
  await join(B.id, b1, b2);
  await join(B.id, b1, b3);
  const base = { opponent: "brv", game: "cs2", sideSize: "2", bestOf: "3", at: at(60), tz: "UTC", lineup: [a1.id, a2.id], message: "Вечерняя серия" };
  await rejects(proposeWar(db, a1, A.id, { ...base, game: "apex" }), "invalid_game");
  await rejects(proposeWar(db, a1, A.id, { ...base, sideSize: "6" }), "invalid_input");
  await rejects(proposeWar(db, a1, A.id, { ...base, bestOf: "2" }), "invalid_input");
  await rejects(proposeWar(db, a1, A.id, { ...base, at: at(5) }), "war_time");
  await rejects(proposeWar(db, a1, A.id, { ...base, at: at(15 * 24 * 60) }), "war_time");
  await rejects(proposeWar(db, a1, A.id, { ...base, lineup: [a1.id] }), "war_lineup");
  await rejects(proposeWar(db, a1, A.id, { ...base, lineup: [a1.id, b2.id] }), "war_lineup");
  await rejects(proposeWar(db, a1, A.id, { ...base, opponent: "alp" }), "war_same_clan");
  await rejects(proposeWar(db, a2, A.id, base), "not_clan_leader");
  await rejects(proposeWar(db, a1, A.id, { ...base, opponent: "SOL" }), "clan_too_small");
  // A fair-play restriction on quick match and challenges keeps a player out of lineups.
  const [rule] = await db.query<{ code: string; version: number }>("select code, version from conduct_rules order by code limit 1");
  const [sanction] = await db.query<{ id: string }>(
    `insert into sanctions (user_id, kind, rule_code, rule_version, confidence, evidence, evidence_hash, decision, issued_by, ends_at)
     values ($1, 'queue_ban', $2, $3, 'high', '[]', 'x', 'Проверочная мера для теста составов.', $4, now() + interval '1 day') returning id`,
    [a2.id, rule.code, rule.version, s1.id],
  );
  await rejects(proposeWar(db, a1, A.id, base), "war_lineup_restricted");
  await db.query("update sanctions set revoked_at = now() where id = $1", [sanction.id]);

  const w1 = await proposeWar(db, a1, A.id, base);
  await rejects(proposeWar(db, a1, A.id, base), "war_open_exists");
  await rejects(proposeWar(db, b1, B.id, { ...base, opponent: "ALP", lineup: [b1.id, b2.id] }), "war_open_exists");
  await rejects(answerWar(db, b2, w1.id, "accept", [b1.id, b2.id]), "forbidden");
  await rejects(answerWar(db, a1, w1.id, "accept", [a1.id, a2.id]), "forbidden");
  await rejects(answerWar(db, b1, w1.id, "accept", [b1.id]), "war_lineup");
  // The challenger may swap its lineup while the proposal waits; the opponent answers instead.
  await setWarLineup(db, a1, w1.id, [a1.id, a3.id]);
  await rejects(setWarLineup(db, b1, w1.id, [b1.id, b2.id]), "forbidden");
  assert.deepEqual(await answerWar(db, b1, w1.id, "accept", [b1.id, b2.id]), { status: "accepted" });
  await setWarLineup(db, b1, w1.id, [b2.id, b3.id]);
  await rejects(reportWar(db, a1, w1.id, "2", "1"), "war_not_started");
  // Started two hours ago (an accepted war without a report lapses after 72 hours).
  await db.query("update clan_wars set scheduled_at = now() - interval '2 hours' where id = $1", [w1.id]);
  await rejects(setWarLineup(db, a1, w1.id, [a1.id, a2.id]), "war_started");
  await rejects(cancelWar(db, b1, w1.id), "war_started");
  await rejects(reportWar(db, a1, w1.id, "3", "1"), "war_score");
  await reportWar(db, a1, w1.id, "2", "1");
  await rejects(confirmWar(db, a2, w1.id), "forbidden");
  await rejects(confirmWar(db, a1, w1.id), "war_own_report");
  await db.query("update clan_wars set scheduled_at = now() - interval '20 days' where id = $1", [w1.id]);
  await confirmWar(db, b1, w1.id);
  const done = await war(w1.id);
  assert.equal(done.status, "completed");
  assert.equal(done.winner_id, A.id);
  assert.equal(done.rated, true);
  const season = seasonOf(done.scheduled_at as Date);
  assert.equal(done.season, season);
  assert.deepEqual(await ladder("cs2", season), ["ALP:1016:1-0", "BRV:984:0-1"]);
  const lineups = (await clanWars(db, A.id)).find((x) => x.id === w1.id)!.lineups.map((l) => l.username).sort();
  assert.deepEqual(lineups, ["w_a1", "w_a3", "w_b2", "w_b3"]);
  assert.deepEqual(await clanRecord(db, A.id), { wars: 1, wins: 1, losses: 0 });

  // Two days later the same pair plays again: recorded, not rated.
  const w2 = await proposeWar(db, b1, B.id, { ...base, opponent: A.id, lineup: [b1.id, b2.id] });
  await answerWar(db, a1, w2.id, "accept", [a1.id, a2.id]);
  await db.query("update clan_wars set scheduled_at = now() - interval '2 hours' where id = $1", [w2.id]);
  await reportWar(db, b1, w2.id, "2", "0");
  await db.query("update clan_wars set scheduled_at = now() - interval '18 days' where id = $1", [w2.id]);
  await confirmWar(db, a1, w2.id);
  const second = await war(w2.id);
  assert.deepEqual([second.status, second.winner_id, second.rated], ["completed", B.id, false]);
  assert.deepEqual(await ladder("cs2", season), ["ALP:1016:1-0", "BRV:984:0-1"], "an unrated war leaves the ladder alone");
  assert.deepEqual(await clanRecord(db, B.id), { wars: 2, wins: 1, losses: 1 });

  // Ten days after the first rated war: rated again; the report is disputed and decided by staff.
  const w3 = await proposeWar(db, a1, A.id, { ...base, lineup: [a1.id, a2.id] });
  await answerWar(db, b1, w3.id, "accept", [b1.id, b3.id]);
  await db.query("update clan_wars set scheduled_at = now() - interval '2 hours' where id = $1", [w3.id]);
  await reportWar(db, b1, w3.id, "2", "0");
  await rejects(disputeWar(db, a1, w3.id, "коротко"), "invalid_input");
  await rejects(disputeWar(db, b1, w3.id, "Свой же счёт оспорить нельзя никак."), "war_own_report");
  await disputeWar(db, a1, w3.id, "Соперник играл третьим игроком не из заявленного состава.");
  await db.query("update clan_wars set scheduled_at = now() - interval '10 days' where id = $1", [w3.id]);
  const [open] = await openWarDisputes(db);
  assert.equal(open.id, w3.id);
  await rejects(decideWar(db, a1, w3.id, "challenger", "Решение без прав сотрудника платформы."), "forbidden");
  await db.query("insert into user_roles (user_id, role) values ($1, 'support')", [s1.id]);
  const staff = (await sessionUser(db, tokens.get("w_s1")))!;
  await rejects(decideWar(db, staff, w3.id, "challenger", "коротко"), "invalid_input");
  assert.deepEqual(await decideWar(db, staff, w3.id, "challenger", "Нарушение состава подтверждено: победа присуждается Alpha."), { changed: true });
  assert.deepEqual(await decideWar(db, staff, w3.id, "challenger", "Повторное решение ничего не меняет вовсе."), { changed: false });
  const third = await war(w3.id);
  assert.deepEqual([third.status, third.winner_id, third.rated, third.score_challenger], ["completed", A.id, true, null], "a decision against the report clears its score");
  const [alp] = await clanLadder(db, season, "cs2");
  assert.equal(alp.tag, "ALP");
  assert.equal(alp.wins, 2);
  assert.ok(alp.rating > 1016);
  assert.deepEqual((await clanSeason(db, A.id, season)).map((r) => [r.game, r.rank]), [["cs2", 1]]);

  // A void decision records no result.
  const w4 = await proposeWar(db, a1, A.id, { ...base, lineup: [a1.id, a2.id] });
  await answerWar(db, b1, w4.id, "accept", [b1.id, b2.id]);
  await db.query("update clan_wars set scheduled_at = now() - interval '1 hour' where id = $1", [w4.id]);
  await reportWar(db, a1, w4.id, "2", "1");
  await disputeWar(db, b1, w4.id, "Матч прервался из-за сбоя сервера, результата нет.");
  await decideWar(db, staff, w4.id, "void", "Сбой сервера подтверждён: результат аннулирован.");
  assert.equal((await war(w4.id)).status, "void");
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("overdue wars settle: unanswered proposals and unreported wars lapse, an unanswered report stands", async () => {
  const [a1, a2, b1, b2] = [await mk("st_a1"), await mk("st_a2"), await mk("st_b1"), await mk("st_b2")];
  const A = await createClan(db, a1, { name: "Settle A", tag: "STA", description: "" });
  const B = await createClan(db, b1, { name: "Settle B", tag: "STB", description: "" });
  await join(A.id, a1, a2);
  await join(B.id, b1, b2);
  const p = { opponent: "STB", sideSize: "2", bestOf: "1", at: at(120), tz: "UTC", lineup: [a1.id, a2.id], message: "" };
  const lapsed = await proposeWar(db, a1, A.id, { ...p, game: "cs2" });
  await db.query("update clan_wars set answer_by = now() - interval '1 minute' where id = $1", [lapsed.id]);
  const silent = await proposeWar(db, a1, A.id, { ...p, game: "dota2" });
  await answerWar(db, b1, silent.id, "accept", [b1.id, b2.id]);
  await db.query("update clan_wars set scheduled_at = now() - interval '73 hours' where id = $1", [silent.id]);
  const quiet = await proposeWar(db, a1, A.id, { ...p, game: "valorant" });
  await answerWar(db, b1, quiet.id, "accept", [b1.id, b2.id]);
  await db.query("update clan_wars set scheduled_at = now() - interval '3 hours' where id = $1", [quiet.id]);
  await reportWar(db, b1, quiet.id, "1", "0");
  await db.query("update clan_wars set reported_at = now() - interval '49 hours' where id = $1", [quiet.id]);
  // Every war action settles first, so the two lapsed wars may already be closed by now.
  assert.equal((await settleWars(db)).completed, 1);
  assert.equal((await war(lapsed.id)).status, "expired");
  assert.equal((await war(silent.id)).status, "expired");
  const q = await war(quiet.id);
  assert.deepEqual([q.status, q.winner_id, q.confirmed_by], ["completed", B.id, null]);
  assert.deepEqual(await settleWars(db), { expired: 0, completed: 0 });
  // Cancelling: the challenger withdraws a proposal; the opponent declines instead.
  const w = await proposeWar(db, a1, A.id, { ...p, game: "cs2" });
  await rejects(cancelWar(db, b1, w.id), "forbidden");
  await cancelWar(db, a1, w.id);
  await rejects(answerWar(db, b1, w.id, "accept", [b1.id, b2.id]), "war_closed");
  const w2 = await proposeWar(db, a1, A.id, { ...p, game: "cs2" });
  assert.deepEqual(await answerWar(db, b1, w2.id, "decline", []), { status: "declined" });
  // Disbanding calls off what is still open.
  const w3 = await proposeWar(db, a1, A.id, { ...p, game: "cs2" });
  await answerWar(db, b1, w3.id, "accept", [b1.id, b2.id]);
  await removeClanMember(db, b1, B.id, b2.id);
  assert.deepEqual((await clanWars(db, B.id)).find((x) => x.id === w3.id)!.lineups.map((l) => l.username).sort(), ["st_a1", "st_a2", "st_b1"], "a removed player leaves future lineups");
  await leaveClan(db, b1, B.id);
  assert.equal((await war(w3.id)).status, "cancelled");
});

test("seasonal ladders: players from quick-match rating changes inside the season, public profiles, five matches", async () => {
  const players = await Promise.all(["lp_a", "lp_b", "lp_c"].map((n) => mk(n)));
  const [a, b, c] = players;
  await db.query("update users set profile_public = (username <> 'lp_c') where username in ('lp_a','lp_b','lp_c')");
  const season = seasonOf(new Date());
  async function match(winner: SessionUser, loser: SessionUser, wAfter: number, lAfter: number, ago = "1 hour") {
    const [ch] = await db.query<{ id: string }>(
      "insert into challenges (kind, game, challenger_id, opponent_id, status, winner_id, expires_at) values ('quick', 'lol', $1, $2, 'completed', $1, now()) returning id",
      [winner.id, loser.id],
    );
    await db.query(
      `insert into rating_events (user_id, game, challenge_id, result, before, after, delta, created_at) values
       ($1, 'lol', $3, 'win', $4 - 20, $4, 20, now() - $6::interval), ($2, 'lol', $3, 'loss', $5 + 20, $5, -20, now() - $6::interval)`,
      [winner.id, loser.id, ch.id, wAfter, lAfter, ago],
    );
  }
  for (let i = 0; i < 4; i++) await match(a, b, 1020 + i * 20, 980 - i * 20, `${10 - i} hours`);
  assert.deepEqual(await playerLadder(db, season, "lol"), [], "four matches are not enough");
  await match(b, a, 940, 1080, "1 hour");
  for (let i = 0; i < 5; i++) await match(c, a, 1100, 1000, `${20 + i} minutes`);
  const rows = await playerLadder(db, season, "lol");
  assert.deepEqual(rows.map((r) => [r.username, r.rating, r.matches, r.wins, r.losses]), [["lp_b", 940, 5, 1, 4], ["lp_a", 1000, 10, 4, 6]].sort((x, y) => (y[1] as number) - (x[1] as number)));
  assert.ok(!rows.some((r) => r.username === "lp_c"), "a private profile is not listed");
  assert.ok((await ladderSeasons(db)).includes(season));
});

test("clan data in the export; deletion waits for a handover, a sole owner's clan is disbanded", async () => {
  const [o, m] = [await mk("cd_o"), await mk("cd_m")];
  const clan = await createClan(db, o, { name: "Data Clan", tag: "DAT", description: "" });
  await join(clan.id, o, m);
  const data = (await exportAccount(db, m)) as unknown as { clanMemberships: unknown[]; clanInvites: unknown[]; clanWars: unknown[] };
  assert.equal(data.clanMemberships.length, 1);
  assert.equal(data.clanInvites.length, 1);
  await rejects(deleteAccount(db, o, PASSWORD), "transfer_ownership_first");
  await deleteAccount(db, m, PASSWORD);
  assert.equal((await clanBySlug(db, clan.slug))!.members.length, 1);
  await deleteAccount(db, o, PASSWORD);
  assert.equal((await clanBySlug(db, clan.slug))!.clan.status, "disbanded");
  assert.equal((await verifyAuditChain(db)).valid, true);
});
