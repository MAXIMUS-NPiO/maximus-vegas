import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { exportAccount, signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg, createTeam, inviteToTeam, leaveTeam, removeMember, respondToInvite, setTeamRole } from "../src/server/teams.ts";
import { createTournament } from "../src/server/tournaments.ts";
import {
  answerTransfer,
  decideTransferDispute,
  disputeTransfer,
  openTransferDisputes,
  playerHistory,
  proposeTransfer,
  teamHistory,
  teamTransfers,
} from "../src/server/transfers.ts";
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
async function join(team: { id: string }, leader: SessionUser, player: SessionUser) {
  const invite = await inviteToTeam(db, leader, team.id, player.username);
  await respondToInvite(db, player, invite.id, true);
}
const members = async (teamId: string) => (await db.query<{ user_id: string }>("select user_id from team_members where team_id = $1", [teamId])).map((r) => r.user_id).sort();
const events = async (teamId: string) => (await teamHistory(db, teamId)).map((h) => `${h.username}:${h.event}`).reverse();

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
});
test.after(async () => {
  await db.close();
});

test("roster history records every membership change, whatever the path", async () => {
  const owner = await mk("th_owner");
  const a = await mk("th_a");
  const b = await mk("th_b");
  const team = await createTeam(db, owner, { name: "History Five", tag: "HF", game: "cs2" });
  await join(team, owner, a);
  await join(team, owner, b);
  await leaveTeam(db, a, team.id);
  await removeMember(db, owner, team.id, b.id);
  assert.deepEqual(await events(team.id), ["th_owner:joined", "th_a:joined", "th_b:joined", "th_a:left", "th_b:removed"]);
  assert.deepEqual((await playerHistory(db, b.id)).map((h) => h.event), ["removed", "joined"], "newest first for the player");
});

test("transfer: proposed by the receiving team, agreed by the player and the releasing team, done in one move", async () => {
  const [oa, ob, p, c, stranger] = [await mk("tr_oa"), await mk("tr_ob"), await mk("tr_p"), await mk("tr_c"), await mk("tr_x")];
  const teamA = await createTeam(db, oa, { name: "Alpha CS", tag: "AL", game: "cs2" });
  const teamB = await createTeam(db, ob, { name: "Bravo CS", tag: "BR", game: "cs2" });
  const teamD = await createTeam(db, ob, { name: "Bravo Dota", tag: "BD", game: "dota2" });
  await join(teamA, oa, p);
  await join(teamA, oa, c);
  await setTeamRole(db, oa, teamA.id, p.id, "captain");
  await rejects(proposeTransfer(db, stranger, teamB.id, p.username, ""), "not_team_leader");
  await rejects(proposeTransfer(db, ob, teamB.id, oa.username, ""), "transfer_player_owner");
  await rejects(proposeTransfer(db, ob, teamB.id, stranger.username, ""), "transfer_no_team");
  // A team of another game cannot take the player by transfer.
  await rejects(proposeTransfer(db, ob, teamD.id, p.username, ""), "transfer_no_team");
  const offer = await proposeTransfer(db, ob, teamB.id, p.username, "Основной состав, сезон осени");
  assert.equal(offer.created, true);
  assert.deepEqual(await proposeTransfer(db, ob, teamB.id, p.username, ""), { id: offer.id, created: false });
  await rejects(answerTransfer(db, stranger, offer.id, "accept"), "forbidden");
  // The receiving team cannot agree for the others.
  await rejects(answerTransfer(db, ob, offer.id, "accept"), "forbidden");
  assert.deepEqual(await answerTransfer(db, p, offer.id, "accept"), { status: "proposed" }, "a captain agreeing to their own transfer does not release themselves");
  assert.deepEqual(await answerTransfer(db, oa, offer.id, "accept"), { status: "completed" });
  assert.deepEqual(await members(teamA.id), [oa.id, c.id].sort());
  assert.ok((await members(teamB.id)).includes(p.id));
  const [captain] = await db.query<{ captain_id: string }>("select captain_id from teams where id = $1", [teamA.id]);
  assert.equal(captain.captain_id, oa.id, "the captain moving away returns the captaincy to the owner");
  assert.deepEqual((await events(teamA.id)).slice(-1), ["tr_p:transferred_out"]);
  assert.deepEqual((await events(teamB.id)).slice(-1), ["tr_p:transferred_in"]);
  const [h] = await playerHistory(db, p.id);
  assert.equal(h.transfer_id, offer.id, "the history rows point at the transfer");
  await rejects(answerTransfer(db, oa, offer.id, "accept"), "transfer_closed");
  // Declines and withdrawals.
  const second = await proposeTransfer(db, ob, teamB.id, c.username, "");
  assert.deepEqual(await answerTransfer(db, oa, second.id, "decline"), { status: "declined" });
  const third = await proposeTransfer(db, ob, teamB.id, c.username, "");
  assert.deepEqual(await answerTransfer(db, ob, third.id, "cancel"), { status: "cancelled" });
  const fourth = await proposeTransfer(db, ob, teamB.id, c.username, "");
  await db.query("update team_transfers set expires_at = now() - interval '1 minute' where id = $1", [fourth.id]);
  await rejects(answerTransfer(db, c, fourth.id, "accept"), "transfer_closed");
  // Negotiations are listed for the team; the export carries the player's transfers.
  assert.ok((await teamTransfers(db, teamB.id)).length >= 4);
  const data = (await exportAccount(db, p)) as unknown as { transfers: unknown[]; teamHistory: unknown[] };
  assert.equal(data.transfers.length, 1);
  assert.ok(data.teamHistory.length >= 3);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("a player on the roster of a running event of the releasing team moves only after it", async () => {
  const [oa, ob, p, mate] = [await mk("te_oa"), await mk("te_ob"), await mk("te_p"), await mk("te_mate")];
  const teamA = await createTeam(db, oa, { name: "Echo One", tag: "E1", game: "valorant" });
  const teamB = await createTeam(db, ob, { name: "Echo Two", tag: "E2", game: "valorant" });
  await join(teamA, oa, p);
  await join(teamA, oa, mate);
  const org = await createOrg(db, oa, { name: "Echo Org", description: "" });
  const t = await createTournament(db, oa, org.id, {
    name: "Echo Cup", game: "valorant", participantType: "team", teamSize: 2, maxParticipants: 8, checkInRequired: "", region: "", startsAt: "2030-04-01T12:00", timeZone: "UTC", description: "", rules: "",
  } as never);
  const [reg] = await db.query<{ id: string }>("insert into registrations (tournament_id, team_id, registered_by) values ($1, $2, $3) returning id", [t.id, teamA.id, oa.id]);
  await db.query("insert into roster_entries (registration_id, tournament_id, user_id) values ($1, $2, $3)", [reg.id, t.id, p.id]);
  await db.query("update tournaments set status = 'IN_PROGRESS' where id = $1", [t.id]);
  const offer = await proposeTransfer(db, ob, teamB.id, p.username, "");
  await answerTransfer(db, p, offer.id, "accept");
  await rejects(answerTransfer(db, oa, offer.id, "accept"), "transfer_blocked_event");
  assert.ok((await members(teamA.id)).includes(p.id), "nothing moved");
  const [state] = await db.query<{ from_ok_at: Date | null; status: string }>("select from_ok_at, status from team_transfers where id = $1", [offer.id]);
  assert.deepEqual([state.from_ok_at, state.status], [null, "proposed"], "the refused consent is not recorded");
  await db.query("update tournaments set status = 'COMPLETED' where id = $1", [t.id]);
  assert.deepEqual(await answerTransfer(db, oa, offer.id, "accept"), { status: "completed" });
  // A reversal follows the same rule: not while the player plays for the new team in a running event.
  const staff = await mk("te_staff");
  await db.query("insert into user_roles (user_id, role) values ($1, 'support')", [staff.id]);
  const support = (await sessionUser(db, tokens.get("te_staff")))!;
  await disputeTransfer(db, oa, offer.id, "Игрок ушёл посреди сезона, просим вернуть его в состав.");
  const t2 = await createTournament(db, oa, org.id, {
    name: "Echo Cup II", game: "valorant", participantType: "team", teamSize: 2, maxParticipants: 8, checkInRequired: "", region: "", startsAt: "2030-05-01T12:00", timeZone: "UTC", description: "", rules: "",
  } as never);
  const [reg2] = await db.query<{ id: string }>("insert into registrations (tournament_id, team_id, registered_by) values ($1, $2, $3) returning id", [t2.id, teamB.id, ob.id]);
  await db.query("insert into roster_entries (registration_id, tournament_id, user_id) values ($1, $2, $3)", [reg2.id, t2.id, p.id]);
  await db.query("update tournaments set status = 'PAUSED' where id = $1", [t2.id]);
  const [open] = await openTransferDisputes(db);
  await rejects(decideTransferDispute(db, support, open.id, true, "Переход отменяется: игрок возвращается в прежний состав."), "transfer_blocked_event");
  assert.ok((await members(teamB.id)).includes(p.id), "nothing moved during the event");
  await db.query("update tournaments set status = 'COMPLETED' where id = $1", [t2.id]);
  assert.deepEqual(await decideTransferDispute(db, support, open.id, true, "Переход отменяется: игрок возвращается в прежний состав."), { changed: true });
  assert.ok((await members(teamA.id)).includes(p.id));
});

test("disputes: parties only, once, within 14 days; staff uphold or reverse with the player returned", async () => {
  const [oa, ob, p, staff, other] = [await mk("td_oa"), await mk("td_ob"), await mk("td_p"), await mk("td_staff"), await mk("td_other")];
  await db.query("insert into user_roles (user_id, role) values ($1, 'support')", [staff.id]);
  const support = (await sessionUser(db, tokens.get("td_staff")))!;
  const teamA = await createTeam(db, oa, { name: "Delta One", tag: "D1", game: "lol" });
  const teamB = await createTeam(db, ob, { name: "Delta Two", tag: "D2", game: "lol" });
  await join(teamA, oa, p);
  const offer = await proposeTransfer(db, ob, teamB.id, p.username, "");
  await answerTransfer(db, oa, offer.id, "accept");
  await answerTransfer(db, p, offer.id, "accept");
  await rejects(disputeTransfer(db, other, offer.id, "Я не участник этого перехода, но хочу спорить."), "forbidden");
  await rejects(disputeTransfer(db, oa, offer.id, "коротко"), "invalid_input");
  await disputeTransfer(db, oa, offer.id, "Согласие дал капитан без ведома владельца, просим вернуть игрока.");
  await rejects(disputeTransfer(db, p, offer.id, "Второй спор по тому же переходу от игрока."), "transfer_dispute_exists");
  const [open] = await openTransferDisputes(db);
  assert.equal(open.player, "td_p");
  await rejects(decideTransferDispute(db, oa, open.id, true, "Решение без прав сотрудника платформы."), "forbidden");
  assert.deepEqual(await decideTransferDispute(db, support, open.id, true, "Согласие дано не уполномоченным лицом: игрок возвращается."), { changed: true });
  assert.ok((await members(teamA.id)).includes(p.id), "the player is back");
  assert.ok(!(await members(teamB.id)).includes(p.id));
  assert.deepEqual((await events(teamA.id)).slice(-1), ["td_p:returned_in"]);
  assert.deepEqual((await events(teamB.id)).slice(-1), ["td_p:returned_out"]);
  const [t] = await db.query<{ status: string }>("select status from team_transfers where id = $1", [offer.id]);
  assert.equal(t.status, "reversed");
  // An old transfer can no longer be disputed.
  const again = await proposeTransfer(db, ob, teamB.id, p.username, "");
  await answerTransfer(db, oa, again.id, "accept");
  await answerTransfer(db, p, again.id, "accept");
  await db.query("update team_transfers set completed_at = now() - interval '15 days' where id = $1", [again.id]);
  await rejects(disputeTransfer(db, oa, again.id, "Спор после окна в четырнадцать дней."), "transfer_closed");
  assert.equal((await verifyAuditChain(db)).valid, true);
});
