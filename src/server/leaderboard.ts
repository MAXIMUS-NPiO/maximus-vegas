/**
 * Leaderboard tournaments: participants play in their own time and log per-match stats. Points use the
 * tournament's weights; best-of-N counts only the top lines; implausible lines wait for an organiser.
 * The review flags are an integrity check, not anti-cheat, and are never presented as one.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { flagReasons, INPUT_LIMITS, mergeWeights, standings, STATS, type Standing, type StatLine } from "./scoring.ts";
import { canRefereeTournament, lockTournament, regLeaders, regMembers, settleTournament, type TournamentRow } from "./tournaments.ts";
import { grantXp, XP } from "./progression.ts";
import * as v from "./validate.ts";

export const MAX_ENTRIES_PER_PARTICIPANT = 100;
export const XP_ENTRY_CAP = 10;

export type ScoreInput = Partial<Record<(typeof STATS)[number], unknown>> & {
  placement?: unknown;
  matchRef?: unknown;
  evidenceUrl?: unknown;
  registration?: unknown;
};

function parseLine(input: ScoreInput): StatLine {
  const line = {} as StatLine;
  for (const stat of STATS) line[stat] = v.intIn(input[stat] ?? 0, 0, INPUT_LIMITS[stat]);
  const p = String(input.placement ?? "").trim();
  line.placement = p === "1" ? 1 : p === "2" ? 2 : p === "3" ? 3 : p === "" || p === "0" ? null : fail("invalid_input");
  return line;
}

async function staffOf(q: Queryable, t: { id: string; org_id: string }) {
  const rows = await q.query<{ user_id: string }>(
    "select user_id from org_members where org_id = $1 union select user_id from tournament_organizers where tournament_id = $2",
    [t.org_id, t.id],
  );
  return rows.map((r) => r.user_id);
}

async function entryXp(q: Queryable, t: TournamentRow, entryId: string, registrationId: string) {
  const members = await regMembers(q, registrationId);
  for (const userId of members) {
    const [n] = await q.query<{ n: number }>(
      "select count(*)::int as n from xp_events where user_id = $1 and reason = 'leaderboard_entry' and ref = $2",
      [userId, t.id],
    );
    if ((n?.n ?? 0) >= XP_ENTRY_CAP) continue;
    await grantXp(q, [userId], XP.leaderboardEntry, "leaderboard_entry", t.game, t.id, `score:${entryId}`);
  }
}

/** Self-service (a participant's leader) or organiser-logged result line. */
export async function submitScore(db: Database, user: SessionUser, tournamentId: string, input: ScoreInput, asOrganizer = false) {
  const line = parseLine(input);
  const matchRef = v.oneLine(input.matchRef, 80);
  const evidence = v.optionalUrl(input.evidenceUrl);
  return db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    if (t.format !== "leaderboard") fail("wrong_format");
    if (t.status !== "IN_PROGRESS") fail("tournament_not_live");
    let registrationId: string;
    if (asOrganizer) {
      if (!(await canRefereeTournament(q, t, user))) fail("forbidden");
      const [reg] = await q.query<{ id: string }>(
        "select id from registrations where id = $1 and tournament_id = $2 and status = 'registered'",
        [String(input.registration ?? ""), t.id],
      );
      if (!reg) fail("not_found");
      registrationId = reg.id;
    } else {
      if (t.submission_deadline && new Date(t.submission_deadline).getTime() < Date.now()) fail("submission_closed");
      const [reg] = await q.query<{ id: string }>(
        `select r.id from registrations r left join teams tm on tm.id = r.team_id
          where r.tournament_id = $1 and r.status = 'registered' and (r.user_id = $2 or tm.owner_id = $2 or tm.captain_id = $2)`,
        [t.id, user.id],
      );
      if (!reg) fail("not_participant");
      registrationId = reg.id;
    }
    const [count] = await q.query<{ n: number }>("select count(*)::int as n from score_entries where registration_id = $1", [registrationId]);
    if ((count?.n ?? 0) >= MAX_ENTRIES_PER_PARTICIPANT) fail("too_many_entries");
    const flags = flagReasons(line);
    const review = flags.length ? "pending" : "accepted";
    let id: string;
    try {
      const [row] = await q.query<{ id: string }>(
        `insert into score_entries (tournament_id, registration_id, submitted_by, source, kills, assists, deaths, headshots, damage, distance,
           placement, match_ref, evidence_url, flags, review)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
        [t.id, registrationId, user.id, asOrganizer ? "organizer" : "participant", line.kills, line.assists, line.deaths, line.headshots,
          line.damage, line.distance, line.placement, matchRef, evidence, flags, review],
      );
      id = row.id;
    } catch (error) {
      if (isUniqueViolation(error)) fail("duplicate_entry");
      throw error;
    }
    if (review === "accepted") await entryXp(q, t, id, registrationId);
    else await notify(q, await staffOf(q, t), "score_flagged", { tournament: t.name, slug: t.slug });
    await audit(q, {
      actorId: user.id,
      action: asOrganizer ? "score.logged_by_organizer" : "score.submitted",
      entity: "tournament",
      entityId: t.id,
      data: { entryId: id, registrationId, flags, review },
    });
    return { id, review, flags };
  });
}

/** Organiser decision on a line: approve a flagged line, or reject any line with a reason. */
export async function reviewScore(db: Database, user: SessionUser, entryId: string, decisionInput: unknown, noteInput: unknown) {
  const decision = decisionInput === "approve" ? "approved" : decisionInput === "reject" ? "rejected" : fail("invalid_input");
  const note = v.clean(noteInput, 500);
  await db.tx(async (q) => {
    const [entry] = await q.query<{ id: string; tournament_id: string; registration_id: string; review: string }>(
      "select id, tournament_id, registration_id, review from score_entries where id = $1 for update",
      [entryId],
    );
    if (!entry) fail("not_found");
    const t = await lockTournament(q, entry.tournament_id);
    if (!(await canRefereeTournament(q, t, user))) fail("forbidden");
    if (!["IN_PROGRESS", "PAUSED"].includes(t.status)) fail("tournament_not_live");
    if (decision === "approved" && entry.review !== "pending") fail("not_editable");
    if (decision === "rejected" && !["pending", "accepted", "approved"].includes(entry.review)) fail("not_editable");
    if (decision === "rejected" && entry.review !== "pending" && note.length < 5) fail("invalid_input");
    await q.query("update score_entries set review = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 where id = $1", [
      entry.id,
      decision,
      user.id,
      note,
    ]);
    if (decision === "approved") await entryXp(q, t, entry.id, entry.registration_id);
    await notify(q, await regLeaders(q, entry.registration_id), decision === "approved" ? "score_approved" : "score_rejected", {
      tournament: t.name,
      slug: t.slug,
    });
    await audit(q, { actorId: user.id, action: `score.${decision}`, entity: "tournament", entityId: t.id, data: { entryId: entry.id, note } });
  });
}

export type NamedStanding = Standing & { name: string; team_slug: string | null; username: string | null };

export async function leaderboardStandings(q: Queryable, t: { id: string; scoring: unknown; best_of: number | null }): Promise<NamedStanding[]> {
  const regs = await q.query<{ id: string; name: string; team_slug: string | null; username: string | null }>(
    `select r.id, coalesce(tm.name, u.display_name) as name, tm.slug as team_slug, u.username
       from registrations r left join teams tm on tm.id = r.team_id left join users u on u.id = r.user_id
      where r.tournament_id = $1 and r.status in ('registered','disqualified')`,
    [t.id],
  );
  const lines = await q.query<StatLine & { registration_id: string; review: string }>(
    `select registration_id, kills, assists, deaths, headshots, damage, distance, placement, review
       from score_entries where tournament_id = $1`,
    [t.id],
  );
  const names = new Map(regs.map((r) => [r.id, r]));
  const rows = standings(
    regs.map((r) => r.id),
    lines.map((l) => ({
      participantId: l.registration_id,
      kills: l.kills,
      assists: l.assists,
      deaths: l.deaths,
      headshots: l.headshots,
      damage: l.damage,
      distance: l.distance,
      placement: (l.placement as 1 | 2 | 3 | null) ?? null,
      accepted: l.review === "accepted" || l.review === "approved",
      pending: l.review === "pending",
    })),
    mergeWeights(t.scoring),
    t.best_of,
  );
  return rows.map((s) => ({ ...s, name: names.get(s.participantId)?.name ?? "—", team_slug: names.get(s.participantId)?.team_slug ?? null, username: names.get(s.participantId)?.username ?? null }));
}

/** Completion: blocked while any line awaits review; placements follow the standings. */
export async function completeLeaderboard(q: Queryable, t: TournamentRow, actorId: string) {
  const [pending] = await q.query<{ n: number }>("select count(*)::int as n from score_entries where tournament_id = $1 and review = 'pending'", [t.id]);
  if ((pending?.n ?? 0) > 0) fail("pending_reviews");
  const rows = await leaderboardStandings(q, t);
  await q.query("update registrations set placement = null where tournament_id = $1", [t.id]);
  const [dq] = await q.query<{ ids: string[] }>("select coalesce(array_agg(id), '{}') as ids from registrations where tournament_id = $1 and status = 'disqualified'", [t.id]);
  const excluded = new Set(dq?.ids ?? []);
  const ranked = rows.filter((r) => r.counted > 0 && !excluded.has(r.participantId));
  let place = 0;
  ranked.forEach((r, i) => {
    const prev = ranked[i - 1];
    place = prev && prev.points === r.points && prev.kda === r.kda && prev.kills === r.kills ? place : i + 1;
    (r as NamedStanding & { place: number }).place = place;
  });
  for (const r of ranked as Array<NamedStanding & { place: number }>)
    await q.query("update registrations set placement = $2 where id = $1", [r.participantId, r.place]);
  const [done] = await q.query<{ name: string; slug: string }>(
    "update tournaments set status = 'COMPLETED', completed_at = now(), updated_at = now() where id = $1 returning name, slug",
    [t.id],
  );
  await settleTournament(q, t.id);
  const members = await q.query<{ user_id: string }>(
    "select re.user_id from roster_entries re join registrations r on r.id = re.registration_id where r.tournament_id = $1 and r.status = 'registered'",
    [t.id],
  );
  await notify(q, members.map((m) => m.user_id), "tournament_completed", { tournament: done?.name, slug: done?.slug });
  await audit(q, { actorId, action: "tournament.completed", entity: "tournament", entityId: t.id, data: { format: "leaderboard" } });
}

export async function scoreLog(q: Queryable, tournamentId: string, opts: { registrationId?: string; pendingOnly?: boolean } = {}) {
  return q.query<
    StatLine & {
      id: string; registration_id: string; name: string; source: string; match_ref: string; evidence_url: string; flags: string[];
      review: string; review_note: string; created_at: Date; submitted_by: string;
    }
  >(
    `select e.id, e.registration_id, coalesce(tm.name, u.display_name) as name, e.source, e.kills, e.assists, e.deaths, e.headshots,
            e.damage, e.distance, e.placement, e.match_ref, e.evidence_url, e.flags, e.review, e.review_note, e.created_at,
            su.username as submitted_by
       from score_entries e join registrations r on r.id = e.registration_id
       left join teams tm on tm.id = r.team_id left join users u on u.id = r.user_id
       join users su on su.id = e.submitted_by
      where e.tournament_id = $1 and ($2::uuid is null or e.registration_id = $2) and (not $3 or e.review = 'pending')
      order by e.created_at desc limit 500`,
    [tournamentId, opts.registrationId ?? null, Boolean(opts.pendingOnly)],
  );
}
