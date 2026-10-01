/**
 * Quick-match rating per game (MV-RATING-1): applied once per completed quick match to every player of
 * both sides, with each change kept as a history row. Named 1v1 challenges are friendly and not rated.
 */
import type { Queryable } from "./db.ts";
import { RATING_START, ratingChanges, type RatedPlayer } from "./matchmaking-rules.ts";

type Side = "a" | "b";

/** The players of each side of a challenge: recorded members, or the two named players of an older match. */
export async function challengeSides(q: Queryable, c: { id: string; challenger_id: string; opponent_id: string }): Promise<{ userId: string; side: Side }[]> {
  const rows = await q.query<{ user_id: string; side: Side }>("select user_id, side from challenge_members where challenge_id = $1 order by side, user_id", [c.id]);
  if (rows.length) return rows.map((r) => ({ userId: r.user_id, side: r.side }));
  return [
    { userId: c.challenger_id, side: "a" },
    { userId: c.opponent_id, side: "b" },
  ];
}

/** Applies MV-RATING-1 for a completed quick match. Idempotent: a player is rated once per match. */
export async function applyQuickRating(q: Queryable, c: { id: string; game: string; challenger_id: string; opponent_id: string }, winnerId: string) {
  const sides = await challengeSides(q, c);
  const ids = sides.map((s) => s.userId).sort();
  const [done] = await q.query<{ n: number }>("select count(*)::int as n from rating_events where challenge_id = $1", [c.id]);
  if ((done?.n ?? 0) > 0) return [];
  for (const id of ids) await q.query("insert into ratings (user_id, game) select $1, $2 where exists (select 1 from users where id = $1 and status <> 'deleted') on conflict do nothing", [id, c.game]);
  // Row locks in a fixed order: two matches finishing at once never wait on each other in a cycle.
  const rows = await q.query<{ user_id: string; rating: number; matches: number }>(
    "select user_id, rating, matches from ratings where game = $1 and user_id = any($2::uuid[]) order by user_id for update",
    [c.game, ids],
  );
  const byId = new Map(rows.map((r) => [r.user_id, r]));
  const rated = (side: Side): RatedPlayer[] =>
    sides
      .filter((s) => s.side === side)
      .map((s) => ({ userId: s.userId, rating: byId.get(s.userId)?.rating ?? RATING_START, matches: byId.get(s.userId)?.matches ?? 0 }));
  const winnerSide: Side = winnerId === c.challenger_id ? "a" : "b";
  const changes = ratingChanges(rated("a"), rated("b"), winnerSide);
  // A deleted account keeps no rating: its row was erased with it and is not recreated.
  const gone = new Set(
    (await q.query<{ id: string }>("select id from users where id = any($1::uuid[]) and status = 'deleted'", [ids])).map((r) => r.id),
  );
  for (const ch of changes) {
    if (gone.has(ch.userId)) continue;
    const [inserted] = await q.query<{ id: string }>(
      `insert into rating_events (user_id, game, challenge_id, result, before, after, delta) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (user_id, challenge_id) do nothing returning id`,
      [ch.userId, c.game, c.id, ch.result, ch.before, ch.after, ch.delta],
    );
    if (!inserted) continue;
    await q.query(
      `update ratings set rating = $3, matches = matches + 1, wins = wins + $4, losses = losses + $5, peak = greatest(peak, $3), updated_at = now()
        where user_id = $1 and game = $2`,
      [ch.userId, c.game, ch.after, ch.result === "win" ? 1 : 0, ch.result === "loss" ? 1 : 0],
    );
  }
  return changes;
}

export type RatingRow = { game: string; rating: number; matches: number; wins: number; losses: number; peak: number; updated_at: Date };

/** A player's quick-match ratings, most played first. */
export async function ratingsFor(q: Queryable, userId: string): Promise<RatingRow[]> {
  return q.query<RatingRow>("select game, rating, matches, wins, losses, peak, updated_at from ratings where user_id = $1 and matches > 0 order by matches desc, game", [userId]);
}

export type RatingEvent = { game: string; result: "win" | "loss"; before: number; after: number; delta: number; created_at: Date; challenge_id: string };

/** The latest rating changes of a player, newest first, optionally for one game. */
export async function ratingHistory(q: Queryable, userId: string, game = "", limit = 30): Promise<RatingEvent[]> {
  return q.query<RatingEvent>(
    `select game, result, before, after, delta, created_at, challenge_id from rating_events
      where user_id = $1 and ($2::text = '' or game = $2) order by created_at desc, id desc limit $3`,
    [userId, game, limit],
  );
}
