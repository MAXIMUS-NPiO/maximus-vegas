import type { RegField } from "./registration.ts";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { canStaff } from "./access.ts";

const PUBLIC_STATUSES = ["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED", "IN_PROGRESS", "PAUSED", "COMPLETED"];

const REG_NAME = `coalesce(tm.name, u.display_name)`;

export type TournamentCard = {
  id: string;
  slug: string;
  name: string;
  game: string;
  status: string;
  participant_type: "solo" | "team";
  team_size: number;
  max_participants: number;
  starts_at: Date;
  region: string;
  org_name: string;
  org_slug: string;
  registered: number;
};

export async function listTournaments(
  db: Queryable,
  opts: { game?: string; filter?: "open" | "live" | "completed" | "upcoming" | "all"; limit?: number; orgId?: string } = {},
) {
  const where: string[] = ["t.status = any($1)"];
  let statuses = PUBLIC_STATUSES;
  if (opts.filter === "open") statuses = ["REGISTRATION_OPEN"];
  if (opts.filter === "live") statuses = ["IN_PROGRESS", "PAUSED"];
  if (opts.filter === "completed") statuses = ["COMPLETED"];
  if (opts.filter === "upcoming") statuses = ["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"];
  const params: unknown[] = [statuses];
  if (opts.game) {
    params.push(opts.game);
    where.push(`t.game = $${params.length}`);
  }
  if (opts.orgId) {
    params.push(opts.orgId);
    where.push(`t.org_id = $${params.length}`);
  }
  params.push(opts.limit ?? 60);
  return db.query<TournamentCard>(
    `select t.id, t.slug, t.name, t.game, t.status, t.participant_type, t.team_size, t.max_participants, t.starts_at, t.region,
            o.name as org_name, o.slug as org_slug,
            (select count(*)::int from registrations r where r.tournament_id = t.id and r.status = 'registered') as registered
       from tournaments t join organizations o on o.id = t.org_id
      where ${where.join(" and ")}
      order by case when t.status in ('IN_PROGRESS','PAUSED') then 0 when t.status = 'REGISTRATION_OPEN' then 1
                    when t.status in ('PUBLISHED','REGISTRATION_CLOSED') then 2 else 3 end,
               case when t.status = 'COMPLETED' then null else t.starts_at end asc nulls last,
               t.completed_at desc nulls last
      limit $${params.length}`,
    params,
  );
}

export type TournamentDetail = TournamentCard & {
  org_id: string;
  description: string;
  rules: string;
  check_in_required: boolean;
  check_in_open: boolean;
  started_at: Date | null;
  completed_at: Date | null;
  waitlisted: number;
  checked_in: number;
  format: "single_elimination" | "double_elimination" | "round_robin" | "swiss" | "groups" | "gauntlet" | "ffa" | "leaderboard";
  format_settings: unknown;
  /** 1 = main stage; 2 = playoff. */
  stage: number;
  registration_fields: RegField[] | null;
  approval_required: boolean;
  registration_closes_at: Date | null;
  roster_locks_at: Date | null;
  no_show_minutes: number | null;
  template_id: string | null;
  series_rules: unknown;
  admission: unknown;
  match_minutes: number | null;
  circuit_id: string | null;
  circuit_division: number | null;
  circuit_weight: number;
  qualifier_circuit_id: string | null;
  scoring: Record<string, number> | null;
  best_of: number | null;
  submission_hours: number | null;
  submission_deadline: Date | null;
  region_lock: string[];
  prize_coins: number;
  prize_text: string;
  livestream_url: string;
  banner_media_id: string | null;
  created_by: string;
};

export async function getTournament(db: Queryable, slug: string) {
  const [t] = await db.query<TournamentDetail>(
    `select t.*, o.name as org_name, o.slug as org_slug,
            (select count(*)::int from registrations r where r.tournament_id = t.id and r.status = 'registered') as registered,
            (select count(*)::int from registrations r where r.tournament_id = t.id and r.status = 'waitlisted') as waitlisted,
            (select count(*)::int from registrations r where r.tournament_id = t.id and r.status = 'registered' and r.checked_in_at is not null) as checked_in
       from tournaments t join organizations o on o.id = t.org_id where t.slug = $1`,
    [slug],
  );
  return t ?? null;
}

export type Participant = {
  id: string;
  name: string;
  status: string;
  seed: number | null;
  placement: number | null;
  checked_in_at: Date | null;
  created_at: Date;
  team_slug: string | null;
  username: string | null;
  roster: string[];
};

export async function participants(db: Queryable, tournamentId: string) {
  return db.query<Participant>(
    `select r.id, ${REG_NAME} as name, r.status, r.seed, r.placement, r.checked_in_at, r.created_at,
            tm.slug as team_slug, u.username,
            array(select uu.username from roster_entries re join users uu on uu.id = re.user_id
                   where re.registration_id = r.id order by uu.username) as roster
       from registrations r left join teams tm on tm.id = r.team_id left join users u on u.id = r.user_id
      where r.tournament_id = $1 and r.status <> 'withdrawn'
      order by r.placement asc nulls last, r.seed asc nulls last, r.created_at asc`,
    [tournamentId],
  );
}

export type BracketMatch = {
  id: string;
  bracket?: "W" | "L" | "GF" | "RR" | "SW" | "G";
  /** 1 = main stage (or the only stage); 2 = the playoff after it. */
  stage?: number;
  /** Group number in a groups stage; 0 elsewhere. */
  group_no?: number;
  a_void?: boolean;
  b_void?: boolean;
  round: number;
  position: number;
  status: string;
  outcome: string | null;
  a_reg: string | null;
  b_reg: string | null;
  a_name: string | null;
  b_name: string | null;
  winner_reg: string | null;
  score_a: number | null;
  score_b: number | null;
  scheduled_at: Date | null;
  series_override?: number | null;
  venue_id?: string | null;
  venue_name?: string | null;
};

export async function bracket(db: Queryable, tournamentId: string) {
  return db.query<BracketMatch>(
    `select m.id, m.bracket, m.stage, m.group_no, m.a_void, m.b_void, m.round, m.position, m.status, m.outcome, m.a_reg, m.b_reg, m.winner_reg,
            m.score_a, m.score_b, m.scheduled_at, m.series_override, m.venue_id, v.name as venue_name,
            coalesce(ta.name, ua.display_name) as a_name, coalesce(tb.name, ub.display_name) as b_name
       from matches m left join tournament_venues v on v.id = m.venue_id
       left join registrations ra on ra.id = m.a_reg left join teams ta on ta.id = ra.team_id left join users ua on ua.id = ra.user_id
       left join registrations rb on rb.id = m.b_reg left join teams tb on tb.id = rb.team_id left join users ub on ub.id = rb.user_id
      where m.tournament_id = $1 order by m.stage, m.group_no, array_position(array['W','L','GF','G'], m.bracket), m.round, m.position`,
    [tournamentId],
  );
}

export type Side = { reg: string; name: string; team_slug: string | null; username: string | null; roster: string[]; leaders: string[] };

async function side(db: Queryable, regId: string | null): Promise<Side | null> {
  if (!regId) return null;
  const [s] = await db.query<Side>(
    `select r.id as reg, ${REG_NAME} as name, tm.slug as team_slug, u.username,
            array(select uu.username from roster_entries re join users uu on uu.id = re.user_id where re.registration_id = r.id order by uu.username) as roster,
            array_remove(array[r.user_id, tm.owner_id, tm.captain_id], null)::text[] as leaders
       from registrations r left join teams tm on tm.id = r.team_id left join users u on u.id = r.user_id where r.id = $1`,
    [regId],
  );
  return s ?? null;
}

export async function getMatch(db: Queryable, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [m] = await db.query<
    BracketMatch & {
      tournament_id: string;
      room_code: string;
      next_match_id: string | null;
      completed_at: Date | null;
      t_slug: string;
      t_name: string;
      t_status: string;
      t_game: string;
      org_id: string;
      rounds: number;
      t_format: string;
      t_settings: unknown;
      t_stage: number;
      t_no_show: number | null;
      t_series: unknown;
      t_match_minutes: number | null;
      points_override: unknown;
      w_rounds: number;
      l_rounds: number;
      a_checked_in_at: Date | null;
      b_checked_in_at: Date | null;
      loser_next_match_id: string | null;
      paused_at: Date | null;
      pause_reason: string;
      t_map_pool: unknown;
    }
  >(
    `select m.*, t.slug as t_slug, t.name as t_name, t.status as t_status, t.game as t_game, t.org_id, t.format as t_format, t.format_settings as t_settings,
            t.stage as t_stage, t.no_show_minutes as t_no_show, t.series_rules as t_series, t.match_minutes as t_match_minutes, t.map_pool as t_map_pool,
            (select name from tournament_venues v where v.id = m.venue_id) as venue_name,
            (select max(round) from matches x where x.tournament_id = m.tournament_id and x.bracket = m.bracket and x.stage = m.stage)::int as rounds,
            coalesce((select max(round) from matches x where x.tournament_id = m.tournament_id and x.bracket = 'W'), 0)::int as w_rounds,
            coalesce((select max(round) from matches x where x.tournament_id = m.tournament_id and x.bracket = 'L'), 0)::int as l_rounds
       from matches m join tournaments t on t.id = m.tournament_id where m.id = $1`,
    [id],
  );
  if (!m) return null;
  const results = await db.query<{
    id: string; version: number; source: string; side: string | null; score_a: number | null; score_b: number | null;
    winner_reg: string; outcome: string; evidence_url: string; note: string; status: string; created_at: Date;
    submitted_by: string; decided_at: Date | null;
  }>(
    `select r.*, u.username as submitted_by from match_results r join users u on u.id = r.submitted_by
      where r.match_id = $1 order by r.version desc`,
    [id],
  );
  const disputes = await db.query<{
    id: string; reason: string; status: string; resolution: string; created_at: Date; opened_by: string; resolved_at: Date | null;
    kind: string; decision: string | null; evidence_url: string; evidence_media_id: string | null;
  }>(
    `select d.id, d.reason, d.status, d.resolution, d.created_at, d.resolved_at, u.username as opened_by, d.kind, d.decision,
            d.evidence_url, d.evidence_media_id
       from disputes d join users u on u.id = d.opened_by where d.match_id = $1 order by d.created_at desc`,
    [id],
  );
  let nextMatch: { id: string; round: number } | null = null;
  if (m.next_match_id) nextMatch = { id: m.next_match_id, round: m.round + 1 };
  else if (m.bracket === "GF" && m.round === 1) {
    const [reset] = await db.query<{ id: string }>("select id from matches where tournament_id = $1 and bracket = 'GF' and round = 2", [m.tournament_id]);
    if (reset) nextMatch = { id: reset.id, round: 2 };
  }
  return { match: m, a: await side(db, m.a_reg), b: await side(db, m.b_reg), results, disputes, nextMatch };
}

export type HistoryEntry = { id: number; at: Date; action: string; entity: string; data: Record<string, unknown>; actor: string | null };

/** The tournament's decisions and changes from the audit log, newest first: the event and its matches. */
export async function tournamentHistory(db: Queryable, tournamentId: string, limit = 80) {
  return db.query<HistoryEntry>(
    `select a.id, a.at, a.action, a.entity, a.data, u.username as actor
       from audit_log a left join users u on u.id = a.actor_id
      where (a.entity = 'tournament' and a.entity_id = $1)
         or (a.entity = 'match' and a.entity_id in (select id::text from matches where tournament_id = $2))
      order by a.id desc limit $3`,
    [tournamentId, tournamentId, limit],
  );
}

export async function hub(db: Queryable, user: SessionUser) {
  const matches = await db.query<BracketMatch & { t_slug: string; t_name: string; t_game: string; room_code: string }>(
    `select m.id, m.round, m.position, m.status, m.outcome, m.a_reg, m.b_reg, m.winner_reg, m.score_a, m.score_b, m.scheduled_at, m.room_code,
            coalesce(ta.name, ua.display_name) as a_name, coalesce(tb.name, ub.display_name) as b_name,
            t.slug as t_slug, t.name as t_name, t.game as t_game
       from matches m join tournaments t on t.id = m.tournament_id
       left join registrations ra on ra.id = m.a_reg left join teams ta on ta.id = ra.team_id left join users ua on ua.id = ra.user_id
       left join registrations rb on rb.id = m.b_reg left join teams tb on tb.id = rb.team_id left join users ub on ub.id = rb.user_id
      where m.status in ('ready','in_progress','result_submitted','disputed')
        and exists (select 1 from roster_entries re where re.user_id = $1 and re.registration_id in (m.a_reg, m.b_reg))
      order by m.scheduled_at asc nulls last, m.round asc`,
    [user.id],
  );
  const registrations = await db.query<{
    slug: string; name: string; game: string; status: string; reg_status: string; checked_in_at: Date | null; check_in_open: boolean;
    check_in_required: boolean; starts_at: Date; placement: number | null; team_name: string | null;
  }>(
    `select t.slug, t.name, t.game, t.status, r.status as reg_status, r.checked_in_at, t.check_in_open, t.check_in_required, t.starts_at,
            r.placement, tm.name as team_name
       from roster_entries re join registrations r on r.id = re.registration_id join tournaments t on t.id = r.tournament_id
       left join teams tm on tm.id = r.team_id
      where re.user_id = $1 and t.status not in ('ARCHIVED')
      order by case when t.status in ('COMPLETED','CANCELLED') then 1 else 0 end, t.starts_at asc
      limit 30`,
    [user.id],
  );
  const invites = await db.query<{ id: string; team_name: string; team_slug: string; game: string; invited_by: string; created_at: Date }>(
    `select i.id, t.name as team_name, t.slug as team_slug, t.game, u.username as invited_by, i.created_at
       from team_invites i join teams t on t.id = i.team_id join users u on u.id = i.invited_by
      where i.user_id = $1 and i.status = 'pending' order by i.created_at desc`,
    [user.id],
  );
  const teams = await db.query<{ slug: string; name: string; game: string; role: string }>(
    `select t.slug, t.name, t.game,
            case when t.owner_id = $1 then 'owner' when t.captain_id = $1 then 'captain' else 'player' end as role
       from team_members m join teams t on t.id = m.team_id where m.user_id = $1 order by t.name`,
    [user.id],
  );
  const orgs = await db.query<{ slug: string; name: string; role: string }>(
    `select o.slug, o.name, m.role from org_members m join organizations o on o.id = m.org_id where m.user_id = $1 order by o.name`,
    [user.id],
  );
  // FFA lobbies of the current round the player is in, with the games still to be played.
  const lobbies = await db.query<{ id: string; round: number; lobby_no: number; room_code: string; scheduled_at: Date | null; t_slug: string; t_name: string; t_game: string; games_left: number; lobbies: number }>(
    `select l.id, l.round, l.lobby_no, l.room_code, l.scheduled_at, t.slug as t_slug, t.name as t_name, t.game as t_game,
            (select count(*)::int from ffa_games g where g.lobby_id = l.id and g.status <> 'completed') as games_left,
            (select count(*)::int from ffa_lobbies x where x.tournament_id = l.tournament_id and x.round = l.round) as lobbies
       from ffa_lobbies l join tournaments t on t.id = l.tournament_id
      where l.status = 'open' and t.status in ('IN_PROGRESS','PAUSED')
        and exists (select 1 from ffa_entries e join roster_entries re on re.registration_id = e.registration_id
                     where e.lobby_id = l.id and re.user_id = $1)
      order by l.scheduled_at asc nulls last, l.round asc`,
    [user.id],
  );
  return { matches, registrations, invites, teams, orgs, lobbies };
}

export async function notifications(db: Queryable, userId: string, limit = 50) {
  return db.query<{ id: string; kind: string; data: Record<string, string>; read_at: Date | null; created_at: Date }>(
    "select id, kind, data, read_at, created_at from notifications where user_id = $1 order by created_at desc limit $2",
    [userId, limit],
  );
}

export async function unreadCount(db: Queryable, userId: string) {
  const [r] = await db.query<{ n: number }>(
    "select count(*)::int as n from notifications where user_id = $1 and read_at is null",
    [userId],
  );
  return r?.n ?? 0;
}

export async function playerProfile(db: Queryable, username: string, viewer: SessionUser | null) {
  const [u] = await db.query<{
    id: string; username: string; display_name: string; country: string; bio: string; profile_public: boolean; created_at: Date; status: string; avatar_color: string;
  }>("select id, username, display_name, country, bio, profile_public, created_at, status, avatar_color from users where username = $1", [username.toLowerCase()]);
  if (!u || u.status === "deleted" || u.status === "pending") return null;
  const self = viewer?.id === u.id;
  // Staff with the users section may open a private profile; the page marks it and records the view.
  const staffView = !u.profile_public && !self && canStaff(viewer, "users");
  if (!u.profile_public && !self && !staffView) return { user: u, hidden: true as const };
  const teams = await db.query<{ slug: string; name: string; game: string }>(
    "select t.slug, t.name, t.game from team_members m join teams t on t.id = m.team_id where m.user_id = $1 order by t.name",
    [u.id],
  );
  const accounts = await db.query<{ game: string; handle: string; verified: boolean }>(
    "select game, handle, verified from linked_game_accounts where user_id = $1 order by game",
    [u.id],
  );
  const tournaments = await db.query<{ slug: string; name: string; game: string; status: string; placement: number | null; team_name: string | null; starts_at: Date }>(
    `select t.slug, t.name, t.game, t.status, r.placement, tm.name as team_name, t.starts_at
       from roster_entries re join registrations r on r.id = re.registration_id join tournaments t on t.id = r.tournament_id
       left join teams tm on tm.id = r.team_id
      where re.user_id = $1 and t.status in ('IN_PROGRESS','PAUSED','COMPLETED') order by t.starts_at desc limit 50`,
    [u.id],
  );
  const history = await db.query<{
    id: string; completed_at: Date; t_slug: string; t_name: string; t_game: string; won: boolean; drawn: boolean; opponent: string | null;
    my_score: number | null; their_score: number | null; outcome: string; source: string | null; versions: number;
  }>(
    `select m.id, m.completed_at, t.slug as t_slug, t.name as t_name, t.game as t_game,
            coalesce(m.winner_reg = re.registration_id, false) as won, (m.winner_reg is null) as drawn,
            case when m.a_reg = re.registration_id then coalesce(tb.name, ub.display_name) else coalesce(ta.name, ua.display_name) end as opponent,
            case when m.a_reg = re.registration_id then m.score_a else m.score_b end as my_score,
            case when m.a_reg = re.registration_id then m.score_b else m.score_a end as their_score,
            m.outcome,
            (select source from match_results mr where mr.match_id = m.id and mr.status = 'confirmed' order by version desc limit 1) as source,
            (select count(*)::int from match_results mr where mr.match_id = m.id) as versions
       from roster_entries re join matches m on re.registration_id in (m.a_reg, m.b_reg)
       join tournaments t on t.id = m.tournament_id
       left join registrations ra on ra.id = m.a_reg left join teams ta on ta.id = ra.team_id left join users ua on ua.id = ra.user_id
       left join registrations rb on rb.id = m.b_reg left join teams tb on tb.id = rb.team_id left join users ub on ub.id = rb.user_id
      where re.user_id = $1 and m.status = 'completed' and m.outcome <> 'bye'
      order by m.completed_at desc limit 50`,
    [u.id],
  );
  return { user: u, hidden: false as const, teams, accounts, tournaments, history, self, staffView };
}

export async function listPlayers(db: Queryable, search: string) {
  const q = `%${search.toLowerCase().replace(/[%_]/g, "")}%`;
  return db.query<{ username: string; display_name: string; country: string; teams: number; wins: number }>(
    `select u.username, u.display_name, u.country,
            (select count(*)::int from team_members m where m.user_id = u.id) as teams,
            (select count(*)::int from matches m join roster_entries re on re.registration_id = m.winner_reg
              where re.user_id = u.id and m.status = 'completed' and m.outcome <> 'bye') as wins
       from users u where u.status = 'active' and u.profile_public = true
        and (lower(u.username) like $1 or lower(u.display_name) like $1)
      order by wins desc, u.created_at asc limit 60`,
    [q],
  );
}

export async function listTeams(db: Queryable, game?: string) {
  return db.query<{ slug: string; name: string; tag: string; game: string; members: number; wins: number }>(
    `select t.slug, t.name, t.tag, t.game,
            (select count(*)::int from team_members m where m.team_id = t.id) as members,
            (select count(*)::int from matches m join registrations r on r.id = m.winner_reg
              where r.team_id = t.id and m.status = 'completed' and m.outcome <> 'bye') as wins
       from teams t where ($1::text is null or t.game = $1)
      order by wins desc, t.created_at desc limit 100`,
    [game ?? null],
  );
}

export async function teamBySlug(db: Queryable, slug: string) {
  const [team] = await db.query<{
    id: string; slug: string; name: string; tag: string; game: string; owner_id: string; captain_id: string; created_at: Date;
    logo_media_id: string | null; banner_media_id: string | null;
  }>("select * from teams where slug = $1", [slug]);
  if (!team) return null;
  const members = await db.query<{ id: string; username: string; display_name: string; joined_at: Date }>(
    `select u.id, u.username, u.display_name, m.joined_at from team_members m join users u on u.id = m.user_id
      where m.team_id = $1 order by m.joined_at`,
    [team.id],
  );
  const invites = await db.query<{ id: string; username: string; created_at: Date }>(
    `select i.id, u.username, i.created_at from team_invites i join users u on u.id = i.user_id
      where i.team_id = $1 and i.status = 'pending' order by i.created_at`,
    [team.id],
  );
  const tournaments = await db.query<{ slug: string; name: string; status: string; placement: number | null; reg_status: string; starts_at: Date }>(
    `select t.slug, t.name, t.status, r.placement, r.status as reg_status, t.starts_at from registrations r join tournaments t on t.id = r.tournament_id
      where r.team_id = $1 and r.status <> 'withdrawn' order by t.starts_at desc`,
    [team.id],
  );
  const [stats] = await db.query<{ played: number; wins: number; podiums: number }>(
    `select (select count(*)::int from matches m join registrations r on r.id in (m.a_reg, m.b_reg)
              where r.team_id = $1 and m.status = 'completed' and m.outcome <> 'bye') as played,
            (select count(*)::int from matches m join registrations r on r.id = m.winner_reg
              where r.team_id = $1 and m.status = 'completed' and m.outcome <> 'bye') as wins,
            (select count(*)::int from registrations r where r.team_id = $1 and r.placement between 1 and 3) as podiums`,
    [team.id],
  );
  return { team, members, invites, tournaments, stats };
}

export async function orgsFor(db: Queryable, user: SessionUser) {
  return db.query<{ id: string; slug: string; name: string; role: string; tournaments: number }>(
    `select o.id, o.slug, o.name, m.role, (select count(*)::int from tournaments t where t.org_id = o.id) as tournaments
       from org_members m join organizations o on o.id = m.org_id where m.user_id = $1 order by o.created_at`,
    [user.id],
  );
}

export async function orgBySlug(db: Queryable, slug: string) {
  const [org] = await db.query<{ id: string; slug: string; name: string; description: string; created_at: Date }>(
    "select * from organizations where slug = $1",
    [slug],
  );
  if (!org) return null;
  const members = await db.query<{ id: string; username: string; display_name: string; role: string }>(
    `select u.id, u.username, u.display_name, m.role from org_members m join users u on u.id = m.user_id
      where m.org_id = $1 order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, u.username`,
    [org.id],
  );
  const tournaments = await db.query<{ id: string; slug: string; name: string; game: string; status: string; starts_at: Date; registered: number }>(
    `select t.id, t.slug, t.name, t.game, t.status, t.starts_at,
            (select count(*)::int from registrations r where r.tournament_id = t.id and r.status = 'registered') as registered
       from tournaments t where t.org_id = $1 order by t.created_at desc`,
    [org.id],
  );
  return { org, members, tournaments };
}

/**
 * Per-game rankings from matches confirmed on the portal. Titles are first places of completed events
 * (placements), so a double-elimination reset or a round-robin match never counts as a title. A draw is
 * neither a win nor a loss.
 */
export async function rankings(db: Queryable, game: string) {
  const solo = await db.query<{ name: string; link: string; wins: number; draws: number; losses: number; titles: number }>(
    `with results as (
       select r.user_id, m.winner_reg is null as drawn, (m.winner_reg = r.id) as won
         from matches m join tournaments t on t.id = m.tournament_id
         join registrations r on r.id in (m.a_reg, m.b_reg)
        where t.game = $1 and m.status = 'completed' and m.outcome <> 'bye' and r.user_id is not null),
     titles as (
       select r.user_id, count(*)::int as n from registrations r join tournaments t on t.id = r.tournament_id
        where t.game = $1 and t.status in ('COMPLETED','ARCHIVED') and r.placement = 1 and r.user_id is not null group by r.user_id)
     select u.display_name as name, u.username as link,
            count(*) filter (where won)::int as wins, count(*) filter (where drawn)::int as draws,
            count(*) filter (where not drawn and not won)::int as losses,
            coalesce(max(ti.n), 0)::int as titles
       from results x join users u on u.id = x.user_id left join titles ti on ti.user_id = u.id
      where u.status = 'active' and u.profile_public
      group by u.id order by titles desc, wins desc, draws desc, losses asc limit 100`,
    [game],
  );
  const teams = await db.query<{ name: string; link: string; wins: number; draws: number; losses: number; titles: number }>(
    `with results as (
       select r.team_id, m.winner_reg is null as drawn, (m.winner_reg = r.id) as won
         from matches m join tournaments t on t.id = m.tournament_id
         join registrations r on r.id in (m.a_reg, m.b_reg)
        where t.game = $1 and m.status = 'completed' and m.outcome <> 'bye' and r.team_id is not null),
     titles as (
       select r.team_id, count(*)::int as n from registrations r join tournaments t on t.id = r.tournament_id
        where t.game = $1 and t.status in ('COMPLETED','ARCHIVED') and r.placement = 1 and r.team_id is not null group by r.team_id)
     select tm.name, tm.slug as link,
            count(*) filter (where won)::int as wins, count(*) filter (where drawn)::int as draws,
            count(*) filter (where not drawn and not won)::int as losses,
            coalesce(max(ti.n), 0)::int as titles
       from results x join teams tm on tm.id = x.team_id left join titles ti on ti.team_id = tm.id
      group by tm.id order by titles desc, wins desc, draws desc, losses asc limit 100`,
    [game],
  );
  return { solo, teams };
}

export async function trustStats(db: Queryable) {
  const [s] = await db.query<{
    completed: number; disputes: number; resolved: number; open: number; corrections: number; no_shows: number; disqualifications: number; suspensions: number;
  }>(
    `select
       (select count(*)::int from matches where status = 'completed' and outcome <> 'bye') as completed,
       (select count(*)::int from disputes) as disputes,
       (select count(*)::int from disputes where status = 'resolved') as resolved,
       (select count(*)::int from disputes where status = 'open') as open,
       (select count(*)::int from audit_log where action = 'match.result_corrected') as corrections,
       (select count(*)::int from matches where outcome = 'no_show') as no_shows,
       (select count(*)::int from registrations where status = 'disqualified') as disqualifications,
       (select count(*)::int from users where status = 'suspended') as suspensions`,
  );
  return s;
}

export async function adminOverview(db: Queryable) {
  const [counts] = await db.query<Record<string, number>>(
    `select (select count(*)::int from users where status in ('active','suspended')) as users,
            (select count(*)::int from teams) as teams,
            (select count(*)::int from organizations) as orgs,
            (select count(*)::int from tournaments) as tournaments,
            (select count(*)::int from tournaments where status in ('IN_PROGRESS','PAUSED')) as live,
            (select count(*)::int from disputes where status = 'open') as open_disputes,
            (select count(*)::int from applications where status = 'new') as new_applications,
            (select count(*)::int from score_entries where review = 'pending') as pending_scores,
            (select count(*)::int from challenges where status = 'disputed') as disputed_challenges,
            (select count(*)::int from membership_applications where status in ('submitted','under_review','awaiting_info')) as membership_queue,
            (select count(*)::int from invoices where status = 'open') as open_invoices,
            (select count(*)::int from memberships where status = 'active') as active_memberships,
            (select count(*)::int from email_outbox where status in ('pending','failed','sending')) as mail_queue,
            (select count(*)::int from conduct_reports where status in ('open','reviewing')) as conduct_reports,
            (select count(*)::int from sanction_appeals where status = 'open') as conduct_appeals,
            (select count(*)::int from transfer_disputes where status = 'open') as transfer_disputes,
            (select count(*)::int from clan_wars where status = 'disputed') as war_disputes,
            (select count(*)::int from venues where status = 'submitted') as venue_reviews,
            (select count(*)::int from coaches where status = 'submitted') as coach_reviews`,
  );
  return counts;
}

export async function adminUsers(db: Queryable, search: string) {
  // Wildcards typed by staff are matched literally (usernames contain "_").
  const q = `%${search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db.query<{ id: string; username: string; email: string; display_name: string; status: string; roles: string[]; created_at: Date }>(
    `select u.id, u.username, u.email, u.display_name, u.status, u.created_at,
            array(select role from user_roles r where r.user_id = u.id order by role) as roles
       from users u where u.status <> 'deleted' and (u.username like $1 or u.email like $1 or lower(u.display_name) like $1)
      order by u.created_at desc limit 100`,
    [q],
  );
}

export async function adminDisputes(db: Queryable) {
  return db.query<{ id: string; match_id: string; reason: string; created_at: Date; opened_by: string; t_name: string; t_slug: string }>(
    `select d.id, d.match_id, d.reason, d.created_at, u.username as opened_by, t.name as t_name, t.slug as t_slug
       from disputes d join users u on u.id = d.opened_by join matches m on m.id = d.match_id join tournaments t on t.id = m.tournament_id
      where d.status = 'open' order by d.created_at asc`,
  );
}

export async function adminApplications(db: Queryable, status?: string) {
  return db.query<{ id: string; kind: string; name: string; email: string; company: string; message: string; lang: string; status: string; created_at: Date }>(
    `select id, kind, name, email, company, message, lang, status, created_at from applications
      where ($1::text is null or status = $1) order by created_at desc limit 200`,
    [status ?? null],
  );
}

export async function adminAudit(db: Queryable, limit = 150) {
  return db.query<{ id: string; at: Date; actor: string | null; action: string; entity: string; entity_id: string; hash: string }>(
    `select a.id::text, a.at, u.username as actor, a.action, a.entity, a.entity_id, a.hash
       from audit_log a left join users u on u.id = a.actor_id order by a.id desc limit $1`,
    [limit],
  );
}

export async function adminTournaments(db: Queryable) {
  return db.query<{ id: string; slug: string; name: string; game: string; status: string; format: string; prize_coins: number; org_name: string; org_slug: string; starts_at: Date }>(
    `select t.id, t.slug, t.name, t.game, t.status, t.format, t.prize_coins, o.name as org_name, o.slug as org_slug, t.starts_at
       from tournaments t join organizations o on o.id = t.org_id order by t.created_at desc limit 200`,
  );
}

export async function sessionsFor(db: Queryable, userId: string) {
  return db.query<{ id: string; created_at: Date; last_seen_at: Date; user_agent: string }>(
    `select id, created_at, last_seen_at, user_agent from sessions
      where user_id = $1 and revoked_at is null and expires_at > now() order by last_seen_at desc`,
    [userId],
  );
}

export async function ping(db: Database) {
  const started = Date.now();
  await db.query("select 1");
  return Date.now() - started;
}
