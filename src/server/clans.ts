/**
 * Clans, clan wars and seasonal clan ladders (MV-LADDER-1, rules in `ladder-rules.ts`).
 *
 * A clan gathers players across games; a player belongs to one clan at a time. The owner appoints officers;
 * owner and officers ("leaders") invite, remove plain members and run the clan's wars. A clan war is a
 * series between two clans in one duel game with lineups of the same size: proposed with the challenger's
 * lineup, accepted with the opponent's, reported after the start by one side and confirmed or disputed by
 * the other; an unanswered report stands after 48 hours; a dispute goes to portal staff. A completed war
 * moves both clans on the season ladder of its game unless the same pair played a rated war in that game
 * less than 7 days earlier.
 *
 * Lock order: clans (id order) → war → ladder rows (clan id order) → audit. Overdue wars are settled one
 * per transaction before an action, so settling never holds rows of two wars at once.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify, requireSection, staffWith } from "./access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { restrictedPlayers } from "./restrictions.ts";
import { uniqueSlug } from "./teams.ts";
import { gameBySlug } from "../lib/games.ts";
import * as v from "./validate.ts";
import {
  BEST_OF,
  CLAN_MAX_MEMBERS,
  CLAN_MAX_OPEN_PROPOSALS,
  CLAN_MAX_PENDING_INVITES,
  LADDER_START,
  PLAYER_LADDER_MIN,
  WAR_ANSWER_HOURS,
  WAR_CONFIRM_HOURS,
  WAR_MAX_DAYS_AHEAD,
  WAR_MIN_LEAD_MINUTES,
  WAR_REPORT_HOURS,
  clanTag,
  isRated,
  isSeason,
  ladderChange,
  seasonBounds,
  seasonOf,
  seasonsBetween,
  seriesWinner,
} from "./ladder-rules.ts";

export type ClanRole = "owner" | "officer" | "member";
type Clan = { id: string; slug: string; name: string; tag: string; description: string; status: "active" | "disbanded"; created_at: Date };
type War = {
  id: string;
  game: string;
  challenger_id: string;
  opponent_id: string;
  side_size: number;
  best_of: number;
  scheduled_at: Date;
  message: string;
  status: string;
  answer_by: Date;
  reported_clan: string | null;
  score_challenger: number | null;
  score_opponent: number | null;
  reported_at: Date | null;
  winner_id: string | null;
};

const isId = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x);
const OPEN = "('proposed','accepted','reported','disputed')";
const isLeaderRole = (r: ClanRole | null) => r === "owner" || r === "officer";

async function lockClans(q: Queryable, ids: string[]): Promise<Map<string, Clan>> {
  const rows = await q.query<Clan>("select * from clans where id = any($1::uuid[]) order by id for update", [[...new Set(ids)]]);
  return new Map(rows.map((c) => [c.id, c]));
}

async function lockClan(q: Queryable, clanId: unknown): Promise<Clan> {
  if (!isId(clanId)) fail("not_found");
  const clan = (await lockClans(q, [clanId as string])).get(clanId as string);
  if (!clan) fail("not_found");
  return clan!;
}

async function roleIn(q: Queryable, clanId: string, userId: string): Promise<ClanRole | null> {
  const [row] = await q.query<{ role: ClanRole }>("select role from clan_members where clan_id = $1 and user_id = $2", [clanId, userId]);
  return row?.role ?? null;
}

async function leaderIds(q: Queryable, clanId: string): Promise<string[]> {
  return (await q.query<{ user_id: string }>("select user_id from clan_members where clan_id = $1 and role in ('owner','officer')", [clanId])).map((r) => r.user_id);
}

/** Members with a live account (a row left by an account deleted under older code does not count). */
const memberCount = async (q: Queryable, clanId: string) =>
  (await q.query<{ n: number }>("select count(*)::int as n from clan_members m join users u on u.id = m.user_id where m.clan_id = $1 and u.status <> 'deleted'", [clanId]))[0]?.n ?? 0;

/** Removes a departing player from the lineups of the clan's wars that have not started. */
async function dropFutureLineups(q: Queryable, clanId: string, userId: string) {
  await q.query(
    `delete from clan_war_lineups l using clan_wars w
      where l.war_id = w.id and l.clan_id = $1 and l.user_id = $2 and w.status in ('proposed','accepted') and w.scheduled_at > now()`,
    [clanId, userId],
  );
}

// ---------- Clans ----------

export async function createClan(db: Database, user: SessionUser, input: { name: unknown; tag: unknown; description: unknown }) {
  const name = v.displayName(input.name, 40);
  const tag = clanTag(input.tag) ?? fail("invalid_clan_tag");
  const description = v.clean(input.description, 500);
  return db.tx(async (q) => {
    const [mine] = await q.query("select 1 from clan_members where user_id = $1", [user.id]);
    if (mine) fail("clan_already_member");
    const [taken] = await q.query<{ tag: string }>("select tag from clans where status = 'active' and (tag = $1 or lower(name) = lower($2)) limit 1", [tag, name]);
    if (taken) fail(taken.tag === tag ? "clan_tag_taken" : "clan_name_taken");
    const slug = await uniqueSlug(q, "clans", name);
    try {
      const [clan] = await q.query<{ id: string; slug: string }>(
        "insert into clans (slug, name, tag, description, created_by) values ($1, $2, $3, $4, $5) returning id, slug",
        [slug, name, tag, description, user.id],
      );
      await q.query("insert into clan_members (clan_id, user_id, role) values ($1, $2, 'owner')", [clan.id, user.id]);
      await audit(q, { actorId: user.id, action: "clan.created", entity: "clan", entityId: clan.id, data: { name, tag } });
      return clan;
    } catch (error) {
      if (isUniqueViolation(error, "clans_tag_active")) fail("clan_tag_taken");
      if (isUniqueViolation(error, "clans_name_active")) fail("clan_name_taken");
      if (isUniqueViolation(error, "clan_members_one_clan")) fail("clan_already_member");
      throw error;
    }
  });
}

export async function updateClan(db: Database, user: SessionUser, clanId: unknown, input: { description: unknown }) {
  const description = v.clean(input.description, 500);
  await db.tx(async (q) => {
    const clan = await lockClan(q, clanId);
    if (clan.status !== "active") fail("not_found");
    if (!isLeaderRole(await roleIn(q, clan.id, user.id))) fail("not_clan_leader");
    await q.query("update clans set description = $2 where id = $1", [clan.id, description]);
    await audit(q, { actorId: user.id, action: "clan.updated", entity: "clan", entityId: clan.id });
  });
}

export async function inviteToClan(db: Database, user: SessionUser, clanId: unknown, usernameInput: unknown) {
  const username = v.username(usernameInput);
  return db.tx(async (q) => {
    const clan = await lockClan(q, clanId);
    if (clan.status !== "active") fail("not_found");
    if (!isLeaderRole(await roleIn(q, clan.id, user.id))) fail("not_clan_leader");
    const [target] = await q.query<{ id: string }>("select id from users where username = $1 and status = 'active'", [username]);
    if (!target) fail("not_found");
    const [current] = await q.query<{ clan_id: string }>("select clan_id from clan_members where user_id = $1", [target.id]);
    if (current) fail(current.clan_id === clan.id ? "already_member" : "clan_already_member");
    if ((await memberCount(q, clan.id)) >= CLAN_MAX_MEMBERS) fail("clan_full");
    const [pending] = await q.query<{ n: number }>("select count(*)::int as n from clan_invites where clan_id = $1 and status = 'pending'", [clan.id]);
    if ((pending?.n ?? 0) >= CLAN_MAX_PENDING_INVITES) fail("clan_invite_limit");
    const [dup] = await q.query("select 1 from clan_invites where clan_id = $1 and user_id = $2 and status = 'pending'", [clan.id, target.id]);
    if (dup) fail("already_invited");
    const [invite] = await q.query<{ id: string }>("insert into clan_invites (clan_id, user_id, invited_by) values ($1, $2, $3) returning id", [clan.id, target.id, user.id]);
    await notify(q, [target.id], "clan_invite", { clan: clan.name, tag: clan.tag, clans: "1", by: user.username });
    await audit(q, { actorId: user.id, action: "clan.invited", entity: "clan", entityId: clan.id, data: { userId: target.id } });
    return invite;
  });
}

export async function respondClanInvite(db: Database, user: SessionUser, inviteId: unknown, accept: boolean) {
  if (!isId(inviteId)) fail("invite_not_found");
  return db.tx(async (q) => {
    const [invite0] = await q.query<{ clan_id: string }>("select clan_id from clan_invites where id = $1 and user_id = $2 and status = 'pending'", [inviteId, user.id]);
    if (!invite0) fail("invite_not_found");
    const clan = await lockClan(q, invite0.clan_id);
    const [invite] = await q.query<{ id: string }>("select id from clan_invites where id = $1 and status = 'pending' for update", [inviteId]);
    if (!invite || clan.status !== "active") fail("invite_not_found");
    if (accept) {
      const [current] = await q.query("select 1 from clan_members where user_id = $1", [user.id]);
      if (current) fail("clan_already_member");
      if ((await memberCount(q, clan.id)) >= CLAN_MAX_MEMBERS) fail("clan_full");
      await q.query("insert into clan_members (clan_id, user_id, role) values ($1, $2, 'member')", [clan.id, user.id]);
      // One clan at a time: the other invitations lapse.
      await q.query("update clan_invites set status = 'declined', responded_at = now() where user_id = $1 and status = 'pending' and id <> $2", [user.id, invite.id]);
      await notify(q, (await leaderIds(q, clan.id)).filter((id) => id !== user.id), "clan_joined", { clan: clan.name, clanSlug: clan.slug, user: user.username });
    }
    await q.query("update clan_invites set status = $2, responded_at = now() where id = $1", [invite.id, accept ? "accepted" : "declined"]);
    await audit(q, { actorId: user.id, action: accept ? "clan.joined" : "clan.invite_declined", entity: "clan", entityId: clan.id });
    return { slug: clan.slug };
  });
}

export async function revokeClanInvite(db: Database, user: SessionUser, inviteId: unknown) {
  if (!isId(inviteId)) fail("invite_not_found");
  await db.tx(async (q) => {
    const [invite0] = await q.query<{ clan_id: string }>("select clan_id from clan_invites where id = $1 and status = 'pending'", [inviteId]);
    if (!invite0) fail("invite_not_found");
    const clan = await lockClan(q, invite0.clan_id);
    if (!isLeaderRole(await roleIn(q, clan.id, user.id))) fail("not_clan_leader");
    await q.query("update clan_invites set status = 'revoked', responded_at = now() where id = $1 and status = 'pending'", [inviteId]);
    await audit(q, { actorId: user.id, action: "clan.invite_revoked", entity: "clan", entityId: clan.id });
  });
}

/** Ends a clan whose last member leaves: open proposals and accepted wars are called off. */
async function disband(q: Queryable, clan: Clan, actorId: string) {
  await q.query("update clans set status = 'disbanded', disbanded_at = now() where id = $1", [clan.id]);
  await q.query("delete from clan_members where clan_id = $1", [clan.id]);
  await q.query("update clan_invites set status = 'revoked', responded_at = now() where clan_id = $1 and status = 'pending'", [clan.id]);
  const wars = await q.query<{ id: string; other: string }>(
    `update clan_wars set status = 'cancelled', closed_by = $2
      where (challenger_id = $1 or opponent_id = $1) and status in ('proposed','accepted')
      returning id, case when challenger_id = $1 then opponent_id else challenger_id end as other`,
    [clan.id, actorId],
  );
  for (const w of wars) {
    const [other] = await q.query<{ slug: string }>("select slug from clans where id = $1", [w.other]);
    await notify(q, await leaderIds(q, w.other), "clan_war_cancelled", { clan: clan.name, clanSlug: other?.slug ?? "" });
  }
  await audit(q, { actorId, action: "clan.disbanded", entity: "clan", entityId: clan.id, data: { wars: wars.map((w) => w.id) } });
}

export async function leaveClan(db: Database, user: SessionUser, clanId: unknown): Promise<{ disbanded: boolean }> {
  return db.tx(async (q) => {
    const clan = await lockClan(q, clanId);
    const role = await roleIn(q, clan.id, user.id);
    if (!role) fail("not_found");
    if (role === "owner" && (await memberCount(q, clan.id)) > 1) fail("clan_owner_cannot_leave");
    await dropFutureLineups(q, clan.id, user.id);
    await q.query("delete from clan_members where clan_id = $1 and user_id = $2", [clan.id, user.id]);
    if (role === "owner") {
      await disband(q, clan, user.id);
      return { disbanded: true };
    }
    await audit(q, { actorId: user.id, action: "clan.left", entity: "clan", entityId: clan.id });
    return { disbanded: false };
  });
}

export async function removeClanMember(db: Database, user: SessionUser, clanId: unknown, memberId: unknown) {
  if (!isId(memberId)) fail("not_found");
  await db.tx(async (q) => {
    const clan = await lockClan(q, clanId);
    const actor = await roleIn(q, clan.id, user.id);
    if (!isLeaderRole(actor)) fail("not_clan_leader");
    if (memberId === user.id) fail("cannot_modify_self");
    const target = await roleIn(q, clan.id, memberId as string);
    if (!target) fail("not_found");
    if (target === "owner" || (target === "officer" && actor !== "owner")) fail("forbidden");
    await dropFutureLineups(q, clan.id, memberId as string);
    await q.query("delete from clan_members where clan_id = $1 and user_id = $2", [clan.id, memberId]);
    await notify(q, [memberId as string], "clan_removed", { clan: clan.name, clanSlug: clan.slug });
    await audit(q, { actorId: user.id, action: "clan.member_removed", entity: "clan", entityId: clan.id, data: { userId: memberId } });
  });
}

/** The owner appoints or demotes officers, or hands the clan to a member (the old owner becomes an officer). */
export async function setClanRole(db: Database, user: SessionUser, clanId: unknown, memberId: unknown, roleInput: unknown) {
  const role = roleInput === "owner" || roleInput === "officer" || roleInput === "member" ? (roleInput as ClanRole) : fail("invalid_input");
  if (!isId(memberId)) fail("not_found");
  await db.tx(async (q) => {
    const clan = await lockClan(q, clanId);
    if ((await roleIn(q, clan.id, user.id)) !== "owner") fail("forbidden");
    if (memberId === user.id) fail("cannot_modify_self");
    if (!(await roleIn(q, clan.id, memberId as string))) fail("not_found");
    if (role === "owner") {
      await q.query("update clan_members set role = 'officer' where clan_id = $1 and user_id = $2", [clan.id, user.id]);
      await q.query("update clan_members set role = 'owner' where clan_id = $1 and user_id = $2", [clan.id, memberId]);
    } else {
      await q.query("update clan_members set role = $3 where clan_id = $1 and user_id = $2", [clan.id, memberId, role]);
    }
    if (role !== "member") await notify(q, [memberId as string], role === "owner" ? "clan_owner" : "clan_officer", { clan: clan.name, clanSlug: clan.slug });
    await audit(q, { actorId: user.id, action: "clan.role_set", entity: "clan", entityId: clan.id, data: { userId: memberId, role } });
  });
}

// ---------- Clan wars ----------

/** Exactly `size` distinct current members of the clan. */
async function validLineup(q: Queryable, clanId: string, input: unknown, size: number): Promise<string[]> {
  const raw = Array.isArray(input) ? input : typeof input === "string" && input ? [input] : [];
  const ids = [...new Set(raw.map(String))];
  if (ids.length !== raw.length || ids.length !== size || !ids.every(isId)) fail("war_lineup");
  const rows = await q.query<{ user_id: string }>("select user_id from clan_members where clan_id = $1 and user_id = any($2::uuid[])", [clanId, ids]);
  if (rows.length !== size) fail("war_lineup");
  if ((await restrictedPlayers(q, ids, "queue_ban")).length) fail("war_lineup_restricted");
  return ids.sort();
}

async function saveLineup(q: Queryable, warId: string, clanId: string, ids: string[]) {
  await q.query("delete from clan_war_lineups where war_id = $1 and clan_id = $2", [warId, clanId]);
  for (const id of ids) await q.query("insert into clan_war_lineups (war_id, clan_id, user_id) values ($1, $2, $3)", [warId, clanId, id]);
}

/** Locks both clans of a war (id order), then the war. */
async function lockWar(q: Queryable, warId: unknown): Promise<{ war: War; clans: Map<string, Clan> }> {
  if (!isId(warId)) fail("not_found");
  const [w0] = await q.query<War>("select * from clan_wars where id = $1", [warId]);
  if (!w0) fail("not_found");
  const clans = await lockClans(q, [w0.challenger_id, w0.opponent_id]);
  const [war] = await q.query<War>("select * from clan_wars where id = $1 for update", [warId]);
  return { war, clans };
}

/** Which side of the war the user leads, if any. */
async function sideOf(q: Queryable, war: War, userId: string): Promise<"challenger" | "opponent" | null> {
  const [row] = await q.query<{ clan_id: string; role: ClanRole }>(
    "select clan_id, role from clan_members where user_id = $1 and clan_id in ($2, $3)",
    [userId, war.challenger_id, war.opponent_id],
  );
  if (!row || !isLeaderRole(row.role)) return null;
  return row.clan_id === war.challenger_id ? "challenger" : "opponent";
}

const gameName = (slug: string) => gameBySlug(slug)?.name ?? slug;

export async function proposeWar(
  db: Database,
  user: SessionUser,
  clanId: unknown,
  input: { opponent: unknown; game: unknown; sideSize: unknown; bestOf: unknown; at: unknown; tz: unknown; lineup: unknown; message: unknown },
): Promise<{ id: string }> {
  const game = typeof input.game === "string" ? gameBySlug(input.game) : undefined;
  if (!game || !game.bracket) fail("invalid_game");
  const sideSize = v.intIn(input.sideSize, 1, Math.min(6, game!.teamSize));
  const bestOf = v.intIn(input.bestOf, 1, 5);
  if (!(BEST_OF as readonly number[]).includes(bestOf)) fail("invalid_input");
  const scheduledAt = v.zonedToUtc(input.at, input.tz);
  const now = Date.now();
  if (scheduledAt.getTime() < now + WAR_MIN_LEAD_MINUTES * 60_000 || scheduledAt.getTime() > now + WAR_MAX_DAYS_AHEAD * 86_400_000) fail("war_time");
  const message = v.oneLine(input.message, 300);
  await settleWars(db);
  return db.tx(async (q) => {
    let opponentId: string | undefined;
    if (isId(input.opponent)) opponentId = input.opponent as string;
    else {
      const tag = clanTag(input.opponent);
      if (!tag) fail("not_found");
      opponentId = (await q.query<{ id: string }>("select id from clans where tag = $1 and status = 'active'", [tag]))[0]?.id;
    }
    if (!opponentId || !isId(clanId)) fail("not_found");
    if (opponentId === clanId) fail("war_same_clan");
    const clans = await lockClans(q, [clanId as string, opponentId!]);
    const mine = clans.get(clanId as string);
    const theirs = clans.get(opponentId!);
    if (!mine || !theirs || mine.status !== "active" || theirs.status !== "active") fail("not_found");
    if (!isLeaderRole(await roleIn(q, mine!.id, user.id))) fail("not_clan_leader");
    if ((await memberCount(q, theirs!.id)) < sideSize) fail("clan_too_small");
    const lineup = await validLineup(q, mine!.id, input.lineup, sideSize);
    const [open] = await q.query(
      `select 1 from clan_wars where game = $1 and status in ${OPEN}
         and least(challenger_id, opponent_id) = least($2::uuid, $3::uuid) and greatest(challenger_id, opponent_id) = greatest($2::uuid, $3::uuid)`,
      [game!.slug, mine!.id, theirs!.id],
    );
    if (open) fail("war_open_exists");
    const [count] = await q.query<{ n: number }>("select count(*)::int as n from clan_wars where challenger_id = $1 and status = 'proposed'", [mine!.id]);
    if ((count?.n ?? 0) >= CLAN_MAX_OPEN_PROPOSALS) fail("war_limit");
    const answerBy = new Date(Math.min(scheduledAt.getTime(), now + WAR_ANSWER_HOURS * 3_600_000));
    const [war] = await q.query<{ id: string }>(
      `insert into clan_wars (game, challenger_id, opponent_id, side_size, best_of, scheduled_at, message, proposed_by, answer_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [game!.slug, mine!.id, theirs!.id, sideSize, bestOf, scheduledAt, message, user.id, answerBy],
    );
    await saveLineup(q, war.id, mine!.id, lineup);
    await notify(q, await leaderIds(q, theirs!.id), "clan_war_proposed", { clan: mine!.name, tag: mine!.tag, game: gameName(game!.slug), clanSlug: theirs!.slug });
    await audit(q, { actorId: user.id, action: "war.proposed", entity: "clan_war", entityId: war.id, data: { challenger: mine!.id, opponent: theirs!.id, game: game!.slug, sideSize, bestOf, scheduledAt } });
    return war;
  });
}

export async function answerWar(db: Database, user: SessionUser, warId: unknown, answer: "accept" | "decline", lineupInput: unknown): Promise<{ status: string }> {
  await settleWars(db);
  return db.tx(async (q) => {
    const { war, clans } = await lockWar(q, warId);
    if (war.status !== "proposed") fail("war_closed");
    if ((await sideOf(q, war, user.id)) !== "opponent") fail("forbidden");
    const challenger = clans.get(war.challenger_id)!;
    const opponent = clans.get(war.opponent_id)!;
    if (answer === "decline") {
      await q.query("update clan_wars set status = 'declined', answered_by = $2 where id = $1", [war.id, user.id]);
      await notify(q, await leaderIds(q, challenger.id), "clan_war_declined", { clan: opponent.name, clanSlug: challenger.slug });
      await audit(q, { actorId: user.id, action: "war.declined", entity: "clan_war", entityId: war.id });
      return { status: "declined" };
    }
    const lineup = await validLineup(q, opponent.id, lineupInput, war.side_size);
    await saveLineup(q, war.id, opponent.id, lineup);
    await q.query("update clan_wars set status = 'accepted', answered_by = $2 where id = $1", [war.id, user.id]);
    await notify(q, await leaderIds(q, challenger.id), "clan_war_accepted", { clan: opponent.name, clanSlug: challenger.slug });
    await audit(q, { actorId: user.id, action: "war.accepted", entity: "clan_war", entityId: war.id });
    return { status: "accepted" };
  });
}

/** The challenger withdraws a proposal; either side calls off an accepted war before its start. */
export async function cancelWar(db: Database, user: SessionUser, warId: unknown) {
  await settleWars(db);
  await db.tx(async (q) => {
    const { war, clans } = await lockWar(q, warId);
    const side = await sideOf(q, war, user.id);
    if (!side) fail("forbidden");
    if (war.status === "proposed") {
      if (side !== "challenger") fail("forbidden");
    } else if (war.status === "accepted") {
      if (war.scheduled_at.getTime() <= Date.now()) fail("war_started");
    } else fail("war_closed");
    await q.query("update clan_wars set status = 'cancelled', closed_by = $2 where id = $1", [war.id, user.id]);
    const mine = clans.get(side === "challenger" ? war.challenger_id : war.opponent_id)!;
    const other = clans.get(side === "challenger" ? war.opponent_id : war.challenger_id)!;
    await notify(q, await leaderIds(q, other.id), "clan_war_cancelled", { clan: mine.name, clanSlug: other.slug });
    await audit(q, { actorId: user.id, action: "war.cancelled", entity: "clan_war", entityId: war.id });
  });
}

/** A side replaces its lineup before the start (the challenger also while the proposal waits). */
export async function setWarLineup(db: Database, user: SessionUser, warId: unknown, lineupInput: unknown) {
  await settleWars(db);
  await db.tx(async (q) => {
    const { war } = await lockWar(q, warId);
    const side = await sideOf(q, war, user.id);
    if (!side) fail("forbidden");
    if (!(war.status === "accepted" || (war.status === "proposed" && side === "challenger"))) fail(war.status === "proposed" ? "forbidden" : "war_closed");
    if (war.scheduled_at.getTime() <= Date.now()) fail("war_started");
    const clanId = side === "challenger" ? war.challenger_id : war.opponent_id;
    const lineup = await validLineup(q, clanId, lineupInput, war.side_size);
    await saveLineup(q, war.id, clanId, lineup);
    await audit(q, { actorId: user.id, action: "war.lineup", entity: "clan_war", entityId: war.id, data: { clan: clanId } });
  });
}

/** After the start, a side reports the series score; the other side confirms or disputes it. */
export async function reportWar(db: Database, user: SessionUser, warId: unknown, mineInput: unknown, theirsInput: unknown) {
  const mineScore = v.intIn(mineInput, 0, 3);
  const theirsScore = v.intIn(theirsInput, 0, 3);
  await settleWars(db);
  await db.tx(async (q) => {
    const { war, clans } = await lockWar(q, warId);
    const side = await sideOf(q, war, user.id);
    if (!side) fail("forbidden");
    if (war.status !== "accepted") fail("war_closed");
    if (war.scheduled_at.getTime() > Date.now()) fail("war_not_started");
    const [sc, so] = side === "challenger" ? [mineScore, theirsScore] : [theirsScore, mineScore];
    if (!seriesWinner(war.best_of, sc, so)) fail("war_score");
    const mine = clans.get(side === "challenger" ? war.challenger_id : war.opponent_id)!;
    const other = clans.get(side === "challenger" ? war.opponent_id : war.challenger_id)!;
    await q.query(
      "update clan_wars set status = 'reported', reported_by = $2, reported_clan = $3, score_challenger = $4, score_opponent = $5, reported_at = now() where id = $1",
      [war.id, user.id, mine.id, sc, so],
    );
    await notify(q, await leaderIds(q, other.id), "clan_war_reported", { clan: mine.name, clanSlug: other.slug });
    await audit(q, { actorId: user.id, action: "war.reported", entity: "clan_war", entityId: war.id, data: { challenger: sc, opponent: so } });
  });
}

export async function confirmWar(db: Database, user: SessionUser, warId: unknown) {
  await settleWars(db);
  await db.tx(async (q) => {
    const { war, clans } = await lockWar(q, warId);
    const side = await sideOf(q, war, user.id);
    if (!side) fail("forbidden");
    if (war.status !== "reported") fail("war_closed");
    const mineId = side === "challenger" ? war.challenger_id : war.opponent_id;
    if (war.reported_clan === mineId) fail("war_own_report");
    await completeWar(q, war, clans, { by: user.id });
  });
}

export async function disputeWar(db: Database, user: SessionUser, warId: unknown, reasonInput: unknown) {
  const reason = v.clean(reasonInput, 1000);
  if (reason.length < 20) fail("invalid_input");
  await settleWars(db);
  await db.tx(async (q) => {
    const { war, clans } = await lockWar(q, warId);
    const side = await sideOf(q, war, user.id);
    if (!side) fail("forbidden");
    if (war.status !== "reported") fail("war_closed");
    const mineId = side === "challenger" ? war.challenger_id : war.opponent_id;
    if (war.reported_clan === mineId) fail("war_own_report");
    await q.query("update clan_wars set status = 'disputed', dispute_reason = $2, disputed_by = $3 where id = $1", [war.id, reason, user.id]);
    await notify(q, await staffWith(q, "conduct"), "clan_war_disputed", { conductAdmin: "1" });
    const reporter = clans.get(war.reported_clan!)!;
    await notify(q, await leaderIds(q, reporter.id), "clan_war_contested", { clan: clans.get(mineId)!.name, clanSlug: reporter.slug });
    await audit(q, { actorId: user.id, action: "war.disputed", entity: "clan_war", entityId: war.id });
  });
}

/** Portal staff settle a disputed war: a winner, or void (no result, no rating). */
export async function decideWar(db: Database, staff: SessionUser, warId: unknown, outcomeInput: unknown, decisionInput: unknown): Promise<{ changed: boolean }> {
  requireSection(staff, "conduct");
  const outcome = outcomeInput === "challenger" || outcomeInput === "opponent" || outcomeInput === "void" ? outcomeInput : fail("invalid_input");
  const decision = v.clean(decisionInput, 2000);
  if (decision.length < 20) fail("invalid_input");
  return db.tx(async (q) => {
    const { war, clans } = await lockWar(q, warId);
    if (war.status !== "disputed") return { changed: false };
    if (outcome === "void") {
      await q.query("update clan_wars set status = 'void', decided_by = $2, decision = $3, completed_at = now() where id = $1", [war.id, staff.id, decision]);
      for (const c of clans.values()) await notify(q, await leaderIds(q, c.id), "clan_war_voided", { clanSlug: c.slug });
      await audit(q, { actorId: staff.id, action: "war.voided", entity: "clan_war", entityId: war.id, data: { decision } });
      return { changed: true };
    }
    const winnerId = outcome === "challenger" ? war.challenger_id : war.opponent_id;
    // The reported score stands only when it names the same winner.
    const reported = war.score_challenger !== null && war.score_opponent !== null ? seriesWinner(war.best_of, war.score_challenger, war.score_opponent) : null;
    const keep = reported === (outcome === "challenger" ? "a" : "b");
    if (!keep) await q.query("update clan_wars set score_challenger = null, score_opponent = null where id = $1", [war.id]);
    await q.query("update clan_wars set decided_by = $2, decision = $3 where id = $1", [war.id, staff.id, decision]);
    await completeWar(q, war, clans, { by: staff.id, winnerId, decided: true });
    return { changed: true };
  });
}

/** Completes a war and applies MV-LADDER-1. The caller holds the clan and war locks. */
async function completeWar(q: Queryable, war: War, clans: Map<string, Clan>, opts: { by: string | null; winnerId?: string; decided?: boolean }) {
  const winnerId =
    opts.winnerId ??
    (seriesWinner(war.best_of, war.score_challenger ?? -1, war.score_opponent ?? -1) === "a" ? war.challenger_id : war.opponent_id);
  const loserId = winnerId === war.challenger_id ? war.opponent_id : war.challenger_id;
  const season = seasonOf(war.scheduled_at);
  const [previous] = await q.query<{ scheduled_at: Date }>(
    `select scheduled_at from clan_wars where game = $1 and rated and id <> $2
        and least(challenger_id, opponent_id) = least($3::uuid, $4::uuid) and greatest(challenger_id, opponent_id) = greatest($3::uuid, $4::uuid)
      order by scheduled_at desc limit 1`,
    [war.game, war.id, war.challenger_id, war.opponent_id],
  );
  const rated = isRated(war.scheduled_at, previous?.scheduled_at ?? null);
  await q.query(
    "update clan_wars set status = 'completed', winner_id = $2, completed_at = now(), season = $3, rated = $4, confirmed_by = $5 where id = $1",
    [war.id, winnerId, season, rated, opts.decided ? null : opts.by],
  );
  if (rated) await applyLadder(q, war, season, winnerId, loserId);
  const winner = clans.get(winnerId)!;
  for (const c of clans.values()) await notify(q, await leaderIds(q, c.id), opts.decided ? "clan_war_decided" : "clan_war_completed", { winner: winner.name, clanSlug: c.slug });
  await audit(q, { actorId: opts.by, action: opts.decided ? "war.decided" : "war.completed", entity: "clan_war", entityId: war.id, data: { winner: winnerId, season, rated } });
}

async function applyLadder(q: Queryable, war: War, season: string, winnerId: string, loserId: string) {
  for (const id of [winnerId, loserId]) await q.query("insert into clan_ladder (season, game, clan_id) values ($1, $2, $3) on conflict do nothing", [season, war.game, id]);
  const rows = await q.query<{ clan_id: string; rating: number }>(
    "select clan_id, rating from clan_ladder where season = $1 and game = $2 and clan_id = any($3::uuid[]) order by clan_id for update",
    [season, war.game, [winnerId, loserId]],
  );
  const rating = new Map(rows.map((r) => [r.clan_id, r.rating]));
  const ch = ladderChange(rating.get(winnerId) ?? LADDER_START, rating.get(loserId) ?? LADDER_START);
  const moves = [
    { clan: winnerId, result: "win", before: ch.winnerBefore, after: ch.winnerAfter },
    { clan: loserId, result: "loss", before: ch.loserBefore, after: ch.loserAfter },
  ];
  for (const m of moves) {
    const [inserted] = await q.query<{ war_id: string }>(
      `insert into clan_ladder_events (war_id, clan_id, season, game, result, before, after, delta) values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (war_id, clan_id) do nothing returning war_id`,
      [war.id, m.clan, season, war.game, m.result, m.before, m.after, m.after - m.before],
    );
    if (!inserted) continue;
    await q.query(
      `update clan_ladder set rating = $4, wars = wars + 1, wins = wins + $5, losses = losses + $6, peak = greatest(peak, $4), updated_at = now()
        where season = $1 and game = $2 and clan_id = $3`,
      [season, war.game, m.clan, m.after, m.result === "win" ? 1 : 0, m.result === "loss" ? 1 : 0],
    );
  }
}

/**
 * Settles overdue wars: unanswered proposals and accepted wars without a report lapse; a report left
 * unanswered for 48 hours stands. Each completion runs in its own transaction.
 */
export async function settleWars(db: Database): Promise<{ expired: number; completed: number }> {
  const expired = await db.tx(async (q) => {
    const a = await q.query("update clan_wars set status = 'expired' where status = 'proposed' and answer_by <= now() returning id");
    const b = await q.query(`update clan_wars set status = 'expired' where status = 'accepted' and scheduled_at + interval '${WAR_REPORT_HOURS} hours' <= now() returning id`);
    return a.length + b.length;
  });
  const due = await db.query<{ id: string }>(`select id from clan_wars where status = 'reported' and reported_at + interval '${WAR_CONFIRM_HOURS} hours' <= now() order by reported_at limit 20`);
  let completed = 0;
  for (const { id } of due) {
    const done = await db.tx(async (q) => {
      const [w0] = await q.query<War>("select * from clan_wars where id = $1", [id]);
      if (!w0) return false;
      const clans = await lockClans(q, [w0.challenger_id, w0.opponent_id]);
      const [war] = await q.query<War>(
        `select * from clan_wars where id = $1 and status = 'reported' and reported_at + interval '${WAR_CONFIRM_HOURS} hours' <= now() for update skip locked`,
        [id],
      );
      if (!war) return false;
      await completeWar(q, war, clans, { by: null });
      return true;
    });
    if (done) completed++;
  }
  return { expired, completed };
}

// ---------- Views ----------

export type ClanRow = { id: string; slug: string; name: string; tag: string; description: string; status: string; created_at: Date; members: number };
export type ClanMember = { id: string; username: string; display_name: string; avatar_media_id: string | null; role: ClanRole; joined_at: Date };

export async function clanBySlug(q: Queryable, slug: string): Promise<{ clan: ClanRow; members: ClanMember[] } | null> {
  const [clan] = await q.query<ClanRow>(
    "select c.*, (select count(*)::int from clan_members m join users u on u.id = m.user_id where m.clan_id = c.id and u.status <> 'deleted') as members from clans c where c.slug = $1",
    [slug],
  );
  if (!clan) return null;
  const members = await q.query<ClanMember>(
    `select u.id, u.username, u.display_name, u.avatar_media_id, m.role, m.joined_at from clan_members m join users u on u.id = m.user_id
      where m.clan_id = $1 and u.status <> 'deleted' order by case m.role when 'owner' then 0 when 'officer' then 1 else 2 end, m.joined_at`,
    [clan.id],
  );
  return { clan, members };
}

export async function listClans(q: Queryable, search = "", limit = 60): Promise<ClanRow[]> {
  const term = v.oneLine(search, 40);
  const like = `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  return q.query<ClanRow>(
    `select c.*, (select count(*)::int from clan_members m join users u on u.id = m.user_id where m.clan_id = c.id and u.status <> 'deleted') as members from clans c
      where c.status = 'active' and ($1 = '' or c.name ilike $2 escape '\\' or c.tag ilike $2 escape '\\')
      order by members desc, c.created_at limit $3`,
    [term, like, limit],
  );
}

export type MyClan = { id: string; slug: string; name: string; tag: string; role: ClanRole };
export async function clanOf(q: Queryable, userId: string): Promise<MyClan | null> {
  const [row] = await q.query<MyClan>(
    "select c.id, c.slug, c.name, c.tag, m.role from clan_members m join clans c on c.id = m.clan_id where m.user_id = $1",
    [userId],
  );
  return row ?? null;
}

export async function myClanInvites(q: Queryable, userId: string) {
  return q.query<{ id: string; slug: string; name: string; tag: string; by: string; created_at: Date }>(
    `select i.id, c.slug, c.name, c.tag, u.username as by, i.created_at from clan_invites i
       join clans c on c.id = i.clan_id join users u on u.id = i.invited_by
      where i.user_id = $1 and i.status = 'pending' and c.status = 'active' order by i.created_at desc`,
    [userId],
  );
}

export async function clanPendingInvites(q: Queryable, clanId: string) {
  return q.query<{ id: string; username: string; created_at: Date }>(
    "select i.id, u.username, i.created_at from clan_invites i join users u on u.id = i.user_id where i.clan_id = $1 and i.status = 'pending' order by i.created_at desc",
    [clanId],
  );
}

export type LineupPlayer = { clan_id: string; username: string; display_name: string; user_id: string };
export type WarRow = War & {
  challenger_slug: string;
  challenger_name: string;
  challenger_tag: string;
  opponent_slug: string;
  opponent_name: string;
  opponent_tag: string;
  completed_at: Date | null;
  rated: boolean;
  season: string | null;
  dispute_reason: string;
  decision: string;
  lineups: LineupPlayer[];
  deltas: { clan_id: string; delta: number }[];
};

const WAR_SELECT = `select w.*, a.slug as challenger_slug, a.name as challenger_name, a.tag as challenger_tag,
    b.slug as opponent_slug, b.name as opponent_name, b.tag as opponent_tag,
    coalesce((select json_agg(json_build_object('clan_id', l.clan_id, 'user_id', u.id, 'username', u.username, 'display_name', u.display_name) order by u.display_name)
       from clan_war_lineups l join users u on u.id = l.user_id where l.war_id = w.id), '[]'::json) as lineups,
    coalesce((select json_agg(json_build_object('clan_id', e.clan_id, 'delta', e.delta)) from clan_ladder_events e where e.war_id = w.id), '[]'::json) as deltas
  from clan_wars w join clans a on a.id = w.challenger_id join clans b on b.id = w.opponent_id`;

const asDate = (x: Date | string | null) => (x === null ? null : x instanceof Date ? x : new Date(x));
function normaliseWar(w: WarRow): WarRow {
  return {
    ...w,
    scheduled_at: asDate(w.scheduled_at)!,
    answer_by: asDate(w.answer_by)!,
    reported_at: asDate(w.reported_at),
    completed_at: asDate(w.completed_at),
    lineups: typeof w.lineups === "string" ? JSON.parse(w.lineups) : w.lineups,
    deltas: typeof w.deltas === "string" ? JSON.parse(w.deltas) : w.deltas,
  };
}

/** A clan's wars: open ones first (soonest start), then the latest finished. */
export async function clanWars(q: Queryable, clanId: string, limit = 30): Promise<WarRow[]> {
  const rows = await q.query<WarRow>(
    `${WAR_SELECT} where w.challenger_id = $1 or w.opponent_id = $1
      order by case when w.status in ${OPEN} then 0 else 1 end, case when w.status in ${OPEN} then w.scheduled_at end asc, w.scheduled_at desc
      limit $2`,
    [clanId, limit],
  );
  return rows.map(normaliseWar);
}

export async function openWarDisputes(q: Queryable): Promise<WarRow[]> {
  const rows = await q.query<WarRow>(`${WAR_SELECT} where w.status = 'disputed' order by w.reported_at`);
  return rows.map(normaliseWar);
}

/** All-time record: completed wars, wins and losses. */
export async function clanRecord(q: Queryable, clanId: string) {
  const [r] = await q.query<{ wars: number; wins: number }>(
    "select count(*)::int as wars, count(*) filter (where winner_id = $1)::int as wins from clan_wars where status = 'completed' and (challenger_id = $1 or opponent_id = $1)",
    [clanId],
  );
  return { wars: r?.wars ?? 0, wins: r?.wins ?? 0, losses: (r?.wars ?? 0) - (r?.wins ?? 0) };
}

export type ClanLadderRow = { clan_id: string; slug: string; name: string; tag: string; status: string; rating: number; wars: number; wins: number; losses: number; peak: number };
export async function clanLadder(q: Queryable, season: string, game: string, limit = 100): Promise<ClanLadderRow[]> {
  if (!isSeason(season)) return [];
  return q.query<ClanLadderRow>(
    `select l.clan_id, c.slug, c.name, c.tag, c.status, l.rating, l.wars, l.wins, l.losses, l.peak
       from clan_ladder l join clans c on c.id = l.clan_id
      where l.season = $1 and l.game = $2 order by l.rating desc, l.wins desc, c.name limit $3`,
    [season, game, limit],
  );
}

/** The clan's standing in each game of a season. */
export async function clanSeason(q: Queryable, clanId: string, season: string) {
  return q.query<{ game: string; rating: number; wars: number; wins: number; losses: number; rank: number }>(
    `select game, rating, wars, wins, losses, rank from (
        select clan_id, game, rating, wars, wins, losses, rank() over (partition by game order by rating desc, wins desc)::int as rank
          from clan_ladder where season = $2) s
      where clan_id = $1 order by game`,
    [clanId, season],
  );
}

export type PlayerLadderRow = { username: string; display_name: string; rating: number; matches: number; wins: number; losses: number };
/** Players' seasonal ladder from quick-match rating changes inside the season (public profiles only). */
export async function playerLadder(q: Queryable, season: string, game: string, limit = 100): Promise<PlayerLadderRow[]> {
  const bounds = seasonBounds(season);
  if (!bounds) return [];
  return q.query<PlayerLadderRow>(
    `with ev as (
        select e.user_id, e.after, e.result,
               row_number() over (partition by e.user_id order by e.created_at desc, e.id desc) as rn
          from rating_events e
         where e.game = $1 and e.created_at >= $2 and e.created_at < $3)
     select u.username, u.display_name, max(ev.after) filter (where ev.rn = 1)::int as rating, count(*)::int as matches,
            count(*) filter (where ev.result = 'win')::int as wins, count(*) filter (where ev.result = 'loss')::int as losses
       from ev join users u on u.id = ev.user_id
      where u.status = 'active' and u.profile_public
      group by u.id, u.username, u.display_name
     having count(*) >= $4
      order by rating desc, wins desc, u.username limit $5`,
    [game, bounds.start, bounds.end, PLAYER_LADDER_MIN, limit],
  );
}

/** Seasons to offer: from the earliest war or rated match to now (newest first, at most 12). */
export async function ladderSeasons(q: Queryable, now = new Date()): Promise<string[]> {
  const [r] = await q.query<{ first: Date | string | null }>(
    "select least((select min(scheduled_at) from clan_wars where status = 'completed'), (select min(created_at) from rating_events)) as first",
  );
  const first = r?.first ? new Date(r.first) : now;
  return seasonsBetween(first, now, 12);
}

/** The account's clan data for the export. */
export async function clanExport(q: Queryable, userId: string) {
  return {
    clanMemberships: await q.query("select c.name, c.tag, m.role, m.joined_at from clan_members m join clans c on c.id = m.clan_id where m.user_id = $1", [userId]),
    clanInvites: await q.query("select c.name, c.tag, i.status, i.created_at, i.responded_at from clan_invites i join clans c on c.id = i.clan_id where i.user_id = $1 order by i.created_at", [userId]),
    clanWars: await q.query(
      `select w.game, a.name as challenger, b.name as opponent, w.scheduled_at, w.status, w.score_challenger, w.score_opponent
         from clan_war_lineups l join clan_wars w on w.id = l.war_id join clans a on a.id = w.challenger_id join clans b on b.id = w.opponent_id
        where l.user_id = $1 order by w.scheduled_at`,
      [userId],
    ),
  };
}

/**
 * Account deletion: the owner of a clan with other members hands it over first (checked by the caller);
 * a sole owner's clan is disbanded; the account leaves its clan, its invitations lapse and it leaves the
 * lineups of wars that have not started.
 */
export async function eraseClanData(q: Queryable, userId: string) {
  const [m] = await q.query<{ clan_id: string; role: ClanRole }>("select clan_id, role from clan_members where user_id = $1", [userId]);
  if (m) {
    await dropFutureLineups(q, m.clan_id, userId);
    await q.query("delete from clan_members where clan_id = $1 and user_id = $2", [m.clan_id, userId]);
    if (m.role === "owner") {
      const [clan] = await q.query<Clan>("select * from clans where id = $1", [m.clan_id]);
      if (clan && (await memberCount(q, clan.id)) === 0) await disband(q, clan, userId);
    }
  }
  await q.query("update clan_invites set status = 'revoked', responded_at = now() where user_id = $1 and status = 'pending'", [userId]);
}

/** Clans whose owner is this account and that still have other members (deletion waits for a handover). */
export async function ownedClansWithMembers(q: Queryable, userId: string): Promise<number> {
  const [r] = await q.query<{ n: number }>(
    `select count(*)::int as n from clan_members m where m.user_id = $1 and m.role = 'owner'
        and exists (select 1 from clan_members o join users u on u.id = o.user_id where o.clan_id = m.clan_id and o.user_id <> $1 and u.status <> 'deleted')`,
    [userId],
  );
  return r?.n ?? 0;
}

export { seasonOf };
