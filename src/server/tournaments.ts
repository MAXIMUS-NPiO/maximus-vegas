import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { canManageOrg, canReferee, isAdmin, notify } from "./access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { planSingleElimination } from "./bracket.ts";
import { planDoubleElimination, refKey, deStage } from "./double.ts";
import { mergeWeights, WEIGHT_KEYS, type Weights } from "./scoring.ts";
import { gameBySlug } from "../lib/games.ts";
import { isCountry } from "../lib/countries.ts";
import { uniqueSlug } from "./teams.ts";
import { grantXp, settleChampionAward, XP } from "./progression.ts";
import * as v from "./validate.ts";

export const STATUSES = [
  "DRAFT",
  "PUBLISHED",
  "REGISTRATION_OPEN",
  "REGISTRATION_CLOSED",
  "IN_PROGRESS",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
  "ARCHIVED",
] as const;
export type TournamentStatus = (typeof STATUSES)[number];

export const FORMATS = ["single_elimination", "double_elimination", "leaderboard"] as const;
export type Format = (typeof FORMATS)[number];
export const isBracketFormat = (f: string) => f === "single_elimination" || f === "double_elimination";

/**
 * Explicitly allowed manual transitions. A bracket tournament reaches COMPLETED only by confirming its
 * final; a leaderboard tournament is completed by its organiser once no line awaits review.
 */
export const TRANSITIONS: Record<TournamentStatus, TournamentStatus[]> = {
  DRAFT: ["PUBLISHED", "CANCELLED"],
  PUBLISHED: ["DRAFT", "REGISTRATION_OPEN", "CANCELLED"],
  REGISTRATION_OPEN: ["REGISTRATION_CLOSED", "CANCELLED"],
  REGISTRATION_CLOSED: ["REGISTRATION_OPEN", "IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["PAUSED", "CANCELLED"],
  PAUSED: ["IN_PROGRESS", "CANCELLED"],
  COMPLETED: ["ARCHIVED"],
  CANCELLED: ["ARCHIVED"],
  ARCHIVED: [],
};

export function allowedTransitions(format: string, status: TournamentStatus): TournamentStatus[] {
  const base = TRANSITIONS[status];
  return format === "leaderboard" && status === "IN_PROGRESS" ? [...base, "COMPLETED"] : base;
}

export type TournamentRow = {
  id: string;
  slug: string;
  org_id: string;
  name: string;
  game: string;
  format: Format;
  participant_type: "solo" | "team";
  team_size: number;
  max_participants: number;
  check_in_required: boolean;
  check_in_open: boolean;
  status: TournamentStatus;
  starts_at: Date;
  created_by: string;
  scoring: Record<string, number> | null;
  best_of: number | null;
  submission_hours: number | null;
  submission_deadline: Date | null;
  region_lock: string[];
  prize_coins: number;
};

export type MatchRow = {
  id: string;
  tournament_id: string;
  bracket: "W" | "L" | "GF";
  round: number;
  position: number;
  a_reg: string | null;
  b_reg: string | null;
  winner_reg: string | null;
  score_a: number | null;
  score_b: number | null;
  status: string;
  outcome: string | null;
  next_match_id: string | null;
  next_slot: "a" | "b" | null;
  loser_next_match_id: string | null;
  loser_next_slot: "a" | "b" | null;
  a_void: boolean;
  b_void: boolean;
};

export async function lockTournament(q: Queryable, id: string): Promise<TournamentRow> {
  const [t] = await q.query<TournamentRow>("select * from tournaments where id = $1 for update", [id]);
  if (!t) fail("not_found");
  return t;
}

export async function isCoOrganizer(q: Queryable, tournamentId: string, userId: string | undefined) {
  if (!userId) return false;
  const [row] = await q.query("select 1 from tournament_organizers where tournament_id = $1 and user_id = $2", [tournamentId, userId]);
  return Boolean(row);
}

/** Owners and admins of the organising space, the tournament's co-organisers, or platform admins. */
export async function canManageTournament(q: Queryable, t: { id: string; org_id: string }, user: SessionUser | null) {
  if (!user) return false;
  if (await canManageOrg(q, t.org_id, user)) return true;
  return isCoOrganizer(q, t.id, user.id);
}

/** Anyone allowed to decide results in this tournament: space staff, platform referees and co-organisers. */
export async function canRefereeTournament(q: Queryable, t: { id: string; org_id: string }, user: SessionUser | null) {
  if (!user) return false;
  if (await canReferee(q, t.org_id, user)) return true;
  return isCoOrganizer(q, t.id, user.id);
}

async function requireManager(q: Queryable, t: TournamentRow, user: SessionUser) {
  if (!(await canManageTournament(q, t, user))) fail("forbidden");
}

export type TournamentInput = {
  name: unknown;
  game: unknown;
  format?: unknown;
  participantType: unknown;
  teamSize: unknown;
  maxParticipants: unknown;
  checkInRequired: unknown;
  region: unknown;
  regionLock?: unknown;
  startsAt: unknown;
  timeZone: unknown;
  description: unknown;
  rules: unknown;
  bestOf?: unknown;
  submissionHours?: unknown;
  weights?: Record<string, unknown>;
  prizeText?: unknown;
  livestreamUrl?: unknown;
};

function parseRegionLock(value: unknown): string[] {
  const list = (Array.isArray(value) ? value : String(value ?? "").split(/[\s,;]+/))
    .map((x) => String(x).trim().toUpperCase())
    .filter(Boolean);
  const unique = [...new Set(list)];
  if (unique.length > 60 || unique.some((c) => !isCountry(c))) fail("invalid_country");
  return unique;
}

function parseWeights(input: Record<string, unknown> | undefined): Weights | null {
  if (!input) return null;
  const out: Record<string, number> = {};
  let any = false;
  for (const key of WEIGHT_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const n = Number(String(raw).replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || n > 1000) fail("invalid_input");
    out[key] = n;
    any = true;
  }
  return any ? mergeWeights(out) : null;
}

const optionalInt = (value: unknown, min: number, max: number) =>
  value === undefined || value === null || String(value).trim() === "" ? null : v.intIn(value, min, max);

function parseInput(input: TournamentInput) {
  const name = v.displayName(input.name, 80);
  const format = (FORMATS as readonly string[]).includes(String(input.format ?? "single_elimination"))
    ? (String(input.format ?? "single_elimination") as Format)
    : fail("invalid_input");
  const game = gameBySlug(String(input.game ?? ""));
  if (!game) fail("invalid_game");
  if (isBracketFormat(format) && !game!.bracket) fail("format_not_supported");
  const participantType = input.participantType === "team" ? "team" : input.participantType === "solo" ? "solo" : fail("invalid_input");
  const teamSize = participantType === "solo" ? 1 : v.intIn(input.teamSize || game!.teamSize, 2, 10);
  const leaderboard = format === "leaderboard";
  return {
    name,
    format,
    game: game!.slug,
    participantType,
    teamSize,
    maxParticipants: v.intIn(input.maxParticipants, 2, 512),
    checkInRequired: v.bool(input.checkInRequired),
    region: v.oneLine(input.region, 60),
    regionLock: parseRegionLock(input.regionLock),
    startsAt: v.zonedToUtc(input.startsAt, input.timeZone),
    description: v.clean(input.description, 4000),
    rules: v.clean(input.rules, 8000),
    bestOf: leaderboard ? optionalInt(input.bestOf, 1, 50) : null,
    submissionHours: leaderboard ? optionalInt(input.submissionHours, 1, 720) : null,
    scoring: leaderboard ? parseWeights(input.weights) : null,
    prizeText: v.clean(input.prizeText, 600),
    livestreamUrl: v.optionalUrl(input.livestreamUrl),
  };
}

export async function createTournament(db: Database, user: SessionUser, orgId: string, input: TournamentInput) {
  const data = parseInput(input);
  return db.tx(async (q) => {
    if (!(await canManageOrg(q, orgId, user))) fail("forbidden");
    const slug = await uniqueSlug(q, "tournaments", data.name);
    const [t] = await q.query<{ id: string; slug: string }>(
      `insert into tournaments (slug, org_id, name, game, format, participant_type, team_size, max_participants,
         check_in_required, region, region_lock, starts_at, description, rules, best_of, submission_hours, scoring,
         prize_text, livestream_url, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning id, slug`,
      [slug, orgId, data.name, data.game, data.format, data.participantType, data.teamSize, data.maxParticipants, data.checkInRequired,
        data.region, data.regionLock, data.startsAt.toISOString(), data.description, data.rules, data.bestOf, data.submissionHours,
        data.scoring ? JSON.stringify(data.scoring) : null, data.prizeText, data.livestreamUrl, user.id],
    );
    await audit(q, { actorId: user.id, action: "tournament.created", entity: "tournament", entityId: t.id, data: { name: data.name, game: data.game, format: data.format } });
    return t;
  });
}

export async function updateTournament(db: Database, user: SessionUser, tournamentId: string, input: TournamentInput) {
  const data = parseInput(input);
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (!["DRAFT", "PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status)) fail("not_editable");
    const [count] = await q.query<{ n: number; active: number }>(
      "select count(*)::int as n, count(*) filter (where status = 'registered')::int as active from registrations where tournament_id = $1 and status <> 'withdrawn'",
      [t.id],
    );
    const structural =
      data.game !== t.game || data.participantType !== t.participant_type || data.teamSize !== t.team_size || data.format !== t.format;
    if (structural && (count?.n ?? 0) > 0) fail("not_editable");
    if (data.maxParticipants < (count?.active ?? 0)) fail("invalid_input");
    await q.query(
      `update tournaments set name=$2, game=$3, format=$4, participant_type=$5, team_size=$6, max_participants=$7,
         check_in_required=$8, region=$9, region_lock=$10, starts_at=$11, description=$12, rules=$13, best_of=$14,
         submission_hours=$15, scoring=$16, prize_text=$17, livestream_url=$18, updated_at=now() where id=$1`,
      [t.id, data.name, data.game, data.format, data.participantType, data.teamSize, data.maxParticipants, data.checkInRequired,
        data.region, data.regionLock, data.startsAt.toISOString(), data.description, data.rules, data.bestOf, data.submissionHours,
        data.scoring ? JSON.stringify(data.scoring) : null, data.prizeText, data.livestreamUrl],
    );
    await audit(q, { actorId: user.id, action: "tournament.updated", entity: "tournament", entityId: t.id });
  });
}

async function rosterUsers(q: Queryable, tournamentId: string): Promise<string[]> {
  const rows = await q.query<{ user_id: string }>(
    `select re.user_id from roster_entries re join registrations r on r.id = re.registration_id
      where re.tournament_id = $1 and r.status in ('registered')`,
    [tournamentId],
  );
  return rows.map((r) => r.user_id);
}

export async function regMembers(q: Queryable, regId: string | null): Promise<string[]> {
  if (!regId) return [];
  const rows = await q.query<{ user_id: string }>("select user_id from roster_entries where registration_id = $1", [regId]);
  return rows.map((r) => r.user_id);
}

/** Users who may act for a registration: the solo player, or the team's current owner and captain. */
export async function regLeaders(q: Queryable, regId: string | null): Promise<string[]> {
  if (!regId) return [];
  const [r] = await q.query<{ user_id: string | null; owner_id: string | null; captain_id: string | null }>(
    `select r.user_id, t.owner_id, t.captain_id from registrations r left join teams t on t.id = r.team_id where r.id = $1`,
    [regId],
  );
  if (!r) return [];
  return [r.user_id, r.owner_id, r.captain_id].filter((x): x is string => Boolean(x));
}

export async function transition(db: Database, user: SessionUser, tournamentId: string, toInput: unknown) {
  const to = String(toInput) as TournamentStatus;
  if (!STATUSES.includes(to)) fail("invalid_transition");
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (!allowedTransitions(t.format, t.status).includes(to)) fail("invalid_transition");
    if (t.status === "PUBLISHED" && to === "DRAFT") {
      const [r] = await q.query("select 1 from registrations where tournament_id = $1 limit 1", [t.id]);
      if (r) fail("invalid_transition");
    }
    if (t.status === "REGISTRATION_CLOSED" && to === "IN_PROGRESS") {
      if (t.format === "leaderboard") await startLeaderboard(q, t, user);
      else await startBracket(q, t, user);
    }
    if (t.format === "leaderboard" && to === "COMPLETED") {
      const { completeLeaderboard } = await import("./leaderboard.ts");
      await completeLeaderboard(q, t, user.id);
      await audit(q, { actorId: user.id, action: "tournament.status", entity: "tournament", entityId: t.id, data: { from: t.status, to } });
      return;
    }
    if (to === "CANCELLED") {
      await q.query("update matches set status = 'cancelled', updated_at = now() where tournament_id = $1 and status <> 'completed'", [t.id]);
      await notify(q, await rosterUsers(q, t.id), "tournament_cancelled", { tournament: t.name, slug: t.slug });
    }
    if (to === "PAUSED" || (t.status === "PAUSED" && to === "IN_PROGRESS"))
      await notify(q, await rosterUsers(q, t.id), to === "PAUSED" ? "tournament_paused" : "tournament_resumed", { tournament: t.name, slug: t.slug });
    await q.query("update tournaments set status = $2, updated_at = now() where id = $1", [t.id, to]);
    if (to === "CANCELLED") await q.query("update tournaments set check_in_open = false where id = $1", [t.id]);
    await audit(q, { actorId: user.id, action: "tournament.status", entity: "tournament", entityId: t.id, data: { from: t.status, to } });
  });
}

/** Region lock: every entrant must have a profile country inside the allowed list. */
async function checkRegion(q: Queryable, t: TournamentRow, roster: string[]) {
  if (!t.region_lock?.length) return;
  const rows = await q.query<{ id: string; country_code: string | null }>("select id, country_code from users where id = any($1)", [roster]);
  if (rows.some((r) => !r.country_code)) fail("country_required");
  if (rows.some((r) => !t.region_lock.includes(r.country_code!))) fail("region_locked");
}

export async function register(db: Database, user: SessionUser, tournamentId: string, teamId?: string) {
  return db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    if (t.status !== "REGISTRATION_OPEN") fail("registration_closed");
    let roster: string[];
    let regUser: string | null = null;
    let regTeam: string | null = null;
    if (t.participant_type === "solo") {
      if (teamId) fail("wrong_participant_type");
      roster = [user.id];
      regUser = user.id;
    } else {
      if (!teamId) fail("wrong_participant_type");
      const [team] = await q.query<{ id: string; game: string; owner_id: string; captain_id: string }>(
        "select * from teams where id = $1 for update",
        [teamId],
      );
      if (!team) fail("not_found");
      if (team.owner_id !== user.id && team.captain_id !== user.id) fail("not_team_leader");
      if (team.game !== t.game) fail("team_game_mismatch");
      roster = (await q.query<{ user_id: string }>(
        "select m.user_id from team_members m join users u on u.id = m.user_id where m.team_id = $1 and u.status = 'active'",
        [team.id],
      )).map((r) => r.user_id);
      if (roster.length < t.team_size) fail("team_too_small");
      if (roster.length > t.team_size + 3) fail("team_too_large");
      regTeam = team.id;
    }
    await checkRegion(q, t, roster);
    const [active] = await q.query<{ n: number }>(
      "select count(*)::int as n from registrations where tournament_id = $1 and status = 'registered'",
      [t.id],
    );
    const status = (active?.n ?? 0) >= t.max_participants ? "waitlisted" : "registered";
    let regId: string;
    try {
      const [reg] = await q.query<{ id: string }>(
        `insert into registrations (tournament_id, user_id, team_id, registered_by, status)
         values ($1, $2, $3, $4, $5) returning id`,
        [t.id, regUser, regTeam, user.id, status],
      );
      regId = reg.id;
    } catch (error) {
      if (isUniqueViolation(error)) fail("already_registered");
      throw error;
    }
    try {
      for (const member of roster)
        await q.query("insert into roster_entries (registration_id, tournament_id, user_id) values ($1, $2, $3)", [regId, t.id, member]);
    } catch (error) {
      if (isUniqueViolation(error)) fail("roster_conflict");
      throw error;
    }
    await notify(q, roster, status === "registered" ? "registered" : "waitlisted", { tournament: t.name, slug: t.slug });
    await audit(q, { actorId: user.id, action: "registration.created", entity: "tournament", entityId: t.id, data: { registrationId: regId, status, teamId: regTeam } });
    return { id: regId, status };
  });
}

async function findOwnRegistration(q: Queryable, tournamentId: string, user: SessionUser) {
  const rows = await q.query<{ id: string; status: string; checked_in_at: Date | null }>(
    `select r.id, r.status, r.checked_in_at from registrations r left join teams tm on tm.id = r.team_id
      where r.tournament_id = $1 and r.status in ('registered','waitlisted')
        and (r.user_id = $2 or tm.owner_id = $2 or tm.captain_id = $2)
      for update of r`,
    [tournamentId, user.id],
  );
  return rows[0] ?? null;
}

/**
 * Promotes the first waitlisted entry into a freed slot. Called from every path that removes a
 * registered entrant before the start (handoff spec, section 8, point 2).
 */
export async function promoteFromWaitlist(q: Queryable, t: { id: string; name: string; slug: string; status: string }) {
  if (!["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status)) return null;
  const [next] = await q.query<{ id: string }>(
    "select id from registrations where tournament_id = $1 and status = 'waitlisted' order by created_at asc, id asc limit 1 for update",
    [t.id],
  );
  if (!next) return null;
  await q.query("update registrations set status = 'registered' where id = $1", [next.id]);
  await notify(q, await regMembers(q, next.id), "promoted", { tournament: t.name, slug: t.slug });
  return next.id;
}

export async function withdraw(db: Database, user: SessionUser, tournamentId: string) {
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    if (!["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status)) fail("registration_closed");
    const reg = await findOwnRegistration(q, t.id, user);
    if (!reg) fail("not_registered");
    await q.query("update registrations set status = 'withdrawn', checked_in_at = null where id = $1", [reg!.id]);
    await q.query("delete from roster_entries where registration_id = $1", [reg!.id]);
    if (reg!.status === "registered") await promoteFromWaitlist(q, t);
    await audit(q, { actorId: user.id, action: "registration.withdrawn", entity: "tournament", entityId: t.id, data: { registrationId: reg!.id } });
  });
}

export async function checkIn(db: Database, user: SessionUser, tournamentId: string) {
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    if (!t.check_in_open || !["REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status)) fail("check_in_closed");
    const reg = await findOwnRegistration(q, t.id, user);
    if (!reg || reg.status !== "registered") fail("not_registered");
    if (reg!.checked_in_at) return;
    await q.query("update registrations set checked_in_at = now() where id = $1", [reg!.id]);
    await audit(q, { actorId: user.id, action: "registration.checked_in", entity: "tournament", entityId: t.id, data: { registrationId: reg!.id } });
  });
}

export async function setCheckInOpen(db: Database, user: SessionUser, tournamentId: string, open: boolean) {
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (!["REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status)) fail("invalid_transition");
    await q.query("update tournaments set check_in_open = $2, updated_at = now() where id = $1", [t.id, open]);
    if (open) {
      const regs = await q.query<{ id: string }>("select id from registrations where tournament_id = $1 and status = 'registered'", [t.id]);
      const users: string[] = [];
      for (const r of regs) users.push(...(await regLeaders(q, r.id)));
      await notify(q, users, "check_in_open", { tournament: t.name, slug: t.slug });
    }
    await audit(q, { actorId: user.id, action: open ? "tournament.check_in_opened" : "tournament.check_in_closed", entity: "tournament", entityId: t.id });
  });
}

export async function organizerCheckIn(db: Database, user: SessionUser, tournamentId: string, regId: string, checked: boolean) {
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (!["REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status)) fail("invalid_transition");
    const rows = await q.query("update registrations set checked_in_at = $3 where id = $1 and tournament_id = $2 and status = 'registered' returning id", [
      regId,
      t.id,
      checked ? new Date().toISOString() : null,
    ]);
    if (!rows.length) fail("not_found");
    await audit(q, { actorId: user.id, action: "registration.check_in_override", entity: "tournament", entityId: t.id, data: { registrationId: regId, checked } });
  });
}

export async function setSeeds(db: Database, user: SessionUser, tournamentId: string, seeds: Record<string, unknown>) {
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (!["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status)) fail("not_editable");
    for (const [regId, raw] of Object.entries(seeds)) {
      const text = String(raw ?? "").trim();
      const seed = text === "" ? null : v.intIn(text, 1, 512);
      await q.query("update registrations set seed = $3 where id = $1 and tournament_id = $2", [regId, t.id, seed]);
    }
    await audit(q, { actorId: user.id, action: "tournament.seeds_set", entity: "tournament", entityId: t.id, data: { seeds } });
  });
}

/**
 * Participants in bracket order: manual seeds first, then the available skill signal (XP earned in
 * this game by the roster), then registration order for everyone without a signal. Never random.
 */
export async function seededParticipants(q: Queryable, tournamentId: string, checkInRequired: boolean) {
  return q.query<{ id: string; seed: number | null; xp: number }>(
    `select r.id, r.seed,
            coalesce((select sum(x.amount)::int from roster_entries re join xp_events x on x.user_id = re.user_id and x.game = t.game
                       where re.registration_id = r.id), 0) as xp
       from registrations r join tournaments t on t.id = r.tournament_id
      where r.tournament_id = $1 and r.status = 'registered' ${checkInRequired ? "and r.checked_in_at is not null" : ""}
      order by r.seed asc nulls last, xp desc, r.created_at asc, r.id asc`,
    [tournamentId],
  );
}

async function lockParticipants(q: Queryable, t: TournamentRow) {
  const participants = await seededParticipants(q, t.id, t.check_in_required);
  if (participants.length < 2) fail("not_enough_participants");
  if (t.check_in_required)
    await q.query(
      "update registrations set status = 'not_checked_in' where tournament_id = $1 and status = 'registered' and checked_in_at is null",
      [t.id],
    );
  for (let i = 0; i < participants.length; i++)
    await q.query("update registrations set seed = $2 where id = $1", [participants[i].id, i + 1]);
  return participants;
}

async function startLeaderboard(q: Queryable, t: TournamentRow, user: SessionUser) {
  await lockParticipants(q, t);
  const deadline = t.submission_hours ? new Date(Date.now() + t.submission_hours * 3600_000).toISOString() : null;
  await q.query("update tournaments set started_at = now(), check_in_open = false, submission_deadline = $2 where id = $1", [t.id, deadline]);
  await notify(q, await rosterUsers(q, t.id), "tournament_started", { tournament: t.name, slug: t.slug });
  await audit(q, { actorId: user.id, action: "tournament.leaderboard_started", entity: "tournament", entityId: t.id, data: { deadline } });
}

type PlannedRow = {
  bracket: "W" | "L" | "GF";
  round: number;
  position: number;
  a: string | null;
  b: string | null;
  aVoid: boolean;
  bVoid: boolean;
  next: { bracket: "W" | "L" | "GF"; round: number; position: number; slot: "a" | "b" } | null;
  loserNext: { bracket: "W" | "L" | "GF"; round: number; position: number; slot: "a" | "b" } | null;
};

async function startBracket(q: Queryable, t: TournamentRow, user: SessionUser) {
  const participants = await lockParticipants(q, t);
  const ids = participants.map((p) => p.id);
  let planned: PlannedRow[];
  if (t.format === "double_elimination") planned = planDoubleElimination(ids).matches;
  else
    planned = planSingleElimination(ids).matches.map((m) => ({
      bracket: "W" as const,
      round: m.round,
      position: m.position,
      a: m.a,
      b: m.b,
      aVoid: false,
      bVoid: false,
      next: m.next ? { bracket: "W" as const, ...m.next } : null,
      loserNext: null,
    }));
  const uuid = new Map<string, string>();
  for (const m of planned) uuid.set(refKey(m), randomUUID());
  // Insert so that every referenced match already exists: grand final, losers (last first), winners (last first).
  const rank = { GF: 0, L: 1, W: 2 } as const;
  const ordered = [...planned].sort((a, b) => rank[a.bracket] - rank[b.bracket] || b.round - a.round || a.position - b.position);
  for (const m of ordered) {
    const both = m.bracket === "W" && m.round === 1 && m.a && m.b;
    const empty = m.aVoid && m.bVoid;
    await q.query(
      `insert into matches (id, tournament_id, bracket, round, position, a_reg, b_reg, status, outcome, a_void, b_void,
         next_match_id, next_slot, loser_next_match_id, loser_next_slot, scheduled_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        uuid.get(refKey(m)),
        t.id,
        m.bracket,
        m.round,
        m.position,
        m.a,
        m.b,
        empty ? "cancelled" : both ? "ready" : "pending",
        empty ? "bye" : null,
        m.aVoid,
        m.bVoid,
        m.next ? uuid.get(refKey(m.next)) : null,
        m.next?.slot ?? null,
        m.loserNext ? uuid.get(refKey(m.loserNext)) : null,
        m.loserNext?.slot ?? null,
        m.bracket === "W" && m.round === 1 ? new Date(t.starts_at).toISOString() : null,
      ],
    );
  }
  await q.query("update tournaments set started_at = now(), check_in_open = false where id = $1", [t.id]);
  // Byes: the present participant advances without a game; a bye has no loser to route anywhere.
  for (const m of planned.filter((m) => m.bracket === "W" && m.round === 1 && Boolean(m.a) !== Boolean(m.b))) {
    const row = await lockMatch(q, uuid.get(refKey(m))!);
    await completeMatch(q, row, { winner: (m.a ?? m.b)!, scoreA: null, scoreB: null, outcome: "bye" }, user.id);
  }
  await notify(q, await rosterUsers(q, t.id), "tournament_started", { tournament: t.name, slug: t.slug });
  const ready = await q.query<{ id: string; a_reg: string; b_reg: string }>(
    "select id, a_reg, b_reg from matches where tournament_id = $1 and status = 'ready'",
    [t.id],
  );
  for (const m of ready)
    await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "match_ready", { matchId: m.id, tournament: t.name });
}

export async function lockMatch(q: Queryable, id: string): Promise<MatchRow> {
  const [m] = await q.query<MatchRow>("select * from matches where id = $1 for update", [id]);
  if (!m) fail("not_found");
  return m;
}

export type Completion = {
  winner: string;
  scoreA: number | null;
  scoreB: number | null;
  outcome: "played" | "bye" | "walkover" | "no_show" | "disqualification" | "decision";
};

export const loserOf = (m: { a_reg: string | null; b_reg: string | null }, winner: string) =>
  winner === m.a_reg ? m.b_reg : winner === m.b_reg ? m.a_reg : null;

/** Marks a match completed and routes winner and loser. Idempotency is enforced by the status guard. */
export async function completeMatch(q: Queryable, match: MatchRow, c: Completion, actorId: string) {
  if (match.status === "completed") fail("already_completed");
  if (c.winner !== match.a_reg && c.winner !== match.b_reg) fail("invalid_input");
  await q.query(
    `update matches set winner_reg = $2, score_a = $3, score_b = $4, outcome = $5, status = 'completed',
       completed_at = now(), updated_at = now() where id = $1`,
    [match.id, c.winner, c.scoreA, c.scoreB, c.outcome],
  );
  await q.query(
    "update disputes set status = 'resolved', resolution = coalesce(nullif(resolution, ''), 'result_confirmed'), resolved_by = $2, resolved_at = now() where match_id = $1 and status = 'open' and kind = 'pre_result'",
    [match.id, actorId],
  );
  const loser = c.outcome === "bye" ? null : loserOf(match, c.winner);
  if (c.outcome === "played" || c.outcome === "decision") await matchXp(q, match, c.winner, loser);
  await advance(q, match, c.winner, loser, actorId);
}

async function matchXp(q: Queryable, match: MatchRow, winner: string, loser: string | null) {
  const [t] = await q.query<{ game: string }>("select game from tournaments where id = $1", [match.tournament_id]);
  const game = t?.game ?? "";
  await grantXp(q, await regMembers(q, winner), XP.matchWin, "match_win", game, match.id, `match:${match.id}:win`);
  if (loser) await grantXp(q, await regMembers(q, loser), XP.matchPlayed, "match_played", game, match.id, `match:${match.id}:played`);
}

async function advance(q: Queryable, match: MatchRow, winner: string, loser: string | null, actorId: string) {
  if (match.next_match_id) await placeInSlot(q, match.next_match_id, match.next_slot!, winner, actorId);
  if (match.loser_next_match_id && loser) await placeInSlot(q, match.loser_next_match_id, match.loser_next_slot!, loser, actorId);
  if (match.next_match_id) return;
  if (match.bracket === "GF" && match.round === 1 && winner !== match.a_reg) {
    await createReset(q, match);
    return;
  }
  await completeTournament(q, match.tournament_id);
}

/** The losers champion beat the undefeated winners champion: one more match decides it. */
async function createReset(q: Queryable, gf: MatchRow) {
  const id = randomUUID();
  const rows = await q.query(
    `insert into matches (id, tournament_id, bracket, round, position, a_reg, b_reg, status)
     values ($1, $2, 'GF', 2, 0, $3, $4, 'ready') on conflict (tournament_id, bracket, round, position) do nothing returning id`,
    [id, gf.tournament_id, gf.a_reg, gf.b_reg],
  );
  if (!rows.length) return;
  const [t] = await q.query<{ name: string }>("select name from tournaments where id = $1", [gf.tournament_id]);
  await notify(q, [...(await regMembers(q, gf.a_reg)), ...(await regMembers(q, gf.b_reg))], "match_ready", { matchId: id, tournament: t?.name });
}

/**
 * Puts a participant into a slot. With `replacing`, the slot must currently hold that participant:
 * used by corrections and overturned disputes. Automatic byes are re-routed transparently; any match
 * that was actually played, reported or is under way blocks the change (dependent_match_played).
 */
export async function placeInSlot(q: Queryable, matchId: string, slot: "a" | "b", reg: string, actorId: string, replacing: string | null = null) {
  const m = await lockMatch(q, matchId);
  const col = slot === "a" ? "a_reg" : "b_reg";
  if (m[col] === reg) return;
  if (replacing) {
    if (m[col] !== replacing) fail("dependent_match_played");
    const autoBye = m.status === "completed" && m.outcome === "bye" && (m.a_void || m.b_void);
    if (autoBye) {
      await q.query(`update matches set ${col} = $2, winner_reg = $2, updated_at = now() where id = $1`, [m.id, reg]);
      if (m.next_match_id) await placeInSlot(q, m.next_match_id, m.next_slot!, reg, actorId, replacing);
      return;
    }
    if (!["pending", "ready"].includes(m.status)) fail("dependent_match_played");
    const [results] = await q.query<{ n: number }>("select count(*)::int as n from match_results where match_id = $1", [m.id]);
    if ((results?.n ?? 0) > 0) fail("dependent_match_played");
  } else {
    if (m[col]) fail("dependent_match_played");
    if (!["pending", "ready"].includes(m.status)) fail("dependent_match_played");
  }
  await q.query(`update matches set ${col} = $2, ${slot}_checked_in_at = null, updated_at = now() where id = $1`, [m.id, reg]);
  const updated = { ...m, [col]: reg } as MatchRow;
  const otherVoid = slot === "a" ? m.b_void : m.a_void;
  if (otherVoid) {
    const [dq] = await q.query("select 1 from registrations where id = $1 and status = 'disqualified'", [reg]);
    if (dq) {
      // A disqualified entrant alone opposite an empty slot advances no one.
      await q.query("update matches set status = 'cancelled', outcome = 'disqualification', updated_at = now() where id = $1", [m.id]);
      if (m.next_match_id) await voidSlot(q, m.next_match_id, m.next_slot!, actorId);
      return;
    }
    await completeMatch(q, { ...updated, status: "pending" }, { winner: reg, scoreA: null, scoreB: null, outcome: "bye" }, actorId);
    return;
  }
  if (updated.a_reg && updated.b_reg) {
    await q.query("update matches set status = 'ready', updated_at = now() where id = $1 and status = 'pending'", [m.id]);
    const disq = await q.query<{ id: string }>("select id from registrations where id = any($1) and status = 'disqualified'", [[updated.a_reg, updated.b_reg]]);
    if (disq.length === 1) {
      const w = disq[0].id === updated.a_reg ? updated.b_reg! : updated.a_reg!;
      await completeMatch(q, { ...updated, status: "ready" }, { winner: w, scoreA: null, scoreB: null, outcome: "disqualification" }, actorId);
      return;
    }
    const [t] = await q.query<{ name: string }>("select name from tournaments where id = $1", [m.tournament_id]);
    await notify(q, [...(await regMembers(q, updated.a_reg)), ...(await regMembers(q, updated.b_reg))], "match_ready", {
      matchId: m.id,
      tournament: t?.name,
    });
  }
}

/** Marks a slot as permanently empty and lets whoever sits opposite advance. */
async function voidSlot(q: Queryable, matchId: string, slot: "a" | "b", actorId: string) {
  const m = await lockMatch(q, matchId);
  await q.query(`update matches set ${slot}_void = true, updated_at = now() where id = $1`, [m.id]);
  const other = slot === "a" ? m.b_reg : m.a_reg;
  const otherVoid = slot === "a" ? m.b_void : m.a_void;
  if (other && ["pending", "ready"].includes(m.status)) {
    await completeMatch(q, { ...m, status: "pending" }, { winner: other, scoreA: null, scoreB: null, outcome: "bye" }, actorId);
  } else if (otherVoid) {
    await q.query("update matches set status = 'cancelled', outcome = 'bye', updated_at = now() where id = $1", [m.id]);
    if (m.next_match_id) await voidSlot(q, m.next_match_id, m.next_slot!, actorId);
  }
}

/**
 * Final placements. Bracket formats rank by elimination stage (later elimination ranks higher; entrants
 * eliminated at the same stage share a place). Leaderboards use their standings.
 */
export async function computePlacements(q: Queryable, tournamentId: string) {
  const [t] = await q.query<{ format: Format }>("select format from tournaments where id = $1", [tournamentId]);
  if (!t || t.format === "leaderboard") return;
  const matches = await q.query<MatchRow>("select * from matches where tournament_id = $1 order by bracket, round, position", [tournamentId]);
  if (!matches.length) return;
  await q.query("update registrations set placement = null where tournament_id = $1", [tournamentId]);
  const stage = new Map<string, number>();
  let champion: string | null = null;
  if (t.format === "single_elimination") {
    const rounds = Math.max(...matches.map((m) => m.round));
    for (const m of matches) {
      if (m.status !== "completed" || !m.winner_reg || m.outcome === "bye") continue;
      const loser = loserOf(m, m.winner_reg);
      if (loser) stage.set(loser, m.round);
      if (m.round === rounds) champion = m.winner_reg;
    }
  } else {
    const lRounds = Math.max(0, ...matches.filter((m) => m.bracket === "L").map((m) => m.round));
    const gf = matches.find((m) => m.bracket === "GF" && m.round === 1);
    const reset = matches.find((m) => m.bracket === "GF" && m.round === 2);
    for (const m of matches) {
      if (m.status !== "completed" || !m.winner_reg || m.outcome === "bye" || m.bracket === "W") continue;
      if (m.bracket === "GF") continue;
      const loser = loserOf(m, m.winner_reg);
      if (loser) stage.set(loser, deStage("L", m.round, lRounds));
    }
    const final = reset?.status === "completed" ? reset : gf?.status === "completed" && gf.winner_reg === gf.a_reg ? gf : null;
    if (final?.winner_reg) {
      champion = final.winner_reg;
      const runnerUp = loserOf(final, final.winner_reg);
      if (runnerUp) stage.set(runnerUp, deStage("GF", 1, lRounds));
    }
  }
  if (!champion) return;
  stage.delete(champion);
  await q.query("update registrations set placement = 1 where id = $1", [champion]);
  const entries = [...stage.entries()];
  for (const [reg, s] of entries) {
    const better = entries.filter(([, other]) => other > s).length;
    await q.query("update registrations set placement = $2 where id = $1", [reg, better + 2]);
  }
}

/** Completes a bracket tournament (or re-settles it after a correction of its deciding match). */
export async function completeTournament(q: Queryable, tournamentId: string) {
  await computePlacements(q, tournamentId);
  const [before] = await q.query<{ status: string }>("select status from tournaments where id = $1", [tournamentId]);
  const [t] = await q.query<{ name: string; slug: string }>(
    "update tournaments set status = 'COMPLETED', completed_at = coalesce(completed_at, now()), updated_at = now() where id = $1 returning name, slug",
    [tournamentId],
  );
  await settleTournament(q, tournamentId);
  if (before?.status !== "COMPLETED") {
    await notify(q, await rosterUsers(q, tournamentId), "tournament_completed", { tournament: t?.name, slug: t?.slug });
    await audit(q, { actorId: null, action: "tournament.completed", entity: "tournament", entityId: tournamentId });
  }
}

/** Placement XP and the champion award. Both are idempotent, so re-settling after a correction is safe. */
export async function settleTournament(q: Queryable, tournamentId: string) {
  const [t] = await q.query<{ game: string }>("select game from tournaments where id = $1", [tournamentId]);
  const placed = await q.query<{ id: string; placement: number }>(
    "select id, placement from registrations where tournament_id = $1 and placement is not null",
    [tournamentId],
  );
  for (const r of placed) {
    const amount = r.placement === 1 ? XP.place1 : r.placement === 2 ? XP.place2 : r.placement === 3 ? XP.place3 : XP.participation;
    await grantXp(q, await regMembers(q, r.id), amount, "tournament_placement", t?.game ?? "", tournamentId, `tournament:${tournamentId}:${r.id}:placement`);
  }
  // A leaderboard can end in an exact tie for first: every co-champion is paid once.
  for (const champion of placed.filter((r) => r.placement === 1)) await settleChampionAward(q, tournamentId, champion.id);
}

export async function disqualify(db: Database, user: SessionUser, tournamentId: string, regId: string, reasonInput: unknown) {
  const reason = v.oneLine(reasonInput, 300);
  if (!reason) fail("invalid_input");
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    const [reg] = await q.query<{ id: string; status: string }>(
      "select id, status from registrations where id = $1 and tournament_id = $2 for update",
      [regId, t.id],
    );
    if (!reg || !["registered", "waitlisted"].includes(reg.status)) fail("not_found");
    await q.query("update registrations set status = 'disqualified' where id = $1", [reg.id]);
    // Removing a registered entrant before the start frees a slot for the waitlist.
    if (reg.status === "registered") await promoteFromWaitlist(q, t);
    if ((t.status === "IN_PROGRESS" || t.status === "PAUSED") && isBracketFormat(t.format)) {
      const [open] = await q.query<MatchRow>(
        `select * from matches where tournament_id = $1 and (a_reg = $2 or b_reg = $2)
           and status in ('ready','in_progress','result_submitted','disputed') for update`,
        [t.id, reg.id],
      );
      if (open) {
        const winner = open.a_reg === reg.id ? open.b_reg! : open.a_reg!;
        await q.query("update match_results set status = 'superseded' where match_id = $1 and status = 'pending'", [open.id]);
        await completeMatch(q, open, { winner, scoreA: null, scoreB: null, outcome: "disqualification" }, user.id);
      }
      // Double elimination: a disqualified entrant waiting in the losers bracket forfeits that slot too.
      const waiting = await q.query<MatchRow>(
        `select * from matches where tournament_id = $1 and status = 'pending' and (a_reg = $2 or b_reg = $2) for update`,
        [t.id, reg.id],
      );
      for (const w of waiting) {
        const slot = w.a_reg === reg.id ? "a" : "b";
        const otherVoid = slot === "a" ? w.b_void : w.a_void;
        if (otherVoid) {
          await q.query("update matches set status = 'cancelled', outcome = 'disqualification', updated_at = now() where id = $1", [w.id]);
          if (w.next_match_id) await voidSlot(q, w.next_match_id, w.next_slot!, user.id);
        }
      }
    }
    await notify(q, await regMembers(q, reg.id), "disqualified", { tournament: t.name, slug: t.slug, reason });
    await audit(q, { actorId: user.id, action: "registration.disqualified", entity: "tournament", entityId: t.id, data: { registrationId: reg.id, reason } });
  });
}

export async function addCoOrganizer(db: Database, user: SessionUser, tournamentId: string, usernameInput: unknown) {
  const username = v.username(usernameInput);
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requirePrimary(q, t, user);
    const [target] = await q.query<{ id: string }>("select id from users where username = $1 and status = 'active'", [username]);
    if (!target) fail("not_found");
    if (target.id === t.created_by) fail("cannot_modify_self");
    await q.query(
      "insert into tournament_organizers (tournament_id, user_id, added_by) values ($1, $2, $3) on conflict do nothing",
      [t.id, target.id, user.id],
    );
    await notify(q, [target.id], "co_organizer", { tournament: t.name, slug: t.slug });
    await audit(q, { actorId: user.id, action: "tournament.co_organizer_added", entity: "tournament", entityId: t.id, data: { userId: target.id } });
  });
}

export async function removeCoOrganizer(db: Database, user: SessionUser, tournamentId: string, memberId: string) {
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requirePrimary(q, t, user);
    const rows = await q.query("delete from tournament_organizers where tournament_id = $1 and user_id = $2 returning user_id", [t.id, memberId]);
    if (!rows.length) fail("not_found");
    await audit(q, { actorId: user.id, action: "tournament.co_organizer_removed", entity: "tournament", entityId: t.id, data: { userId: memberId } });
  });
}

/**
 * Only the primary organiser (the creator), the space's owners and admins, or platform admins manage the
 * co-organiser list. A co-organiser cannot change it — including removing whoever granted access.
 */
async function requirePrimary(q: Queryable, t: TournamentRow, user: SessionUser) {
  if (t.created_by === user.id || isAdmin(user)) return;
  if (await canManageOrg(q, t.org_id, user)) return;
  fail("forbidden");
}

/** Match-level check-in: informational, never a gate — the organiser still decides no-shows. */
export async function matchCheckIn(db: Database, user: SessionUser, matchId: string) {
  await db.tx(async (q) => {
    const m = await lockMatch(q, matchId);
    const [t] = await q.query<{ status: string }>("select status from tournaments where id = $1", [m.tournament_id]);
    if (t?.status !== "IN_PROGRESS") fail("tournament_not_live");
    if (!m.a_reg || !m.b_reg || !["ready", "in_progress"].includes(m.status)) fail("match_not_ready");
    const side = (await regLeaders(q, m.a_reg)).includes(user.id) ? "a" : (await regLeaders(q, m.b_reg)).includes(user.id) ? "b" : null;
    if (!side) fail("not_participant");
    await q.query(`update matches set ${side}_checked_in_at = coalesce(${side}_checked_in_at, now()), updated_at = now() where id = $1`, [m.id]);
    await audit(q, { actorId: user.id, action: "match.checked_in", entity: "match", entityId: m.id, data: { side } });
  });
}

export async function setPrizeCoins(db: Database, user: SessionUser, tournamentId: string, coinsInput: unknown) {
  if (!isAdmin(user)) fail("forbidden");
  const coins = v.intIn(coinsInput, 0, 100000);
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    if (["COMPLETED", "CANCELLED", "ARCHIVED"].includes(t.status)) fail("not_editable");
    await q.query("update tournaments set prize_coins = $2, updated_at = now() where id = $1", [t.id, coins]);
    await audit(q, { actorId: user.id, action: "tournament.prize_coins_set", entity: "tournament", entityId: t.id, data: { coins } });
  });
}

export { canReferee };
