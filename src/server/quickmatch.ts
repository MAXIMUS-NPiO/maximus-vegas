/**
 * Quick match with parties and a ready check (MV-MATCH-1).
 *
 * - A solo player, or a whole party (2–5 players of one game, queued by its leader), waits in the queue of
 *   a game. A party enters and leaves the queue as one unit: all its players or none.
 * - Units of the same size are paired by MV-MATCH-1 (`matchmaking-rules.ts`). A pairing opens a ready
 *   check: every player confirms within READY_SECONDS, and only then does the quick match exist.
 * - A decline or the deadline ends the check: units whose players all confirmed (or, on a decline, did not
 *   decline) return to the queue in their original place; the other units leave it, and the players who
 *   declined or did not answer get a queue cooldown (a dodge).
 * - Everything for one game runs under one advisory lock, so simultaneous joins and answers settle once.
 *   Player locks are taken before any audit record, keeping one lock order across games.
 *
 * No stakes: nothing is wagered and no coins move. Named 1v1 challenges stay in `challenges.ts`.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail } from "./errors.ts";
import { gameBySlug, isGame } from "../lib/games.ts";
import { expireStale } from "./challenges.ts";
import * as v from "./validate.ts";
import { dodgeMinutes, MAX_PARTY, pairUnits, RATING_START, READY_SECONDS, ratingWindow, type PairReasons, type QueueUnit } from "./matchmaking-rules.ts";

export const QUEUE_MINUTES = 30;
const QUICK_MATCH_HOURS = 24;
const OPEN_CHALLENGE = "('pending','accepted','reported','disputed')";

type Side = "a" | "b";
type PartyRow = { id: string; leader_id: string; game: string; created_at: Date };
type CheckRow = { id: string; game: string; size: number; status: string; reasons: Record<string, unknown>; expires_at: Date };

const isId = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x);
const gameName = (slug: string) => gameBySlug(slug)?.name ?? slug;

const lockGame = (q: Queryable, game: string) => q.query("select pg_advisory_xact_lock(hashtext($1))", [`quick:${game}`]);

/** Per-player locks in a fixed order: a player is never queued twice or in two parties by parallel requests. */
async function lockUsers(q: Queryable, ids: string[]) {
  for (const id of [...new Set(ids)].sort()) await q.query("select pg_advisory_xact_lock(hashtext($1))", [`quick-user:${id}`]);
}

async function partyOf(q: Queryable, userId: string): Promise<PartyRow | null> {
  const [p] = await q.query<PartyRow>(
    "select p.id, p.leader_id, p.game, p.created_at from parties p join party_members m on m.party_id = p.id where m.user_id = $1",
    [userId],
  );
  return p ?? null;
}

async function lockParty(q: Queryable, id: string): Promise<PartyRow | null> {
  const [p] = await q.query<PartyRow>("select id, leader_id, game, created_at from parties where id = $1 for update", [id]);
  return p ?? null;
}

async function memberIds(q: Queryable, partyId: string): Promise<string[]> {
  const rows = await q.query<{ user_id: string }>("select user_id from party_members where party_id = $1 order by joined_at, user_id", [partyId]);
  return rows.map((r) => r.user_id);
}

async function partyQueue(q: Queryable, partyId: string): Promise<{ queued: boolean; held: boolean }> {
  const rows = await q.query<{ held_by: string | null }>("select held_by from quick_queue where party_id = $1", [partyId]);
  return { queued: rows.length > 0, held: rows.some((r) => r.held_by) };
}

// ---------- Parties ----------

/** Creates a party for one game with the player as its leader. */
export async function createParty(db: Database, user: SessionUser, gameInput: unknown): Promise<{ id: string }> {
  if (!isGame(gameInput)) fail("invalid_game");
  const game = gameInput as string;
  return db.tx(async (q) => {
    await lockGame(q, game);
    await lockUsers(q, [user.id]);
    if (await partyOf(q, user.id)) fail("already_in_party");
    const [queued] = await q.query("select 1 from quick_queue where user_id = $1", [user.id]);
    if (queued) fail("already_queued");
    const [party] = await q.query<{ id: string }>("insert into parties (leader_id, game) values ($1, $2) returning id", [user.id, game]);
    await q.query("insert into party_members (party_id, user_id) values ($1, $2)", [party.id, user.id]);
    await audit(q, { actorId: user.id, action: "party.created", entity: "party", entityId: party.id, data: { game } });
    return party;
  });
}

/** The leader invites a player by username; up to five players with pending invitations counted. */
export async function inviteToParty(db: Database, user: SessionUser, usernameInput: unknown): Promise<{ created: boolean }> {
  const username = v.username(usernameInput);
  const found = await partyOf(db, user.id);
  if (!found) fail("not_in_party");
  return db.tx(async (q) => {
    await lockGame(q, found!.game);
    const party = await lockParty(q, found!.id);
    if (!party) fail("not_in_party");
    if (party!.leader_id !== user.id) fail("not_party_leader");
    if ((await partyQueue(q, party!.id)).queued) fail("party_queued");
    const [target] = await q.query<{ id: string }>("select id from users where username = $1 and status = 'active'", [username]);
    if (!target) fail("not_found");
    if (target.id === user.id) fail("invalid_input");
    const members = await memberIds(q, party!.id);
    if (members.includes(target.id)) fail("already_member");
    const [existing] = await q.query<{ id: string }>("select id from party_invites where party_id = $1 and user_id = $2 and status = 'pending'", [party!.id, target.id]);
    if (existing) return { created: false };
    const [pending] = await q.query<{ n: number }>("select count(*)::int as n from party_invites where party_id = $1 and status = 'pending'", [party!.id]);
    if (members.length + (pending?.n ?? 0) >= MAX_PARTY) fail("party_full");
    const [invite] = await q.query<{ id: string }>("insert into party_invites (party_id, user_id, invited_by) values ($1, $2, $3) returning id", [party!.id, target.id, user.id]);
    await notify(q, [target.id], "party_invite", { by: user.username, game: gameName(party!.game), quick: "1" });
    await audit(q, { actorId: user.id, action: "party.invited", entity: "party", entityId: party!.id, data: { invite: invite.id, player: target.id } });
    return { created: true };
  });
}

/** The leader withdraws a pending invitation. */
export async function revokePartyInvite(db: Database, user: SessionUser, inviteId: unknown): Promise<{ changed: boolean }> {
  if (!isId(inviteId)) fail("invite_not_found");
  return db.tx(async (q) => {
    const [invite] = await q.query<{ id: string; party_id: string; status: string; leader_id: string }>(
      "select i.id, i.party_id, i.status, p.leader_id from party_invites i join parties p on p.id = i.party_id where i.id = $1 for update of i",
      [inviteId],
    );
    if (!invite) fail("invite_not_found");
    if (invite.leader_id !== user.id) fail("not_party_leader");
    if (invite.status !== "pending") return { changed: false };
    await q.query("update party_invites set status = 'revoked', responded_at = now() where id = $1", [invite.id]);
    await audit(q, { actorId: user.id, action: "party.invite_revoked", entity: "party", entityId: invite.party_id, data: { invite: invite.id } });
    return { changed: true };
  });
}

/** The invited player joins the party or declines; joining is refused while the party is queued. */
export async function respondPartyInvite(db: Database, user: SessionUser, inviteId: unknown, accept: boolean): Promise<{ joined: boolean }> {
  if (!isId(inviteId)) fail("invite_not_found");
  const [ref] = await db.query<{ party_id: string; game: string }>(
    "select i.party_id, p.game from party_invites i join parties p on p.id = i.party_id where i.id = $1 and i.user_id = $2 and i.status = 'pending'",
    [inviteId, user.id],
  );
  if (!ref) fail("invite_not_found");
  return db.tx(async (q) => {
    await lockGame(q, ref.game);
    await lockUsers(q, [user.id]);
    const party = await lockParty(q, ref.party_id);
    const [invite] = await q.query<{ id: string }>("select id from party_invites where id = $1 and user_id = $2 and status = 'pending' for update", [inviteId, user.id]);
    if (!party || !invite) fail("invite_not_found");
    if (!accept) {
      await q.query("update party_invites set status = 'declined', responded_at = now() where id = $1", [invite.id]);
      await notify(q, [party!.leader_id], "party_declined", { user: user.username, quick: "1" });
      await audit(q, { actorId: user.id, action: "party.invite_declined", entity: "party", entityId: party!.id, data: { invite: invite.id } });
      return { joined: false };
    }
    if (await partyOf(q, user.id)) fail("already_in_party");
    const [queued] = await q.query("select 1 from quick_queue where user_id = $1", [user.id]);
    if (queued) fail("already_queued");
    if ((await partyQueue(q, party!.id)).queued) fail("party_queued");
    const members = await memberIds(q, party!.id);
    if (members.length >= MAX_PARTY) fail("party_full");
    await q.query("insert into party_members (party_id, user_id) values ($1, $2)", [party!.id, user.id]);
    await q.query("update party_invites set status = 'accepted', responded_at = now() where id = $1", [invite.id]);
    // A player is in one party: their other invitations lapse.
    await q.query("update party_invites set status = 'revoked', responded_at = now() where user_id = $1 and status = 'pending'", [user.id]);
    await notify(q, members, "party_joined", { user: user.username, quick: "1" });
    await audit(q, { actorId: user.id, action: "party.joined", entity: "party", entityId: party!.id, data: { invite: invite.id } });
    return { joined: true };
  });
}

/**
 * A member leaves; the leader leaving disbands the party. A queued party leaves the queue first; during a
 * ready check the roster is fixed (decline the check instead).
 */
export async function leaveParty(db: Database, user: SessionUser): Promise<{ disbanded: boolean }> {
  const found = await partyOf(db, user.id);
  if (!found) fail("not_in_party");
  return db.tx(async (q) => {
    await lockGame(q, found!.game);
    const party = await lockParty(q, found!.id);
    if (!party) return { disbanded: false };
    const members = await memberIds(q, party.id);
    if (!members.includes(user.id)) return { disbanded: false };
    const queue = await partyQueue(q, party.id);
    if (queue.held) fail("ready_check_pending");
    if (queue.queued) await q.query("delete from quick_queue where party_id = $1", [party.id]);
    const others = members.filter((m) => m !== user.id);
    if (party.leader_id === user.id) {
      await q.query("delete from parties where id = $1", [party.id]);
      await notify(q, others, "party_disbanded", { by: user.username, quick: "1" });
      await audit(q, { actorId: user.id, action: "party.disbanded", entity: "party", entityId: party.id, data: { members, queued: queue.queued } });
      return { disbanded: true };
    }
    await q.query("delete from party_members where party_id = $1 and user_id = $2", [party.id, user.id]);
    await notify(q, others, "party_left", { user: user.username, quick: "1" });
    await audit(q, { actorId: user.id, action: "party.left", entity: "party", entityId: party.id, data: { queued: queue.queued } });
    return { disbanded: false };
  });
}

/** The leader removes a member; same queue rules as leaving. */
export async function removeFromParty(db: Database, user: SessionUser, memberInput: unknown): Promise<{ changed: boolean }> {
  if (!isId(memberInput)) fail("not_found");
  const memberId = memberInput as string;
  const found = await partyOf(db, user.id);
  if (!found) fail("not_in_party");
  return db.tx(async (q) => {
    await lockGame(q, found!.game);
    const party = await lockParty(q, found!.id);
    if (!party || party.leader_id !== user.id) fail("not_party_leader");
    if (memberId === user.id) fail("invalid_input");
    const members = await memberIds(q, party!.id);
    if (!members.includes(memberId)) return { changed: false };
    const queue = await partyQueue(q, party!.id);
    if (queue.held) fail("ready_check_pending");
    if (queue.queued) await q.query("delete from quick_queue where party_id = $1", [party!.id]);
    await q.query("delete from party_members where party_id = $1 and user_id = $2", [party!.id, memberId]);
    await notify(q, [memberId], "party_removed", { by: user.username, quick: "1" });
    if (queue.queued) await notify(q, members.filter((m) => m !== memberId && m !== user.id), "party_queue_left", { user: user.username, quick: "1" });
    await audit(q, { actorId: user.id, action: "party.removed", entity: "party", entityId: party!.id, data: { player: memberId, queued: queue.queued } });
    return { changed: true };
  });
}

// ---------- Queue and ready check ----------

type CreatedCheck = { id: string; players: string[] };

/** Pairs the waiting units of a game by MV-MATCH-1 and opens a ready check for each pair. */
async function matchQueue(q: Queryable, game: string): Promise<CreatedCheck[]> {
  const rows = await q.query<{ user_id: string; party_id: string | null; region: string; joined_at: Date; rating: number; leader_id: string | null; party_size: number | null }>(
    `select qq.user_id, qq.party_id, qq.region, qq.joined_at, coalesce(r.rating, ${RATING_START})::int as rating, p.leader_id,
            (select count(*)::int from party_members pm where pm.party_id = qq.party_id) as party_size
       from quick_queue qq join users u on u.id = qq.user_id and u.status = 'active'
       left join ratings r on r.user_id = qq.user_id and r.game = qq.game
       left join parties p on p.id = qq.party_id
      where qq.game = $1 and qq.held_by is null and qq.expires_at > now()
      order by qq.joined_at, qq.user_id
      for update of qq`,
    [game],
  );
  if (rows.length < 2) return [];
  const units = new Map<string, QueueUnit & { size: number; sum: number }>();
  for (const r of rows) {
    const key = r.party_id ?? r.user_id;
    const unit = units.get(key) ?? { key, leaderId: r.leader_id ?? r.user_id, members: [], rating: 0, sum: 0, region: r.region, queuedAt: new Date(r.joined_at), size: r.party_id ? (r.party_size ?? 0) : 1 };
    unit.members.push(r.user_id);
    unit.sum += Number(r.rating);
    if (new Date(r.joined_at) < unit.queuedAt) unit.queuedAt = new Date(r.joined_at);
    units.set(key, unit);
  }
  // A party is matched only whole: a member who left the active players keeps it out until it requeues.
  const ready = [...units.values()].filter((u) => u.members.length === u.size).map((u) => ({ ...u, rating: Math.round(u.sum / u.members.length) }));
  if (ready.length < 2) return [];
  const leaders = ready.map((u) => u.leaderId);
  const open = await q.query<{ a: string; b: string }>(
    `select challenger_id as a, opponent_id as b from challenges
      where game = $1 and status in ${OPEN_CHALLENGE} and challenger_id = any($2::uuid[]) and opponent_id = any($2::uuid[])`,
    [game, leaders],
  );
  const blockedPairs = new Set(open.flatMap((o) => [`${o.a}:${o.b}`, `${o.b}:${o.a}`]));
  const [{ now }] = await q.query<{ now: Date }>("select now() as now");
  const pairs = pairUnits(ready, new Date(now), (x, y) => blockedPairs.has(`${x}:${y}`));
  const created: CreatedCheck[] = [];
  for (const { a, b, reasons } of pairs) {
    const [check] = await q.query<{ id: string }>(
      "insert into ready_checks (game, size, reasons, expires_at) values ($1, $2, $3, now() + ($4 || ' seconds')::interval) returning id",
      [game, reasons.size, JSON.stringify({ ...reasons, ratingA: a.rating, ratingB: b.rating }), String(READY_SECONDS)],
    );
    for (const [side, unit] of [
      ["a", a],
      ["b", b],
    ] as const)
      await q.query(
        `insert into ready_check_players (ready_check_id, user_id, side, party_id, queued_at, region)
         select $1, m, $2, $3, $4, $5 from unnest($6::uuid[]) as m`,
        [check.id, side, unit.members.length > 1 ? unit.key : null, unit.queuedAt, unit.region, unit.members],
      );
    const players = [...a.members, ...b.members];
    await q.query("update quick_queue set held_by = $1 where user_id = any($2::uuid[])", [check.id, players]);
    await notify(q, players, "ready_check", { game: gameName(game), seconds: String(READY_SECONDS), quick: "1" });
    await audit(q, { actorId: null, action: "quick_match.ready_check", entity: "ready_check", entityId: check.id, data: { game, size: reasons.size, gap: reasons.gap, region: reasons.region, players } });
    created.push({ id: check.id, players });
  }
  return created;
}

type CheckPlayer = { user_id: string; side: Side; party_id: string | null; answer: string | null; status: string };

/**
 * Ends a ready check without a match. `declined`: the units with a declining player leave the queue, the
 * others return. `expired`: only units whose players all confirmed return. `conflict`: everyone returns.
 */
async function failReadyCheck(q: Queryable, check: CheckRow, cause: "declined" | "expired" | "conflict", actorId: string | null) {
  const players = await q.query<CheckPlayer>(
    `select rp.user_id, rp.side, rp.party_id, rp.answer, u.status from ready_check_players rp join users u on u.id = rp.user_id
      where rp.ready_check_id = $1 order by rp.side, rp.user_id`,
    [check.id],
  );
  const units = new Map<string, CheckPlayer[]>();
  for (const p of players) units.set(p.party_id ?? p.user_id, [...(units.get(p.party_id ?? p.user_id) ?? []), p]);
  const returned: string[] = [];
  const removed: string[] = [];
  const dodges: { id: string; kind: "declined" | "missed" }[] = [];
  for (const unit of units.values()) {
    const failed =
      cause === "conflict" ? false : cause === "declined" ? unit.some((p) => p.answer === "declined") : unit.some((p) => p.answer !== "ready");
    if (!failed) {
      returned.push(...unit.map((p) => p.user_id));
      continue;
    }
    removed.push(...unit.map((p) => p.user_id));
    for (const p of unit) {
      if (p.status !== "active") continue;
      if (p.answer === "declined") dodges.push({ id: p.user_id, kind: "declined" });
      else if (cause === "expired" && p.answer !== "ready") dodges.push({ id: p.user_id, kind: "missed" });
    }
  }
  if (removed.length) await q.query("delete from quick_queue where held_by = $1 and user_id = any($2::uuid[])", [check.id, removed]);
  if (returned.length) await q.query("update quick_queue set held_by = null where held_by = $1 and user_id = any($2::uuid[])", [check.id, returned]);
  const cooldowns: Record<string, number> = {};
  for (const d of dodges) {
    const [recent] = await q.query<{ n: number }>("select count(*)::int as n from quick_dodges where user_id = $1 and created_at > now() - interval '24 hours'", [d.id]);
    const minutes = dodgeMinutes((recent?.n ?? 0) + 1);
    cooldowns[d.id] = minutes;
    await q.query(
      "insert into quick_dodges (user_id, game, ready_check_id, kind, cooldown_until) values ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval)",
      [d.id, check.game, check.id, d.kind, String(minutes)],
    );
    await notify(q, [d.id], "ready_check_dodged", { game: gameName(check.game), minutes: String(minutes), quick: "1" });
  }
  await notify(q, returned, "ready_check_returned", { game: gameName(check.game), quick: "1" });
  await notify(q, removed.filter((id) => !(id in cooldowns)), "ready_check_removed", { game: gameName(check.game), quick: "1" });
  await q.query("update ready_checks set status = 'failed', settled_at = now(), reasons = reasons || $2::jsonb where id = $1", [check.id, JSON.stringify({ failure: cause })]);
  await audit(q, { actorId, action: "quick_match.ready_check_failed", entity: "ready_check", entityId: check.id, data: { cause, returned, removed, cooldowns } });
  if (returned.length) await matchQueue(q, check.game);
}

/** Everyone confirmed: the quick match is created between the two sides' leaders with every player recorded. */
async function passReadyCheck(q: Queryable, check: CheckRow, actorId: string): Promise<string | null> {
  const players = await q.query<{ user_id: string; side: Side; party_id: string | null }>(
    "select user_id, side, party_id from ready_check_players where ready_check_id = $1 order by side, user_id",
    [check.id],
  );
  const leaderOf = async (side: Side) => {
    const own = players.filter((p) => p.side === side);
    if (!own[0].party_id) return own[0].user_id;
    const [party] = await q.query<{ leader_id: string }>("select leader_id from parties where id = $1", [own[0].party_id]);
    return party?.leader_id ?? own[0].user_id;
  };
  const a = await leaderOf("a");
  const b = await leaderOf("b");
  const [clash] = await q.query(
    `select 1 from challenges where game = $1 and status in ${OPEN_CHALLENGE}
        and least(challenger_id, opponent_id) = least($2::uuid, $3::uuid) and greatest(challenger_id, opponent_id) = greatest($2::uuid, $3::uuid)`,
    [check.game, a, b],
  );
  if (clash) {
    await failReadyCheck(q, check, "conflict", actorId);
    return null;
  }
  const [match] = await q.query<{ id: string }>(
    `insert into challenges (kind, game, challenger_id, opponent_id, status, responded_at, expires_at)
     values ('quick', $1, $2, $3, 'accepted', now(), now() + ($4 || ' hours')::interval) returning id`,
    [check.game, a, b, String(QUICK_MATCH_HOURS)],
  );
  await q.query("insert into challenge_members (challenge_id, user_id, side) select $1, user_id, side from ready_check_players where ready_check_id = $2", [match.id, check.id]);
  await q.query("delete from quick_queue where held_by = $1", [check.id]);
  await q.query("update ready_checks set status = 'passed', challenge_id = $2, settled_at = now() where id = $1", [check.id, match.id]);
  await notify(q, players.map((p) => p.user_id), "quick_match_found", { challengeId: match.id, game: check.game, quick: "1" });
  await audit(q, { actorId, action: "quick_match.matched", entity: "challenge", entityId: match.id, data: { game: check.game, readyCheck: check.id, size: check.size, opponent: b } });
  return match.id;
}

/** Ready checks of a game past their deadline end as `expired`. Runs inside the game lock. */
async function settleExpired(q: Queryable, game: string) {
  const due = await q.query<CheckRow>(
    "select id, game, size, status, reasons, expires_at from ready_checks where game = $1 and status = 'pending' and expires_at <= now() order by expires_at for update",
    [game],
  );
  for (const check of due) await failReadyCheck(q, check, "expired", null);
  return due.length;
}

/**
 * Moves the queue of a game forward without a new join: ends expired ready checks and pairs units whose
 * rating window has widened. Called while a player watches the queue, before answers and leaves, and by
 * the daily maintenance. Returns the number of checks settled and opened.
 */
export async function pulseQueue(db: Database, game: string): Promise<{ settled: number; opened: number }> {
  if (!isGame(game)) return { settled: 0, opened: 0 };
  const [work] = await db.query<{ due: boolean; waiting: number }>(
    `select exists (select 1 from ready_checks where game = $1 and status = 'pending' and expires_at <= now()) as due,
            (select count(distinct coalesce(party_id, user_id))::int from quick_queue where game = $1 and held_by is null and expires_at > now()) as waiting`,
    [game],
  );
  if (!work?.due && (work?.waiting ?? 0) < 2) return { settled: 0, opened: 0 };
  return db.tx(async (q) => {
    await lockGame(q, game);
    await expireStale(q);
    const settled = await settleExpired(q, game);
    const opened = (await matchQueue(q, game)).length;
    return { settled, opened };
  });
}

/** Maintenance: pulses every game with a queue or a pending ready check. */
export async function pulseAllQueues(db: Database): Promise<number> {
  const games = await db.query<{ game: string }>(
    "select game from quick_queue union select game from ready_checks where status = 'pending'",
  );
  let n = 0;
  for (const { game } of games) {
    const r = await pulseQueue(db, game);
    n += r.settled + r.opened;
  }
  return n;
}

/**
 * Joins the queue: a solo player, or the leader with the whole party (the party's game; all players are
 * queued in one statement or none). Then pairs the queue; returns the ready check the player landed in.
 */
export async function joinQuickMatch(db: Database, user: SessionUser, gameInput: unknown, regionInput: unknown = ""): Promise<{ readyCheck: string | null }> {
  const region = v.oneLine(regionInput, 40);
  const found = await partyOf(db, user.id);
  const game = found ? found.game : isGame(gameInput) ? (gameInput as string) : fail("invalid_game");
  await pulseQueue(db, game);
  return db.tx(async (q) => {
    await lockGame(q, game);
    let members = [user.id];
    let partyId: string | null = null;
    if (found) {
      const party = await lockParty(q, found.id);
      if (!party) fail("not_in_party");
      if (party!.leader_id !== user.id) fail("not_party_leader");
      members = await memberIds(q, party!.id);
      if (members.length < 2) fail("party_too_small");
      partyId = party!.id;
    }
    await lockUsers(q, members);
    if (!found && (await partyOf(q, user.id))) fail("already_in_party");
    await expireStale(q);
    const queued = await q.query("select 1 from quick_queue where user_id = any($1::uuid[])", [members]);
    if (queued.length) fail("already_queued");
    const [active] = await q.query<{ n: number }>("select count(*)::int as n from users where id = any($1::uuid[]) and status = 'active'", [members]);
    if ((active?.n ?? 0) !== members.length) fail("party_member_inactive");
    const [cool] = await q.query<{ until: Date | null }>("select max(cooldown_until) as until from quick_dodges where user_id = any($1::uuid[]) and cooldown_until > now()", [members]);
    if (cool?.until) fail("queue_cooldown");
    await q.query(
      `insert into quick_queue (user_id, game, expires_at, party_id, region)
       select m, $2, now() + ($3 || ' minutes')::interval, $4, $5 from unnest($1::uuid[]) as m`,
      [members, game, String(QUEUE_MINUTES), partyId, region],
    );
    if (partyId) await notify(q, members.filter((m) => m !== user.id), "party_queued", { by: user.username, game: gameName(game), quick: "1" });
    await audit(q, { actorId: user.id, action: "quick_match.queued", entity: "user", entityId: user.id, data: { game, party: partyId, size: members.length, region } });
    const created = await matchQueue(q, game);
    return { readyCheck: created.find((c) => c.players.includes(user.id))?.id ?? null };
  });
}

/** A player confirms or declines the ready check they are in. */
export async function answerReadyCheck(
  db: Database,
  user: SessionUser,
  checkId: unknown,
  ready: boolean,
): Promise<{ status: "pending" | "passed" | "failed"; challengeId: string | null; expired?: boolean }> {
  if (!isId(checkId)) fail("ready_check_closed");
  const [ref] = await db.query<{ game: string }>("select game from ready_checks where id = $1", [checkId]);
  if (!ref) fail("ready_check_closed");
  return db.tx(async (q) => {
    await lockGame(q, ref.game);
    const [check] = await q.query<CheckRow>("select id, game, size, status, reasons, expires_at from ready_checks where id = $1 for update", [checkId]);
    if (check.status !== "pending") fail("ready_check_closed");
    const [me] = await q.query<{ answer: string | null }>("select answer from ready_check_players where ready_check_id = $1 and user_id = $2", [check.id, user.id]);
    if (!me) fail("forbidden");
    const [{ late }] = await q.query<{ late: boolean }>("select $1::timestamptz <= now() as late", [check.expires_at]);
    if (late) {
      await failReadyCheck(q, check, "expired", null);
      return { status: "failed", challengeId: null, expired: true };
    }
    if (ready) {
      if (me.answer === "ready") return { status: "pending", challengeId: null };
      await q.query("update ready_check_players set answer = 'ready', answered_at = now() where ready_check_id = $1 and user_id = $2", [check.id, user.id]);
      const [left] = await q.query<{ n: number }>("select count(*)::int as n from ready_check_players where ready_check_id = $1 and answer is distinct from 'ready'", [check.id]);
      if ((left?.n ?? 0) > 0) return { status: "pending", challengeId: null };
      const challengeId = await passReadyCheck(q, check, user.id);
      return { status: challengeId ? "passed" : "failed", challengeId };
    }
    await q.query("update ready_check_players set answer = 'declined', answered_at = now() where ready_check_id = $1 and user_id = $2", [check.id, user.id]);
    await failReadyCheck(q, check, "declined", user.id);
    return { status: "failed", challengeId: null };
  });
}

/**
 * Cancels the search: a solo player leaves, a party member takes the whole party out. During a ready check
 * leaving counts as declining it.
 */
export async function leaveQuickMatch(db: Database, user: SessionUser): Promise<{ left: boolean }> {
  const [ref] = await db.query<{ game: string }>("select game from quick_queue where user_id = $1", [user.id]);
  if (!ref) return { left: false };
  return db.tx(async (q) => {
    await lockGame(q, ref.game);
    const [row] = await q.query<{ party_id: string | null; held_by: string | null }>("select party_id, held_by from quick_queue where user_id = $1 for update", [user.id]);
    if (!row) return { left: false };
    if (row.held_by) {
      const [check] = await q.query<CheckRow>("select id, game, size, status, reasons, expires_at from ready_checks where id = $1 for update", [row.held_by]);
      if (check?.status === "pending") {
        await q.query("update ready_check_players set answer = 'declined', answered_at = now() where ready_check_id = $1 and user_id = $2", [check.id, user.id]);
        await failReadyCheck(q, check, "declined", user.id);
        return { left: true };
      }
    }
    const unit = row.party_id
      ? (await q.query<{ user_id: string }>("select user_id from quick_queue where party_id = $1", [row.party_id])).map((r) => r.user_id)
      : [user.id];
    if (row.party_id) await q.query("delete from quick_queue where party_id = $1", [row.party_id]);
    else await q.query("delete from quick_queue where user_id = $1", [user.id]);
    if (row.party_id) await notify(q, unit.filter((id) => id !== user.id), "party_queue_left", { user: user.username, quick: "1" });
    await audit(q, { actorId: user.id, action: "quick_match.left", entity: "user", entityId: user.id, data: { game: ref.game, party: row.party_id } });
    return { left: true };
  });
}

// ---------- Views ----------

export type QueueView = {
  mine: { game: string; joinedAt: Date; expiresAt: Date; region: string; party: boolean; waitedSeconds: number; window: number | null } | null;
  /** Units waiting per game (a party counts once), outside ready checks. */
  waiting: Record<string, number>;
  check: {
    id: string;
    game: string;
    size: number;
    expiresAt: Date;
    reasons: PairReasons & { ratingA?: number; ratingB?: number };
    mySide: Side;
    myAnswer: string | null;
    own: { username: string; displayName: string; answer: string | null }[];
    other: { total: number; ready: number };
  } | null;
  /** The player's latest ended ready check within ten minutes, with what it meant for them. */
  last: { status: "passed" | "failed"; cause: string; outcome: "matched" | "returned" | "removed" | "dodged"; at: Date } | null;
  cooldownUntil: Date | null;
};

export async function queueView(q: Queryable, userId: string): Promise<QueueView> {
  const [mine] = await q.query<{ game: string; joined_at: Date; expires_at: Date; region: string; party_id: string | null; held_by: string | null; waited: number }>(
    `select game, joined_at, expires_at, region, party_id, held_by, extract(epoch from now() - joined_at)::int as waited
       from quick_queue where user_id = $1 and (expires_at > now() or held_by is not null)`,
    [userId],
  );
  const waitingRows = await q.query<{ game: string; n: number }>(
    "select game, count(distinct coalesce(party_id, user_id))::int as n from quick_queue where expires_at > now() and held_by is null group by game",
  );
  let check: QueueView["check"] = null;
  if (mine?.held_by) {
    const [c] = await q.query<{ id: string; game: string; size: number; expires_at: Date; reasons: PairReasons & { ratingA?: number; ratingB?: number }; status: string }>(
      "select id, game, size, expires_at, reasons, status from ready_checks where id = $1",
      [mine.held_by],
    );
    if (c && c.status === "pending") {
      const players = await q.query<{ user_id: string; side: Side; answer: string | null; username: string; display_name: string }>(
        `select rp.user_id, rp.side, rp.answer, u.username, u.display_name from ready_check_players rp join users u on u.id = rp.user_id
          where rp.ready_check_id = $1 order by rp.side, u.username`,
        [c.id],
      );
      const me = players.find((p) => p.user_id === userId);
      if (me) {
        const others = players.filter((p) => p.side !== me.side);
        check = {
          id: c.id,
          game: c.game,
          size: c.size,
          expiresAt: c.expires_at,
          reasons: c.reasons,
          mySide: me.side,
          myAnswer: me.answer,
          own: players.filter((p) => p.side === me.side).map((p) => ({ username: p.username, displayName: p.display_name, answer: p.answer })),
          other: { total: others.length, ready: others.filter((p) => p.answer === "ready").length },
        };
      }
    }
  }
  const [last] = await q.query<{ status: "passed" | "failed"; reasons: { failure?: string }; settled_at: Date; answer: string | null; side: Side; party_id: string | null; still: boolean; dodged: boolean }>(
    `select rc.status, rc.reasons, rc.settled_at, rp.answer, rp.side, rp.party_id,
            exists (select 1 from quick_queue qq where qq.user_id = rp.user_id and qq.expires_at > now()) as still,
            exists (select 1 from quick_dodges d where d.ready_check_id = rc.id and d.user_id = rp.user_id) as dodged
       from ready_check_players rp join ready_checks rc on rc.id = rp.ready_check_id
      where rp.user_id = $1 and rc.status <> 'pending' and rc.settled_at > now() - interval '10 minutes'
      order by rc.settled_at desc limit 1`,
    [userId],
  );
  const [cool] = await q.query<{ until: Date | null }>("select max(cooldown_until) as until from quick_dodges where user_id = $1 and cooldown_until > now()", [userId]);
  return {
    mine: mine
      ? { game: mine.game, joinedAt: mine.joined_at, expiresAt: mine.expires_at, region: mine.region, party: Boolean(mine.party_id), waitedSeconds: mine.waited, window: ratingWindow(mine.waited) }
      : null,
    waiting: Object.fromEntries(waitingRows.map((w) => [w.game, w.n])),
    check,
    last: last
      ? {
          status: last.status,
          cause: last.reasons?.failure ?? "",
          outcome: last.status === "passed" ? "matched" : last.dodged ? "dodged" : last.still ? "returned" : "removed",
          at: last.settled_at,
        }
      : null,
    cooldownUntil: cool?.until ?? null,
  };
}

export type PartyView = {
  party: {
    id: string;
    game: string;
    leaderId: string;
    members: { id: string; username: string; displayName: string; rating: number; matches: number }[];
    invites: { id: string; username: string; displayName: string }[];
    queued: boolean;
    held: boolean;
  } | null;
  incoming: { id: string; game: string; by: string; byName: string; size: number }[];
};

export async function partyView(q: Queryable, userId: string): Promise<PartyView> {
  const found = await partyOf(q, userId);
  let party: PartyView["party"] = null;
  if (found) {
    const members = await q.query<{ id: string; username: string; display_name: string; rating: number | null; matches: number | null }>(
      `select u.id, u.username, u.display_name, r.rating, r.matches from party_members m join users u on u.id = m.user_id
         left join ratings r on r.user_id = m.user_id and r.game = $2
        where m.party_id = $1 order by (u.id = $3) desc, m.joined_at`,
      [found.id, found.game, found.leader_id],
    );
    const invites = await q.query<{ id: string; username: string; display_name: string }>(
      "select i.id, u.username, u.display_name from party_invites i join users u on u.id = i.user_id where i.party_id = $1 and i.status = 'pending' order by i.created_at",
      [found.id],
    );
    const queue = await partyQueue(q, found.id);
    party = {
      id: found.id,
      game: found.game,
      leaderId: found.leader_id,
      members: members.map((m) => ({ id: m.id, username: m.username, displayName: m.display_name, rating: m.rating ?? RATING_START, matches: m.matches ?? 0 })),
      invites: invites.map((i) => ({ id: i.id, username: i.username, displayName: i.display_name })),
      queued: queue.queued,
      held: queue.held,
    };
  }
  const incoming = await q.query<{ id: string; game: string; by: string; by_name: string; size: number }>(
    `select i.id, p.game, u.username as by, u.display_name as by_name, (select count(*)::int from party_members m where m.party_id = p.id) as size
       from party_invites i join parties p on p.id = i.party_id join users u on u.id = p.leader_id
      where i.user_id = $1 and i.status = 'pending' order by i.created_at desc`,
    [userId],
  );
  return { party, incoming: incoming.map((i) => ({ id: i.id, game: i.game, by: i.by, byName: i.by_name, size: i.size })) };
}
