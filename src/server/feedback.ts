/**
 * Participants' feedback on a finished tournament: a rating from 1 to 5 and an optional comment. Only players
 * who were on an entry's roster at the end may rate, once per tournament, within 30 days of its completion;
 * a new rating replaces the previous one. The public sees the average and the count; comments are shown to
 * the tournament's organisers only. Templates show the ratings of the tournaments created from them.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { fail } from "./errors.ts";
import * as v from "./validate.ts";

export const FEEDBACK_DAYS = 30;

/** Whether this user may rate the tournament now. */
export async function canRate(q: Queryable, tournamentId: string, userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const [row] = await q.query<{ ok: boolean }>(
    `select exists (
       select 1 from tournaments t
         join registrations r on r.tournament_id = t.id and r.status in ('registered','disqualified')
         join roster_entries re on re.registration_id = r.id and re.user_id = $2
        where t.id = $1 and t.status in ('COMPLETED','ARCHIVED') and t.completed_at is not null
          and t.completed_at > now() - make_interval(days => $3)
     ) as ok`,
    [tournamentId, userId, FEEDBACK_DAYS],
  );
  return Boolean(row?.ok);
}

export async function rateTournament(db: Database, user: SessionUser, tournamentId: string, input: { rating?: unknown; comment?: unknown }) {
  const rating = v.intIn(input.rating, 1, 5);
  const comment = v.clean(input.comment, 500);
  await db.tx(async (q) => {
    if (!(await canRate(q, tournamentId, user.id))) fail("feedback_closed");
    await q.query(
      `insert into tournament_feedback (tournament_id, user_id, rating, comment) values ($1, $2, $3, $4)
       on conflict (tournament_id, user_id) do update set rating = excluded.rating, comment = excluded.comment, updated_at = now()`,
      [tournamentId, user.id, rating, comment],
    );
  });
}

export type FeedbackSummary = { average: number | null; count: number };

export async function feedbackSummary(q: Queryable, tournamentId: string): Promise<FeedbackSummary> {
  const [row] = await q.query<{ average: number | null; count: number }>(
    "select round(avg(rating)::numeric, 1)::float as average, count(*)::int as count from tournament_feedback where tournament_id = $1",
    [tournamentId],
  );
  return { average: row?.average ?? null, count: row?.count ?? 0 };
}

export async function ownFeedback(q: Queryable, tournamentId: string, userId: string | undefined) {
  if (!userId) return null;
  const [row] = await q.query<{ rating: number; comment: string }>("select rating, comment from tournament_feedback where tournament_id = $1 and user_id = $2", [
    tournamentId,
    userId,
  ]);
  return row ?? null;
}

/** Ratings with comments, newest first — for the tournament's organisers. */
export async function feedbackList(q: Queryable, tournamentId: string) {
  return q.query<{ rating: number; comment: string; username: string; updated_at: Date }>(
    `select f.rating, f.comment, u.username, f.updated_at from tournament_feedback f join users u on u.id = f.user_id
      where f.tournament_id = $1 order by f.updated_at desc limit 200`,
    [tournamentId],
  );
}
