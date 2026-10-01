/**
 * MV-MEDIA-1: broadcasts and recordings of events and matches.
 *
 * Managers of a tournament assign a stream or a recording to the whole event or to one match, after
 * confirming that they hold the rights to broadcast the game and to show the participants; the players
 * of a streamed match are told. Links are https only; Twitch channels and YouTube videos play on the
 * portal after the viewer clicks, nothing from the platform loads before that. The portal has no data on
 * audiences, so it shows no viewer counts. Overlay data comes from the match record only: the official
 * score once confirmed, a reported score marked as reported, nothing invented in between.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { canStaff, notify } from "./access.ts";
import { lockTournament, regMembers, requireManager } from "./tournaments.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import * as v from "./validate.ts";
import { parseStreamUrl, type Platform } from "../lib/streams.ts";
import { getMatch } from "./queries.ts";
import { depthKey, seriesOf, seriesRulesOf } from "./series.ts";
import { settingsOf } from "./format-settings.ts";

export const STREAM_LIMIT = 30;
export const STREAM_KINDS = ["live", "vod"] as const;
export type StreamKind = (typeof STREAM_KINDS)[number];
export const STREAM_LANGUAGES = ["ru", "en", "other"] as const;
/** Statuses in which a tournament and its streams are public. */
const PUBLIC = ["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED", "IN_PROGRESS", "PAUSED", "COMPLETED"];

const isId = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x);

export type Stream = {
  id: string;
  tournament_id: string;
  match_id: string | null;
  kind: StreamKind;
  platform: Platform;
  url: string;
  title: string;
  language: string;
  starts_at: Date | null;
  created_at: Date;
  rights_by: string;
  match_round: number | null;
  match_bracket: string | null;
  match_stage: number | null;
  match_group: number | null;
  match_status: string | null;
  match_scheduled_at: Date | null;
  a_name: string | null;
  b_name: string | null;
};

const COLUMNS = `s.id, s.tournament_id, s.match_id, s.kind, s.platform, s.url, s.title, s.language, s.starts_at, s.created_at,
       u.username as rights_by, m.round as match_round, m.bracket as match_bracket, m.stage as match_stage, m.group_no as match_group,
       m.status as match_status, m.scheduled_at as match_scheduled_at,
       coalesce(ta.name, ua.display_name) as a_name, coalesce(tb.name, ub.display_name) as b_name`;
const JOINS = `from streams s join users u on u.id = s.rights_confirmed_by
  left join matches m on m.id = s.match_id
  left join registrations ra on ra.id = m.a_reg left join teams ta on ta.id = ra.team_id left join users ua on ua.id = ra.user_id
  left join registrations rb on rb.id = m.b_reg left join teams tb on tb.id = rb.team_id left join users ub on ub.id = rb.user_id`;
const SELECT = `select ${COLUMNS} ${JOINS}`;

export type StreamInput = { url: unknown; title: unknown; kind: unknown; match: unknown; language: unknown; startsAt: unknown; tz: unknown; rights: unknown };

export async function addStream(db: Database, user: SessionUser, tournamentId: unknown, input: StreamInput): Promise<{ id: string }> {
  if (!isId(tournamentId)) fail("not_found");
  const parsed = parseStreamUrl(input.url) ?? fail("stream_url");
  if (!v.bool(input.rights)) fail("stream_rights");
  const kind: StreamKind = input.kind === "vod" ? "vod" : "live";
  const title = v.oneLine(input.title, 80);
  const language = (STREAM_LANGUAGES as readonly string[]).includes(String(input.language)) ? String(input.language) : "";
  const startsAt = kind === "live" && v.oneLine(input.startsAt, 25) ? v.zonedToUtc(input.startsAt, input.tz) : null;
  const matchId = input.match ? (isId(input.match) ? input.match : fail("stream_match")) : null;
  return db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId as string);
    await requireManager(q, t, user);
    if (["CANCELLED", "ARCHIVED"].includes(t.status)) fail("not_editable");
    let match: { a_reg: string | null; b_reg: string | null } | null = null;
    if (matchId) {
      [match] = await q.query<{ a_reg: string | null; b_reg: string | null }>("select a_reg, b_reg from matches where id = $1 and tournament_id = $2", [matchId, t.id]);
      if (!match) fail("stream_match");
    }
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from streams where tournament_id = $1", [t.id]);
    if ((n?.n ?? 0) >= STREAM_LIMIT) fail("stream_limit");
    const [dup] = await q.query("select 1 from streams where tournament_id = $1 and match_id is not distinct from $2 and kind = $3 and url = $4", [
      t.id,
      matchId,
      kind,
      parsed.url,
    ]);
    if (dup) fail("stream_exists");
    let row: { id: string };
    try {
      [row] = await q.query<{ id: string }>(
        `insert into streams (tournament_id, match_id, kind, platform, url, title, language, starts_at, rights_confirmed_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
        [t.id, matchId, kind, parsed.platform, parsed.url, title, language, startsAt?.toISOString() ?? null, user.id],
      );
    } catch (error) {
      if (isUniqueViolation(error, "streams_unique")) fail("stream_exists");
      throw error;
    }
    // The players of a streamed match learn that it will be shown.
    if (match && kind === "live") {
      const players = [...(await regMembers(q, match.a_reg)), ...(await regMembers(q, match.b_reg))];
      await notify(q, players, "match_streamed", { matchId, tournament: t.name });
    }
    await audit(q, {
      actorId: user.id,
      action: "stream.added",
      entity: "tournament",
      entityId: t.id,
      data: { streamId: row.id, kind, platform: parsed.platform, url: parsed.url, matchId },
    });
    return row;
  });
}

/** The tournament's managers remove a link; portal moderation (fair-play section) may remove an unsuitable one. */
export async function removeStream(db: Database, user: SessionUser, streamId: unknown) {
  if (!isId(streamId)) fail("not_found");
  await db.tx(async (q) => {
    const [s] = await q.query<{ id: string; tournament_id: string; url: string; kind: string }>("select id, tournament_id, url, kind from streams where id = $1", [streamId]);
    if (!s) fail("not_found");
    const t = await lockTournament(q, s.tournament_id);
    if (!canStaff(user, "conduct")) await requireManager(q, t, user);
    await q.query("delete from streams where id = $1", [s.id]);
    await audit(q, { actorId: user.id, action: "stream.removed", entity: "tournament", entityId: t.id, data: { streamId: s.id, url: s.url, kind: s.kind } });
  });
}

/** Every stream and recording of a tournament, event-wide first, then by time. */
export async function tournamentStreams(q: Queryable, tournamentId: string): Promise<Stream[]> {
  return q.query<Stream>(`${SELECT} where s.tournament_id = $1 order by s.kind, (s.match_id is not null), coalesce(s.starts_at, m.scheduled_at, s.created_at)`, [
    tournamentId,
  ]);
}

/** A match's own streams and recordings, and the event-wide ones of its tournament. */
export async function matchStreams(q: Queryable, matchId: string, tournamentId: string) {
  const rows = await q.query<Stream>(`${SELECT} where s.tournament_id = $1 and (s.match_id = $2 or s.match_id is null) order by s.created_at`, [
    tournamentId,
    matchId,
  ]);
  return { match: rows.filter((r) => r.match_id === matchId), event: rows.filter((r) => r.match_id === null) };
}

export type MediaRow = Stream & { t_slug: string; t_name: string; t_game: string; t_status: string; t_starts_at: Date | null };

const MEDIA = `select t.slug as t_slug, t.name as t_name, t.game as t_game, t.status as t_status, t.starts_at as t_starts_at, ${COLUMNS}
  ${JOINS} join tournaments t on t.id = s.tournament_id`;

/**
 * The media centre: streams of events under way now, scheduled ones, and recordings — public tournaments
 * only. "Now" means the tournament (and the match, for a match stream) is under way on the portal; the
 * portal does not know whether the channel is on air.
 */
export async function mediaCentre(q: Queryable, game = "") {
  const gameFilter = game ? " and t.game = $2" : "";
  const args = (statuses: string[]) => (game ? [statuses, game] : [statuses]);
  const open = await q.query<MediaRow>(
    `${MEDIA} where s.kind = 'live' and t.status = any($1::text[])${gameFilter}
        and (s.match_id is null or m.status = any(array['pending','ready','in_progress','result_submitted','disputed']))
      order by coalesce(s.starts_at, m.scheduled_at, t.starts_at, s.created_at) limit 200`,
    args(PUBLIC.filter((x) => x !== "COMPLETED")),
  );
  const vods = await q.query<MediaRow>(`${MEDIA} where s.kind = 'vod' and t.status = any($1::text[])${gameFilter} order by s.created_at desc limit 30`, args(PUBLIC));
  // Under way: the tournament runs, the stream's own start (if set) is within 30 minutes, and a match stream's
  // match is being played or ready and due. Everything else open is scheduled.
  const soon = Date.now() + 30 * 60_000;
  const due = (at: Date | null) => !at || new Date(at).getTime() <= soon;
  const live: MediaRow[] = [];
  const upcoming: MediaRow[] = [];
  for (const r of open) {
    let now = (r.t_status === "IN_PROGRESS" || r.t_status === "PAUSED") && due(r.starts_at);
    if (now && r.match_id) {
      const status = r.match_status ?? "";
      now = ["in_progress", "result_submitted", "disputed"].includes(status) || (status === "ready" && due(r.match_scheduled_at));
    }
    (now ? live : upcoming).push(r);
  }
  return { live, upcoming: upcoming.slice(0, 30), vods };
}

/** Whether a tournament status is public (its streams and overlays can be shown). */
export const isPublicStatus = (status: string) => PUBLIC.includes(status);

/** Matches a stream can be assigned to, with the sides' names, in bracket order. */
export async function streamableMatches(q: Queryable, tournamentId: string) {
  return q.query<{ id: string; round: number; bracket: string | null; stage: number | null; status: string; a_name: string | null; b_name: string | null }>(
    `select m.id, m.round, m.bracket, m.stage, m.status,
            coalesce(ta.name, ua.display_name) as a_name, coalesce(tb.name, ub.display_name) as b_name
       from matches m
       left join registrations ra on ra.id = m.a_reg left join teams ta on ta.id = ra.team_id left join users ua on ua.id = ra.user_id
       left join registrations rb on rb.id = m.b_reg left join teams tb on tb.id = rb.team_id left join users ub on ub.id = rb.user_id
      where m.tournament_id = $1 and m.status <> 'cancelled'
      order by m.stage nulls first, m.bracket, m.round, m.position limit 300`,
    [tournamentId],
  );
}

export type OverlayScore = { a: number | null; b: number | null; state: "official" | "reported" | "none" };

/**
 * Data for a broadcast overlay of a public match, from the match record only: the official score once the
 * result is confirmed, the submitted one marked "reported" while it waits, nothing otherwise.
 */
export async function overlayData(q: Queryable, matchId: string) {
  const data = await getMatch(q, matchId);
  if (!data || !isPublicStatus(data.match.t_status)) return null;
  const { match: m, a, b, results } = data;
  const pending = results.find((r) => r.status === "pending");
  const score: OverlayScore =
    m.status === "completed" && m.score_a !== null && m.score_b !== null
      ? { a: m.score_a, b: m.score_b, state: "official" }
      : pending && pending.score_a !== null && pending.score_b !== null
        ? { a: pending.score_a, b: pending.score_b, state: "reported" }
        : { a: null, b: null, state: "none" };
  const winner = m.winner_reg && m.status === "completed" ? (m.winner_reg === m.a_reg ? "a" : m.winner_reg === m.b_reg ? "b" : null) : null;
  const settings = settingsOf({ format: m.t_format, format_settings: m.t_settings });
  const series = seriesOf(
    seriesRulesOf({ series_rules: m.t_series }),
    m,
    { main: m.t_format, playoff: settings.playoff?.format ?? null },
    new Map([[depthKey(m.stage ?? 1, m.bracket ?? "W"), m.rounds]]),
  );
  return { match: m, a: a?.name ?? null, b: b?.name ?? null, score, winner: winner as "a" | "b" | null, bestOf: series.bestOf, playoffFormat: settings.playoff?.format ?? null };
}

