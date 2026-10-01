/**
 * Scouting over public profiles: search by game, country, quick-match rating, open looking-for-team posts,
 * recent activity and name; a player's saved filters and watchlist. Only profiles their owners made public
 * are searched, watched or listed; a watched player is not told who watches them, and a profile that turns
 * private leaves every watchlist view at once.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { isGame } from "../lib/games.ts";
import { isCountry } from "../lib/countries.ts";
import * as v from "./validate.ts";

export const MAX_FILTERS = 20;
export const MAX_WATCH = 200;
export const ACTIVE_DAYS = [7, 30, 90] as const;
export const RATING_BOUNDS = [100, 5000] as const;
export const SCOUT_LIMIT = 40;

export type ScoutQuery = {
  game: string;
  country: string;
  minRating: number | null;
  maxRating: number | null;
  lft: boolean;
  activeDays: number | null;
  text: string;
};

const ratingOf = (x: unknown): number | null => {
  const s = String(x ?? "").trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= RATING_BOUNDS[0] && n <= RATING_BOUNDS[1] ? n : null;
};

/** Reads a scouting query from form or URL fields; anything unknown is dropped, never an error. */
export function parseScoutQuery(input: Record<string, unknown>): ScoutQuery {
  const game = isGame(input.game) ? String(input.game) : "";
  const country = typeof input.country === "string" && isCountry(input.country.toUpperCase()) ? input.country.toUpperCase() : "";
  let minRating = ratingOf(input.minRating);
  let maxRating = ratingOf(input.maxRating);
  if (minRating !== null && maxRating !== null && minRating > maxRating) [minRating, maxRating] = [maxRating, minRating];
  const lft = input.lft === true || input.lft === "1" || input.lft === "on";
  const days = Number(input.activeDays);
  const activeDays = (ACTIVE_DAYS as readonly number[]).includes(days) ? days : null;
  const text = v.oneLine(input.text, 40);
  return { game, country, minRating, maxRating, lft, activeDays, text };
}

/** URL fields for a query (empty values left out), for links and saved filters. */
export function scoutParams(q: ScoutQuery): Record<string, string> {
  const out: Record<string, string> = {};
  if (q.game) out.game = q.game;
  if (q.country) out.country = q.country;
  if (q.minRating !== null) out.minRating = String(q.minRating);
  if (q.maxRating !== null) out.maxRating = String(q.maxRating);
  if (q.lft) out.lft = "1";
  if (q.activeDays !== null) out.activeDays = String(q.activeDays);
  if (q.text) out.text = q.text;
  return out;
}

export const isEmptyQuery = (q: ScoutQuery) => Object.keys(scoutParams(q)).length === 0;

export type ScoutRow = {
  id: string;
  username: string;
  display_name: string;
  country_code: string | null;
  rating: number | null;
  matches: number;
  wins: number;
  losses: number;
  lft: boolean;
  lft_roles: string | null;
  last_active: Date | null;
  tournaments: number;
  watched: boolean;
};

const LAST_ACTIVE = `greatest(
  (select max(m.completed_at) from matches m join roster_entries re on re.registration_id in (m.a_reg, m.b_reg)
    where re.user_id = u.id and m.status = 'completed'),
  (select max(c.completed_at) from challenges c
    where c.status = 'completed' and (c.challenger_id = u.id or c.opponent_id = u.id
      or exists (select 1 from challenge_members cm where cm.challenge_id = c.id and cm.user_id = u.id))))`;

/**
 * Public profiles matching the query. "Plays the game" means a rated quick match, a team, a tournament roster
 * or an open finder post in that game. The rating range applies when a game is chosen (ratings are per game).
 */
export async function scoutPlayers(q: Queryable, viewerId: string | null, query: ScoutQuery, limit = SCOUT_LIMIT): Promise<ScoutRow[]> {
  // LIKE wildcards in the typed text are matched literally (usernames contain "_").
  const like = query.text ? `%${query.text.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%` : "";
  return q.query<ScoutRow>(
    `select * from (
       select u.id, u.username, u.display_name, u.country_code,
              r.rating, coalesce(r.matches, 0) as matches, coalesce(r.wins, 0) as wins, coalesce(r.losses, 0) as losses,
              lft.roles is not null as lft, lft.roles as lft_roles,
              ${LAST_ACTIVE} as last_active,
              (select count(distinct re.tournament_id)::int from roster_entries re where re.user_id = u.id) as tournaments,
              ($2::uuid is not null and exists (select 1 from scout_watch w where w.user_id = $2 and w.player_id = u.id)) as watched
         from users u
         left join ratings r on r.user_id = u.id and r.game = $1
         left join lateral (
           select fp.roles from finder_posts fp
            where fp.user_id = u.id and fp.kind = 'lft' and fp.status = 'open' and fp.expires_at > now() and ($1 = '' or fp.game = $1)
            order by fp.created_at desc limit 1) lft on true
        where u.status = 'active' and u.profile_public and ($2::uuid is null or u.id <> $2)
          and ($1 = '' or (r.matches > 0
               or exists (select 1 from team_members tm join teams t on t.id = tm.team_id where tm.user_id = u.id and t.game = $1)
               or exists (select 1 from roster_entries re join tournaments t on t.id = re.tournament_id where re.user_id = u.id and t.game = $1)
               or exists (select 1 from finder_posts fp where fp.user_id = u.id and fp.game = $1 and fp.status = 'open' and fp.expires_at > now())))
          and ($3 = '' or u.country_code = $3)
          and ($1 = '' or $4::int is null or coalesce(r.rating, 1000) >= $4)
          and ($1 = '' or $5::int is null or coalesce(r.rating, 1000) <= $5)
          and ($6 = '' or lower(u.username) like $6 escape '\\' or lower(u.display_name) like $6 escape '\\')
     ) x
     where (not $7 or x.lft) and ($8::int is null or x.last_active > now() - make_interval(days => $8::int))
     order by x.rating desc nulls last, x.last_active desc nulls last, x.username
     limit $9`,
    [query.game, viewerId, query.country, query.minRating, query.maxRating, like, query.lft, query.activeDays, limit],
  );
}

// ---------- Saved filters ----------

export type SavedFilter = { id: string; name: string; query: ScoutQuery; created_at: Date };

export async function myFilters(q: Queryable, userId: string): Promise<SavedFilter[]> {
  const rows = await q.query<{ id: string; name: string; query: Record<string, unknown>; created_at: Date }>(
    "select id, name, query, created_at from scout_filters where user_id = $1 order by lower(name)",
    [userId],
  );
  // A stored filter is re-read with today's rules: a game or country that left the lists drops out.
  return rows.map((r) => ({ id: r.id, name: r.name, query: parseScoutQuery(r.query), created_at: r.created_at }));
}

/** Saves the query under a name (the same name replaces the earlier query); up to 20 per player. */
export async function saveFilter(db: Database, user: SessionUser, nameInput: unknown, fields: Record<string, unknown>): Promise<{ id: string; replaced: boolean }> {
  const name = v.oneLine(nameInput, 60);
  if (name.length < 2) fail("invalid_input");
  const query = parseScoutQuery(fields);
  if (isEmptyQuery(query)) fail("invalid_input");
  return db.tx(async (q) => {
    await q.query("select pg_advisory_xact_lock(hashtext($1))", [`scout:${user.id}`]);
    const [same] = await q.query<{ id: string }>("select id from scout_filters where user_id = $1 and lower(name) = lower($2)", [user.id, name]);
    if (same) {
      await q.query("update scout_filters set query = $2, name = $3 where id = $1", [same.id, JSON.stringify(scoutParams(query)), name]);
      return { id: same.id, replaced: true };
    }
    const [count] = await q.query<{ n: number }>("select count(*)::int as n from scout_filters where user_id = $1", [user.id]);
    if ((count?.n ?? 0) >= MAX_FILTERS) fail("filter_limit");
    const [row] = await q.query<{ id: string }>("insert into scout_filters (user_id, name, query) values ($1, $2, $3) returning id", [user.id, name, JSON.stringify(scoutParams(query))]);
    return { id: row.id, replaced: false };
  });
}

export async function deleteFilter(db: Database, user: SessionUser, id: unknown): Promise<{ changed: boolean }> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) fail("not_found");
  const rows = await db.query("delete from scout_filters where id = $1 and user_id = $2 returning id", [id, user.id]);
  return { changed: rows.length > 0 };
}

// ---------- Watchlist ----------

/** Adds a public profile to the watchlist (or updates its note); up to 200 players. */
export async function watchPlayer(db: Database, user: SessionUser, usernameInput: unknown, noteInput: unknown): Promise<{ created: boolean }> {
  const username = v.username(usernameInput);
  // The note field is present only in the note form: an empty value there clears the note.
  const noteGiven = noteInput !== undefined && noteInput !== null;
  const note = v.oneLine(noteInput, 200);
  return db.tx(async (q) => {
    const [player] = await q.query<{ id: string }>("select id from users where username = $1 and status = 'active' and profile_public", [username]);
    if (!player || player.id === user.id) fail("not_found");
    await q.query("select pg_advisory_xact_lock(hashtext($1))", [`scout:${user.id}`]);
    const [existing] = await q.query("select 1 from scout_watch where user_id = $1 and player_id = $2", [user.id, player.id]);
    if (existing) {
      if (noteGiven) await q.query("update scout_watch set note = $3 where user_id = $1 and player_id = $2", [user.id, player.id, note]);
      return { created: false };
    }
    const [count] = await q.query<{ n: number }>("select count(*)::int as n from scout_watch where user_id = $1", [user.id]);
    if ((count?.n ?? 0) >= MAX_WATCH) fail("watch_limit");
    try {
      await q.query("insert into scout_watch (user_id, player_id, note) values ($1, $2, $3)", [user.id, player.id, note]);
    } catch (error) {
      if (isUniqueViolation(error)) return { created: false };
      throw error;
    }
    await audit(q, { actorId: user.id, action: "scout.watched", entity: "user", entityId: user.id, data: { player: player.id } });
    return { created: true };
  });
}

export async function unwatchPlayer(db: Database, user: SessionUser, usernameInput: unknown): Promise<{ changed: boolean }> {
  const username = v.username(usernameInput);
  const rows = await db.query("delete from scout_watch w using users u where u.id = w.player_id and u.username = $1 and w.user_id = $2 returning w.player_id", [username, user.id]);
  return { changed: rows.length > 0 };
}

export type WatchRow = {
  username: string;
  display_name: string;
  country_code: string | null;
  best_rating: number | null;
  best_game: string | null;
  matches: number;
  lft_games: string[];
  last_active: Date | null;
  note: string;
  created_at: Date;
};

/** The watchlist with each player's current public data; private or inactive profiles are left out. */
export async function watchlist(q: Queryable, userId: string): Promise<WatchRow[]> {
  return q.query<WatchRow>(
    `select u.username, u.display_name, u.country_code,
            (select r.rating from ratings r where r.user_id = u.id and r.matches > 0 order by r.rating desc limit 1) as best_rating,
            (select r.game from ratings r where r.user_id = u.id and r.matches > 0 order by r.rating desc limit 1) as best_game,
            coalesce((select sum(r.matches)::int from ratings r where r.user_id = u.id), 0) as matches,
            array(select distinct fp.game from finder_posts fp where fp.user_id = u.id and fp.kind = 'lft' and fp.status = 'open' and fp.expires_at > now()) as lft_games,
            ${LAST_ACTIVE} as last_active,
            w.note, w.created_at
       from scout_watch w join users u on u.id = w.player_id
      where w.user_id = $1 and u.status = 'active' and u.profile_public
      order by w.created_at desc`,
    [userId],
  );
}
