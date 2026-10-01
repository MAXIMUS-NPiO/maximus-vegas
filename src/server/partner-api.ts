/**
 * Read API v1 for partners (MV-HOOK-1): JSON over the tournaments of the key's organising space only.
 * Names are the public names already shown on the portal; no contact details, answers or rosters' private data.
 */
import type { Queryable } from "./db.ts";
import { bracket, getTournament, participants } from "./queries.ts";
import { isRoundFormat } from "./format-settings.ts";
import { groupStandings, roundStandings } from "./rounds.ts";
import { leaderboardStandings } from "./leaderboard.ts";
import { siteOrigin } from "../lib/site.ts";

const pageUrl = (path: string) => `${siteOrigin() ?? "https://www.maximus.vegas"}${path}`;

export async function apiOrganization(q: Queryable, orgId: string) {
  const [org] = await q.query<{ id: string; slug: string; name: string; description: string }>(
    "select id, slug, name, description from organizations where id = $1",
    [orgId],
  );
  return org ? { ...org, url: pageUrl(`/ru/organizer/${org.slug}`) } : null;
}

type ListRow = {
  id: string;
  slug: string;
  name: string;
  game: string;
  format: string;
  status: string;
  participant_type: string;
  team_size: number;
  max_participants: number;
  registered: number;
  starts_at: Date | null;
  completed_at: Date | null;
};

const tournamentOut = (t: ListRow) => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  game: t.game,
  format: t.format,
  status: t.status,
  participant_type: t.participant_type,
  team_size: t.team_size,
  max_participants: t.max_participants,
  registered: t.registered,
  starts_at: t.starts_at,
  completed_at: t.completed_at,
  url: pageUrl(`/ru/tournaments/${t.slug}`),
});

export async function apiTournaments(q: Queryable, orgId: string) {
  const rows = await q.query<ListRow>(
    `select t.id, t.slug, t.name, t.game, t.format, t.status, t.participant_type, t.team_size, t.max_participants, t.starts_at, t.completed_at,
            (select count(*)::int from registrations r where r.tournament_id = t.id and r.status = 'registered') as registered
       from tournaments t where t.org_id = $1 order by t.starts_at desc nulls last, t.created_at desc limit 200`,
    [orgId],
  );
  return rows.map(tournamentOut);
}

/** The tournament if it belongs to the key's space; otherwise null (no difference between foreign and missing). */
async function ownTournament(q: Queryable, orgId: string, slug: string) {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return null;
  const t = await getTournament(q, slug);
  return t && t.org_id === orgId ? t : null;
}

export async function apiTournament(q: Queryable, orgId: string, slug: string) {
  const t = await ownTournament(q, orgId, slug);
  if (!t) return null;
  const list = await participants(q, t.id);
  return {
    ...tournamentOut(t as unknown as ListRow),
    description: t.description,
    region: t.region,
    check_in_required: t.check_in_required,
    participants: list.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      seed: p.seed,
      placement: p.placement,
      checked_in: Boolean(p.checked_in_at),
      ...(p.team_slug ? { team: p.team_slug } : { username: p.username }),
    })),
  };
}

export async function apiMatches(q: Queryable, orgId: string, slug: string) {
  const t = await ownTournament(q, orgId, slug);
  if (!t) return null;
  const rows = await bracket(q, t.id);
  return rows.map((m) => ({
    id: m.id,
    stage: m.stage ?? 1,
    bracket: m.bracket ?? "W",
    group: m.group_no ?? 0,
    round: m.round,
    position: m.position,
    status: m.status,
    scheduled_at: m.scheduled_at,
    a: m.a_reg ? { registration: m.a_reg, name: m.a_name } : null,
    b: m.b_reg ? { registration: m.b_reg, name: m.b_name } : null,
    score_a: m.score_a,
    score_b: m.score_b,
    winner: m.winner_reg === null ? null : m.winner_reg === m.a_reg ? "a" : "b",
    outcome: m.outcome,
    url: pageUrl(`/ru/matches/${m.id}`),
  }));
}

/**
 * Standings in the shape the format has: a points table (round robin, Swiss), a table per group, a
 * leaderboard, or final places (elimination, FFA and any completed event).
 */
export async function apiStandings(q: Queryable, orgId: string, slug: string) {
  const t = await ownTournament(q, orgId, slug);
  return t ? standingsFor(q, t) : null;
}

type StandingsTournament = NonNullable<Awaited<ReturnType<typeof getTournament>>>;
export type Standings = Awaited<ReturnType<typeof standingsFor>>;

/** Standings of a tournament for the API and the standings widget. */
export async function standingsFor(q: Queryable, t: StandingsTournament) {
  const list = await participants(q, t.id);
  const name = new Map(list.map((p) => [p.id, p.name]));
  const finished = t.status === "COMPLETED" || t.status === "ARCHIVED";
  const tableRow = (r: { id: string; rank: number | null; played: number; wins: number; draws: number; losses: number; points: number; diff: number }) => ({
    registration: r.id,
    name: name.get(r.id) ?? null,
    rank: r.rank,
    played: r.played,
    wins: r.wins,
    draws: r.draws,
    losses: r.losses,
    points: r.points,
    diff: r.diff,
  });
  if (t.format === "leaderboard") {
    const rows = ["IN_PROGRESS", "PAUSED", "COMPLETED", "ARCHIVED"].includes(t.status) ? await leaderboardStandings(q, t) : [];
    return {
      kind: "leaderboard" as const,
      final: finished,
      rows: rows.map((r, i) => ({ registration: r.participantId, name: r.name, rank: i + 1, points: r.points, kills: r.kills })),
    };
  }
  if (isRoundFormat(t.format) && !finished) {
    if (t.format === "groups") {
      const groups = await groupStandings(q, t);
      return { kind: "groups" as const, final: false, groups: groups.map((g) => ({ group: g.group, rows: g.rows.map(tableRow) })) };
    }
    const started = (await q.query("select 1 from matches where tournament_id = $1 limit 1", [t.id])).length > 0;
    return { kind: "table" as const, final: false, rows: started ? (await roundStandings(q, t)).map(tableRow) : [] };
  }
  const placed = list.filter((p) => p.placement !== null).sort((a, b) => (a.placement ?? 0) - (b.placement ?? 0));
  return { kind: "placements" as const, final: finished, rows: placed.map((p) => ({ registration: p.id, name: p.name, placement: p.placement })) };
}
