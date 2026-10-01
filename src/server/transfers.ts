/**
 * Player transfers between teams of one game, and the roster history.
 *
 * - The receiving team's owner or captain proposes; the player and the releasing team's owner or captain
 *   agree; the move happens in one transaction once both agreed (7 days to answer). The releasing team's
 *   owner cannot be transferred (ownership first). A player on the roster of a running event of the
 *   releasing team moves only after that event.
 * - Every membership change is written to `team_history` by a database trigger; a transfer marks its
 *   two rows with the transfer, a staff reversal with "returned".
 * - Within 14 days a party (the player or a leader of either team) can dispute a completed transfer;
 *   staff uphold it or reverse it (the player goes back if both teams still exist and nothing blocks it).
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify, requireSection, staffWith } from "./access.ts";
import { fail } from "./errors.ts";
import * as v from "./validate.ts";

export const TRANSFER_DAYS = 7;
export const DISPUTE_DAYS = 14;

type Team = { id: string; slug: string; name: string; game: string; owner_id: string; captain_id: string };
type Transfer = {
  id: string;
  player_id: string;
  from_team: string;
  to_team: string;
  proposed_by: string;
  status: string;
  player_ok_at: Date | null;
  from_ok_at: Date | null;
  expires_at: Date;
  completed_at: Date | null;
};

const isId = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x);
const leads = (t: Team, userId: string) => t.owner_id === userId || t.captain_id === userId;

/** Locks teams in id order so two transfers between the same teams never wait on each other in a cycle. */
async function lockTeams(q: Queryable, ids: string[]): Promise<Map<string, Team>> {
  const rows = await q.query<Team>("select id, slug, name, game, owner_id, captain_id from teams where id = any($1::uuid[]) order by id for update", [ids]);
  return new Map(rows.map((t) => [t.id, t]));
}

const member = async (q: Queryable, teamId: string, userId: string) =>
  (await q.query("select 1 from team_members where team_id = $1 and user_id = $2", [teamId, userId])).length > 0;

/** The player is on the team's roster for an event that has closed registration and not finished. */
const onRunningRoster = async (q: Queryable, userId: string, teamId: string) =>
  (
    await q.query(
      `select 1 from roster_entries re join registrations r on r.id = re.registration_id join tournaments tt on tt.id = re.tournament_id
        where re.user_id = $1 and r.team_id = $2 and tt.status in ('REGISTRATION_CLOSED','IN_PROGRESS','PAUSED') limit 1`,
      [userId, teamId],
    )
  ).length > 0;

/** Moves expired proposals out of the way (lazily, on every transfer action). */
async function expire(q: Queryable) {
  await q.query("update team_transfers set status = 'expired' where status = 'proposed' and expires_at <= now()");
}

/** The receiving team's leader proposes a transfer of a player from another team of the same game. */
export async function proposeTransfer(db: Database, user: SessionUser, toTeamId: unknown, usernameInput: unknown, noteInput: unknown): Promise<{ id: string; created: boolean }> {
  if (!isId(toTeamId)) fail("not_found");
  const username = v.username(usernameInput);
  const note = v.oneLine(noteInput, 300);
  return db.tx(async (q) => {
    await expire(q);
    const [player] = await q.query<{ id: string }>("select id from users where username = $1 and status = 'active'", [username]);
    if (!player) fail("not_found");
    const [to] = await q.query<Team>("select id, slug, name, game, owner_id, captain_id from teams where id = $1", [toTeamId]);
    if (!to) fail("not_found");
    if (!leads(to, user.id)) fail("not_team_leader");
    if (await member(q, to.id, player.id)) fail("already_member");
    // The player's current team in this game.
    const [from] = await q.query<Team>(
      `select t.id, t.slug, t.name, t.game, t.owner_id, t.captain_id from team_members m join teams t on t.id = m.team_id
        where m.user_id = $1 and t.game = $2 and t.id <> $3 order by m.joined_at limit 1`,
      [player.id, to.game, to.id],
    );
    if (!from) fail("transfer_no_team");
    const locked = await lockTeams(q, [from.id, to.id]);
    const fromT = locked.get(from.id)!;
    const toT = locked.get(to.id)!;
    if (fromT.owner_id === player.id) fail("transfer_player_owner");
    const [open] = await q.query<{ id: string }>("select id from team_transfers where player_id = $1 and to_team = $2 and status = 'proposed'", [player.id, toT.id]);
    if (open) return { id: open.id, created: false };
    const [row] = await q.query<{ id: string }>(
      `insert into team_transfers (player_id, from_team, to_team, proposed_by, note, expires_at)
       values ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval) returning id`,
      [player.id, fromT.id, toT.id, user.id, note, String(TRANSFER_DAYS)],
    );
    await notify(q, [player.id], "transfer_proposed_player", { team: toT.name, teamSlug: toT.slug, from: fromT.name });
    await notify(q, [fromT.owner_id, fromT.captain_id], "transfer_proposed_team", { team: fromT.name, teamSlug: fromT.slug, to: toT.name, user: username });
    await audit(q, { actorId: user.id, action: "transfer.proposed", entity: "team", entityId: toT.id, data: { transfer: row.id, player: player.id, from: fromT.id } });
    return { id: row.id, created: true };
  });
}

/**
 * The player or the releasing team's leader agrees or declines; the receiving team's leader can cancel.
 * When both agreements are in, the player moves in the same transaction.
 */
export async function answerTransfer(
  db: Database,
  user: SessionUser,
  transferId: unknown,
  answer: "accept" | "decline" | "cancel",
): Promise<{ status: string }> {
  if (!isId(transferId)) fail("not_found");
  return db.tx(async (q) => {
    await expire(q);
    const [t0] = await q.query<Transfer>("select * from team_transfers where id = $1", [transferId]);
    if (!t0) fail("not_found");
    const teams = await lockTeams(q, [t0.from_team, t0.to_team]);
    const [t] = await q.query<Transfer>("select * from team_transfers where id = $1 for update", [transferId]);
    const from = teams.get(t.from_team);
    const to = teams.get(t.to_team);
    if (!from || !to) fail("not_found");
    const isPlayer = t.player_id === user.id;
    // The releasing team's consent comes from a leader other than the player (a captain cannot release themselves).
    const isFrom = leads(from!, user.id) && !isPlayer;
    const isTo = leads(to!, user.id);
    if (!isPlayer && !isFrom && !isTo) fail("forbidden");
    if (t.status !== "proposed") fail("transfer_closed");
    if (answer === "cancel") {
      if (!isTo) fail("forbidden");
      await q.query("update team_transfers set status = 'cancelled', declined_by = $2 where id = $1", [t.id, user.id]);
      await notify(q, [t.player_id, from!.owner_id, from!.captain_id], "transfer_cancelled", { team: to!.name, teamSlug: to!.slug });
      await audit(q, { actorId: user.id, action: "transfer.cancelled", entity: "team", entityId: to!.id, data: { transfer: t.id } });
      return { status: "cancelled" };
    }
    if (!isPlayer && !isFrom) fail("forbidden");
    if (answer === "decline") {
      await q.query("update team_transfers set status = 'declined', declined_by = $2 where id = $1", [t.id, user.id]);
      await notify(q, [to!.owner_id, to!.captain_id, t.player_id].filter((id) => id !== user.id), "transfer_declined", { team: to!.name, teamSlug: to!.slug });
      await audit(q, { actorId: user.id, action: "transfer.declined", entity: "team", entityId: to!.id, data: { transfer: t.id, by: isPlayer ? "player" : "from_team" } });
      return { status: "declined" };
    }
    if (isPlayer && !t.player_ok_at) await q.query("update team_transfers set player_ok_at = now() where id = $1", [t.id]);
    if (isFrom && !t.from_ok_at) await q.query("update team_transfers set from_ok_at = now(), from_ok_by = $2 where id = $1", [t.id, user.id]);
    const [now] = await q.query<Transfer>("select * from team_transfers where id = $1", [t.id]);
    if (!now.player_ok_at || !now.from_ok_at) {
      await audit(q, { actorId: user.id, action: "transfer.agreed", entity: "team", entityId: to!.id, data: { transfer: t.id, by: isPlayer ? "player" : "from_team" } });
      return { status: "proposed" };
    }
    await completeTransfer(q, now, from!, to!, user.id);
    return { status: "completed" };
  });
}

async function completeTransfer(q: Queryable, t: Transfer, from: Team, to: Team, actorId: string) {
  if (from.owner_id === t.player_id) fail("transfer_player_owner");
  if (!(await member(q, from.id, t.player_id))) fail("transfer_no_team");
  if (await member(q, to.id, t.player_id)) fail("already_member");
  if (await onRunningRoster(q, t.player_id, from.id)) fail("transfer_blocked_event");
  await q.query("select set_config('mv.membership', $1, true)", [`transfer:${t.id}`]);
  await q.query("delete from team_members where team_id = $1 and user_id = $2", [from.id, t.player_id]);
  await q.query("insert into team_members (team_id, user_id) values ($1, $2)", [to.id, t.player_id]);
  await q.query("select set_config('mv.membership', '', true)");
  if (from.captain_id === t.player_id) await q.query("update teams set captain_id = owner_id where id = $1", [from.id]);
  await q.query("update team_invites set status = 'revoked', responded_at = now() where team_id = $1 and user_id = $2 and status = 'pending'", [to.id, t.player_id]);
  await q.query("update team_transfers set status = 'completed', completed_at = now() where id = $1", [t.id]);
  // Other open proposals for this player into other teams stay; a proposal to rejoin the old team can follow.
  await notify(q, [t.player_id, from.owner_id, from.captain_id, to.owner_id, to.captain_id], "transfer_completed", { team: to.name, teamSlug: to.slug, from: from.name });
  await audit(q, { actorId, action: "transfer.completed", entity: "team", entityId: to.id, data: { transfer: t.id, player: t.player_id, from: from.id } });
}

// ---------- Disputes ----------

/** A party disputes a completed transfer within 14 days; one open dispute per transfer. */
export async function disputeTransfer(db: Database, user: SessionUser, transferId: unknown, reasonInput: unknown): Promise<{ id: string }> {
  if (!isId(transferId)) fail("not_found");
  const reason = v.clean(reasonInput, 2000);
  if (reason.length < 20) fail("invalid_input");
  return db.tx(async (q) => {
    const [t] = await q.query<Transfer & { recent: boolean }>(
      `select *, completed_at > now() - ($2 || ' days')::interval as recent from team_transfers where id = $1 for update`,
      [transferId, String(DISPUTE_DAYS)],
    );
    if (!t) fail("not_found");
    const teams = new Map((await q.query<Team>("select id, slug, name, game, owner_id, captain_id from teams where id = any($1::uuid[])", [[t.from_team, t.to_team]])).map((x) => [x.id, x]));
    const party = t.player_id === user.id || [...teams.values()].some((team) => leads(team, user.id));
    if (!party) fail("forbidden");
    if (t.status !== "completed" || !t.recent) fail("transfer_closed");
    const [open] = await q.query("select 1 from transfer_disputes where transfer_id = $1 and status = 'open'", [t.id]);
    if (open) fail("transfer_dispute_exists");
    const [row] = await q.query<{ id: string }>("insert into transfer_disputes (transfer_id, opened_by, reason) values ($1, $2, $3) returning id", [t.id, user.id, reason]);
    await notify(q, await staffWith(q, "conduct"), "transfer_disputed", { conductAdmin: "1" });
    await audit(q, { actorId: user.id, action: "transfer.disputed", entity: "team", entityId: t.to_team, data: { transfer: t.id, dispute: row.id } });
    return { id: row.id };
  });
}

/** Staff uphold the transfer or reverse it: the player returns to the releasing team when nothing blocks it. */
export async function decideTransferDispute(db: Database, staff: SessionUser, disputeId: unknown, reverse: boolean, decisionInput: unknown): Promise<{ changed: boolean }> {
  requireSection(staff, "conduct");
  if (!isId(disputeId)) fail("not_found");
  const decision = v.clean(decisionInput, 2000);
  if (decision.length < 20) fail("invalid_input");
  return db.tx(async (q) => {
    const [d0] = await q.query<{ transfer_id: string }>("select transfer_id from transfer_disputes where id = $1", [disputeId]);
    if (!d0) fail("not_found");
    const [t0] = await q.query<Transfer>("select * from team_transfers where id = $1", [d0.transfer_id]);
    const teams = await lockTeams(q, [t0.from_team, t0.to_team]);
    const [d] = await q.query<{ status: string; opened_by: string }>("select status, opened_by from transfer_disputes where id = $1 for update", [disputeId]);
    if (d.status !== "open") return { changed: false };
    const from = teams.get(t0.from_team);
    const to = teams.get(t0.to_team);
    if (reverse) {
      if (!from || !to) fail("not_found");
      if (to!.owner_id === t0.player_id) fail("transfer_player_owner");
      if (!(await member(q, to!.id, t0.player_id))) fail("transfer_no_team");
      // The same rule as the transfer itself: no move while the player is on a running event's roster.
      if (await onRunningRoster(q, t0.player_id, to!.id)) fail("transfer_blocked_event");
      await q.query("select set_config('mv.membership', $1, true)", [`return:${t0.id}`]);
      await q.query("delete from team_members where team_id = $1 and user_id = $2", [to!.id, t0.player_id]);
      await q.query("insert into team_members (team_id, user_id) values ($1, $2) on conflict do nothing", [from!.id, t0.player_id]);
      await q.query("select set_config('mv.membership', '', true)");
      if (to!.captain_id === t0.player_id) await q.query("update teams set captain_id = owner_id where id = $1", [to!.id]);
      await q.query("update team_transfers set status = 'reversed' where id = $1", [t0.id]);
    }
    await q.query("update transfer_disputes set status = $2, decided_by = $3, decision = $4, decided_at = now() where id = $1", [disputeId, reverse ? "reversed" : "upheld", staff.id, decision]);
    const parties = [t0.player_id, from?.owner_id, from?.captain_id, to?.owner_id, to?.captain_id].filter((x): x is string => Boolean(x));
    await notify(q, parties, "transfer_dispute_decided", { outcome: reverse ? "reversed" : "upheld", ...(to ? { team: to.name, teamSlug: to.slug } : {}) });
    await audit(q, { actorId: staff.id, action: reverse ? "transfer.reversed" : "transfer.upheld", entity: "team", entityId: t0.to_team, data: { transfer: t0.id, dispute: disputeId, decision } });
    return { changed: true };
  });
}

// ---------- Views ----------

export type TransferRow = {
  id: string;
  status: string;
  player: string;
  player_name: string;
  player_id: string;
  from_team: string;
  from_name: string;
  from_slug: string;
  to_team: string;
  to_name: string;
  to_slug: string;
  note: string;
  player_ok_at: Date | null;
  from_ok_at: Date | null;
  created_at: Date;
  expires_at: Date;
  completed_at: Date | null;
  disputable: boolean;
  dispute_status: string | null;
};

const TRANSFER_VIEW = `select tr.id, tr.status, u.username as player, u.display_name as player_name, tr.player_id,
       tr.from_team, ft.name as from_name, ft.slug as from_slug, tr.to_team, tt.name as to_name, tt.slug as to_slug, tr.note,
       tr.player_ok_at, tr.from_ok_at, tr.created_at, tr.expires_at, tr.completed_at,
       (tr.status = 'completed' and tr.completed_at > now() - interval '${DISPUTE_DAYS} days'
         and not exists (select 1 from transfer_disputes d where d.transfer_id = tr.id)) as disputable,
       (select d.status from transfer_disputes d where d.transfer_id = tr.id order by d.created_at desc limit 1) as dispute_status
  from team_transfers tr join users u on u.id = tr.player_id join teams ft on ft.id = tr.from_team join teams tt on tt.id = tr.to_team`;

/** Transfers that involve a team (in or out), newest first. */
export async function teamTransfers(q: Queryable, teamId: string): Promise<TransferRow[]> {
  await expire(q);
  return q.query<TransferRow>(`${TRANSFER_VIEW} where tr.from_team = $1 or tr.to_team = $1 order by tr.created_at desc limit 50`, [teamId]);
}

/** Transfer proposals waiting for this player's answer. */
export async function myTransferOffers(q: Queryable, userId: string): Promise<TransferRow[]> {
  return q.query<TransferRow>(`${TRANSFER_VIEW} where tr.player_id = $1 and tr.status = 'proposed' and tr.expires_at > now() and tr.player_ok_at is null order by tr.created_at desc`, [userId]);
}

export type HistoryRow = { event: string; at: Date; username: string; display_name: string; team_name: string; team_slug: string; transfer_id: string | null };

/** A team's roster history, newest first. */
export async function teamHistory(q: Queryable, teamId: string, limit = 60): Promise<HistoryRow[]> {
  return q.query<HistoryRow>(
    `select h.event, h.at, u.username, u.display_name, t.name as team_name, t.slug as team_slug, h.transfer_id
       from team_history h join users u on u.id = h.user_id join teams t on t.id = h.team_id
      where h.team_id = $1 order by h.at desc, h.id desc limit $2`,
    [teamId, limit],
  );
}

/** A player's teams over time, newest first. */
export async function playerHistory(q: Queryable, userId: string, limit = 40): Promise<HistoryRow[]> {
  return q.query<HistoryRow>(
    `select h.event, h.at, u.username, u.display_name, t.name as team_name, t.slug as team_slug, h.transfer_id
       from team_history h join users u on u.id = h.user_id join teams t on t.id = h.team_id
      where h.user_id = $1 order by h.at desc, h.id desc limit $2`,
    [userId, limit],
  );
}

/** Open transfer disputes for the staff queue. */
export async function openTransferDisputes(q: Queryable) {
  return q.query<{
    id: string; reason: string; created_at: Date; opened_by: string; transfer_id: string; player: string; from_name: string; from_slug: string; to_name: string; to_slug: string; completed_at: Date | null;
  }>(
    `select d.id, d.reason, d.created_at, ou.username as opened_by, tr.id as transfer_id, u.username as player,
            ft.name as from_name, ft.slug as from_slug, tt.name as to_name, tt.slug as to_slug, tr.completed_at
       from transfer_disputes d join team_transfers tr on tr.id = d.transfer_id join users ou on ou.id = d.opened_by
       join users u on u.id = tr.player_id join teams ft on ft.id = tr.from_team join teams tt on tt.id = tr.to_team
      where d.status = 'open' order by d.created_at`,
  );
}
