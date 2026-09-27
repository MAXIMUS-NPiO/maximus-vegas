/**
 * 1v1 Challenges and Quick Match share one data model but stay distinct products:
 *  - a Challenge names a specific opponent, who accepts or declines;
 *  - Quick Match skips opponent choice and pairs the player with a real player already waiting for the
 *    same game — never a bot, never an invented opponent.
 * Both are stake-free: there is no stake field at all, no coins change hands and nothing is wagered.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { isStaff, notify } from "./access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { isGame } from "../lib/games.ts";
import { grantXp, XP } from "./progression.ts";
import * as v from "./validate.ts";

const CHALLENGE_HOURS = 72;
const QUICK_MATCH_HOURS = 24;
const QUEUE_MINUTES = 30;

type Row = {
  id: string;
  kind: "challenge" | "quick";
  game: string;
  challenger_id: string;
  opponent_id: string;
  status: string;
  reported_by: string | null;
  reported_winner: string | null;
  expires_at: Date;
};

async function lock(q: Queryable, id: string): Promise<Row> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) fail("challenge_not_found");
  const [row] = await q.query<Row>("select * from challenges where id = $1 for update", [id]);
  if (!row) fail("challenge_not_found");
  return row;
}

const other = (c: Row, userId: string) => (c.challenger_id === userId ? c.opponent_id : c.challenger_id);
const isSide = (c: Row, userId: string) => c.challenger_id === userId || c.opponent_id === userId;

export async function expireStale(q: Queryable) {
  await q.query("update challenges set status = 'expired' where status in ('pending','accepted') and expires_at < now()");
  await q.query("delete from quick_queue where expires_at < now()");
}

export async function createChallenge(db: Database, user: SessionUser, input: { opponent: unknown; game: unknown; message: unknown }) {
  const username = v.username(input.opponent);
  if (!isGame(input.game)) fail("invalid_game");
  const message = v.clean(input.message, 300);
  return db.tx(async (q) => {
    await expireStale(q);
    const [target] = await q.query<{ id: string }>("select id from users where username = $1 and status = 'active'", [username]);
    if (!target) fail("not_found");
    if (target.id === user.id) fail("cannot_challenge_self");
    try {
      const [row] = await q.query<{ id: string }>(
        `insert into challenges (kind, game, challenger_id, opponent_id, message, expires_at)
         values ('challenge', $1, $2, $3, $4, now() + ($5 || ' hours')::interval) returning id`,
        [input.game, user.id, target.id, message, String(CHALLENGE_HOURS)],
      );
      await notify(q, [target.id], "challenge_received", { challengeId: row.id, by: user.username, game: input.game });
      await audit(q, { actorId: user.id, action: "challenge.created", entity: "challenge", entityId: row.id, data: { opponent: target.id, game: input.game } });
      return row.id;
    } catch (error) {
      if (isUniqueViolation(error)) fail("challenge_exists");
      throw error;
    }
  });
}

export async function respondChallenge(db: Database, user: SessionUser, id: string, accept: boolean) {
  await db.tx(async (q) => {
    await expireStale(q);
    const c = await lock(q, id);
    if (c.opponent_id !== user.id || c.kind !== "challenge") fail("forbidden");
    if (c.status !== "pending") fail("challenge_closed");
    await q.query("update challenges set status = $2, responded_at = now() where id = $1", [c.id, accept ? "accepted" : "declined"]);
    await notify(q, [c.challenger_id], accept ? "challenge_accepted" : "challenge_declined", { challengeId: c.id, by: user.username });
    await audit(q, { actorId: user.id, action: accept ? "challenge.accepted" : "challenge.declined", entity: "challenge", entityId: c.id });
  });
}

export async function cancelChallenge(db: Database, user: SessionUser, id: string) {
  await db.tx(async (q) => {
    const c = await lock(q, id);
    if (!isSide(c, user.id)) fail("forbidden");
    const cancellable = (c.status === "pending" && c.challenger_id === user.id) || (c.status === "accepted" && c.kind === "quick");
    if (!cancellable) fail("challenge_closed");
    await q.query("update challenges set status = 'cancelled' where id = $1", [c.id]);
    await notify(q, [other(c, user.id)], "challenge_cancelled", { challengeId: c.id, by: user.username });
    await audit(q, { actorId: user.id, action: "challenge.cancelled", entity: "challenge", entityId: c.id });
  });
}

/** One side reports the winner; the other side confirms or disputes. */
export async function reportChallenge(
  db: Database,
  user: SessionUser,
  id: string,
  input: { result: unknown; myScore: unknown; theirScore: unknown; evidenceUrl: unknown },
) {
  const iWon = input.result === "won" ? true : input.result === "lost" ? false : fail("invalid_input");
  const myScore = String(input.myScore ?? "").trim() === "" ? null : v.intIn(input.myScore, 0, 999);
  const theirScore = String(input.theirScore ?? "").trim() === "" ? null : v.intIn(input.theirScore, 0, 999);
  if (myScore !== null && theirScore !== null && (myScore === theirScore || myScore > theirScore !== iWon)) fail("invalid_input");
  const evidence = v.optionalUrl(input.evidenceUrl);
  await db.tx(async (q) => {
    await expireStale(q);
    const c = await lock(q, id);
    if (!isSide(c, user.id)) fail("forbidden");
    if (c.status !== "accepted") fail("challenge_closed");
    const winner = iWon ? user.id : other(c, user.id);
    const mine = c.challenger_id === user.id;
    await q.query(
      `update challenges set status = 'reported', reported_by = $2, reported_winner = $3, score_challenger = $4, score_opponent = $5, evidence_url = $6
        where id = $1`,
      [c.id, user.id, winner, mine ? myScore : theirScore, mine ? theirScore : myScore, evidence],
    );
    await notify(q, [other(c, user.id)], "challenge_reported", { challengeId: c.id, by: user.username });
    await audit(q, { actorId: user.id, action: "challenge.reported", entity: "challenge", entityId: c.id, data: { winner } });
  });
}

async function finish(q: Queryable, c: Row, winner: string) {
  await q.query("update challenges set status = 'completed', winner_id = $2, completed_at = now() where id = $1", [c.id, winner]);
  const loser = winner === c.challenger_id ? c.opponent_id : c.challenger_id;
  await grantXp(q, [winner], XP.challengeWin, "challenge_win", c.game, c.id, `challenge:${c.id}:win`);
  await grantXp(q, [loser], XP.challengePlayed, "challenge_played", c.game, c.id, `challenge:${c.id}:played`);
  await notify(q, [c.challenger_id, c.opponent_id], "challenge_completed", { challengeId: c.id });
}

export async function confirmChallenge(db: Database, user: SessionUser, id: string) {
  await db.tx(async (q) => {
    const c = await lock(q, id);
    if (!isSide(c, user.id)) fail("forbidden");
    if (c.status !== "reported") fail("challenge_closed");
    if (c.reported_by === user.id) fail("own_result");
    await finish(q, c, c.reported_winner!);
    await audit(q, { actorId: user.id, action: "challenge.confirmed", entity: "challenge", entityId: c.id });
  });
}

export async function disputeChallenge(db: Database, user: SessionUser, id: string, reasonInput: unknown) {
  const reason = v.clean(reasonInput, 600);
  if (reason.length < 5) fail("invalid_input");
  await db.tx(async (q) => {
    const c = await lock(q, id);
    if (!isSide(c, user.id)) fail("forbidden");
    if (c.status !== "reported") fail("challenge_closed");
    if (c.reported_by === user.id) fail("own_result");
    await q.query("update challenges set status = 'disputed', resolution = $2 where id = $1", [c.id, reason]);
    const staff = await q.query<{ user_id: string }>("select user_id from user_roles where role in ('admin','support','referee')");
    await notify(q, staff.map((s) => s.user_id), "challenge_disputed", { challengeId: c.id });
    await audit(q, { actorId: user.id, action: "challenge.disputed", entity: "challenge", entityId: c.id });
  });
}

/** Platform staff decide a disputed challenge: pick the winner, or void it. */
export async function resolveChallenge(db: Database, user: SessionUser, id: string, winnerInput: unknown, noteInput: unknown) {
  if (!isStaff(user) && !user.roles.includes("referee")) fail("forbidden");
  const note = v.clean(noteInput, 600);
  if (note.length < 5) fail("invalid_input");
  await db.tx(async (q) => {
    const c = await lock(q, id);
    if (c.status !== "disputed") fail("challenge_closed");
    await q.query("update challenges set resolution = $2, resolved_by = $3 where id = $1", [c.id, note, user.id]);
    if (winnerInput === "void") {
      await q.query("update challenges set status = 'cancelled' where id = $1", [c.id]);
      await notify(q, [c.challenger_id, c.opponent_id], "challenge_cancelled", { challengeId: c.id, by: user.username });
    } else {
      const winner = winnerInput === c.challenger_id || winnerInput === c.opponent_id ? String(winnerInput) : fail("invalid_input");
      await finish(q, c, winner);
    }
    await audit(q, { actorId: user.id, action: "challenge.resolved", entity: "challenge", entityId: c.id, data: { winner: winnerInput, note } });
  });
}

/**
 * Quick Match: pairs the player with the longest-waiting real player for the same game, or queues them.
 * Matching per game is serialised with an advisory lock, so two simultaneous joins pair with each other
 * instead of both waiting.
 */
export async function joinQuickMatch(db: Database, user: SessionUser, gameInput: unknown): Promise<{ matched: string | null }> {
  if (!isGame(gameInput)) fail("invalid_game");
  const game = gameInput as string;
  return db.tx(async (q) => {
    await q.query("select pg_advisory_xact_lock(hashtext($1))", [`quick:${game}`]);
    await expireStale(q);
    const [queued] = await q.query("select 1 from quick_queue where user_id = $1", [user.id]);
    if (queued) fail("already_queued");
    const waiting = await q.query<{ user_id: string }>(
      `select qq.user_id from quick_queue qq join users u on u.id = qq.user_id and u.status = 'active'
        where qq.game = $1 and qq.user_id <> $2
          and not exists (select 1 from challenges c where c.game = $1 and c.status in ('pending','accepted','reported','disputed')
                            and least(c.challenger_id, c.opponent_id) = least(qq.user_id, $2::uuid)
                            and greatest(c.challenger_id, c.opponent_id) = greatest(qq.user_id, $2::uuid))
        order by qq.joined_at asc limit 1 for update of qq`,
      [game, user.id],
    );
    if (!waiting.length) {
      await q.query("insert into quick_queue (user_id, game, expires_at) values ($1, $2, now() + ($3 || ' minutes')::interval)", [user.id, game, String(QUEUE_MINUTES)]);
      await audit(q, { actorId: user.id, action: "quick_match.queued", entity: "user", entityId: user.id, data: { game } });
      return { matched: null };
    }
    const opponent = waiting[0].user_id;
    await q.query("delete from quick_queue where user_id = $1", [opponent]);
    const [row] = await q.query<{ id: string }>(
      `insert into challenges (kind, game, challenger_id, opponent_id, status, responded_at, expires_at)
       values ('quick', $1, $2, $3, 'accepted', now(), now() + ($4 || ' hours')::interval) returning id`,
      [game, opponent, user.id, String(QUICK_MATCH_HOURS)],
    );
    await notify(q, [opponent, user.id], "quick_match_found", { challengeId: row.id, game });
    await audit(q, { actorId: user.id, action: "quick_match.matched", entity: "challenge", entityId: row.id, data: { game, opponent } });
    return { matched: row.id };
  });
}

export async function leaveQuickMatch(db: Database, user: SessionUser) {
  await db.query("delete from quick_queue where user_id = $1", [user.id]);
}

export async function challengesFor(q: Queryable, userId: string) {
  await expireStale(q);
  return q.query<{
    id: string; kind: string; game: string; status: string; message: string; challenger: string; opponent: string;
    challenger_id: string; opponent_id: string; challenger_name: string; opponent_name: string; reported_by: string | null;
    reported_winner: string | null; winner_id: string | null; score_challenger: number | null; score_opponent: number | null;
    evidence_url: string; resolution: string; expires_at: Date; created_at: Date; completed_at: Date | null;
  }>(
    `select c.*, uc.username as challenger, uo.username as opponent, uc.display_name as challenger_name, uo.display_name as opponent_name
       from challenges c join users uc on uc.id = c.challenger_id join users uo on uo.id = c.opponent_id
      where c.challenger_id = $1 or c.opponent_id = $1
      order by case when c.status in ('pending','accepted','reported','disputed') then 0 else 1 end, c.created_at desc limit 60`,
    [userId],
  );
}

export async function queueState(q: Queryable, userId: string) {
  const [mine] = await q.query<{ game: string; joined_at: Date; expires_at: Date }>(
    "select game, joined_at, expires_at from quick_queue where user_id = $1 and expires_at > now()",
    [userId],
  );
  const waiting = await q.query<{ game: string; n: number }>("select game, count(*)::int as n from quick_queue where expires_at > now() group by game");
  return { mine: mine ?? null, waiting: Object.fromEntries(waiting.map((w) => [w.game, w.n])) as Record<string, number> };
}

export async function disputedChallenges(q: Queryable) {
  return q.query<{ id: string; game: string; challenger_id: string; opponent_id: string; challenger: string; opponent: string; resolution: string; reported_winner: string | null; created_at: Date }>(
    `select c.id, c.game, c.challenger_id, c.opponent_id, uc.username as challenger, uo.username as opponent, c.resolution, c.reported_winner, c.created_at
       from challenges c join users uc on uc.id = c.challenger_id join users uo on uo.id = c.opponent_id
      where c.status = 'disputed' order by c.created_at asc`,
  );
}
