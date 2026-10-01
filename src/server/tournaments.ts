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
import {
  editableSettings,
  GAUNTLET_MAX,
  isRoundFormat,
  parseFormatSettings,
  roundTime,
  RR_MAX_ENTRANTS,
  settingsOf,
  type FormatSettings,
  type FormatSettingsInput,
} from "./format-settings.ts";
import { planGauntlet } from "./stages.ts";
import { fieldsOf, parseAnswers, parseRegistrationFields, type RegField } from "./registration.ts";
import { ffaPlanConverges, ffaSettingsOf, parseFfaSettings, type FfaSettings, type FfaSettingsInput } from "./ffa.ts";
import { checkCircuitEligibility, validateCircuitLink, type CircuitLinkInput } from "./circuits.ts";
import { parseSeriesRules, seriesCustomised, seriesRulesOf, type SeriesRules } from "./series.ts";
import { admissionOf, checkAdmission, parseAdmission, type Admission, type AdmissionInput } from "./admission.ts";
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

export const FORMATS = ["single_elimination", "double_elimination", "round_robin", "swiss", "groups", "gauntlet", "ffa", "leaderboard"] as const;
export type Format = (typeof FORMATS)[number];
/** Formats played as one bracket from the start: single and double elimination, and the gauntlet (stepladder). */
export const isBracketFormat = (f: string) => f === "single_elimination" || f === "double_elimination" || f === "gauntlet";
/** Formats played as head-to-head matches: elimination brackets, round robin and Swiss. */
export const isMatchFormat = (f: string) => isBracketFormat(f) || isRoundFormat(f);
/** Matches of round robin and groups (RR) and Swiss (SW): no bracket routing, the table decides. */
export const isRoundBracket = (b: string) => b === "RR" || b === "SW";
export { isRoundFormat };

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
  format_settings: FormatSettings | null;
  circuit_id: string | null;
  circuit_division: number | null;
  circuit_weight: number;
  qualifier_circuit_id: string | null;
  /** 1 = main stage; 2 = the playoff that follows it. */
  stage: number;
  /** Organiser-defined registration questions (frozen after the first registration). */
  registration_fields: RegField[] | null;
  /** Applications wait for the organiser's decision ("pending") instead of entering at once. */
  approval_required: boolean;
  registration_closes_at: Date | null;
  /** Team leaders edit their event roster until this moment (and never after the start). */
  roster_locks_at: Date | null;
  /** A no-show can be recorded only this many minutes after the scheduled time (null = any time). */
  no_show_minutes: number | null;
  template_id: string | null;
  /** Series length and points by level (MV-SERIES-1); null = best of 1 and the format's points. */
  series_rules: unknown;
  /** Admission criteria every player of an entry must meet; null = none. */
  admission: unknown;
  /** Expected length of one match, for the schedule and its conflicts (null = 60 minutes). */
  match_minutes: number | null;
};

export type MatchRow = {
  id: string;
  tournament_id: string;
  bracket: "W" | "L" | "GF" | "RR" | "SW" | "G";
  stage: number;
  group_no: number;
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
  /** Set while a referee holds the match (C-03); results, confirmations, check-ins and no-shows wait. */
  paused_at?: Date | null;
  pause_reason?: string;
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

export async function requireManager(q: Queryable, t: TournamentRow, user: SessionUser) {
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
  /** Settings of round formats and of FFA; undefined keeps the stored settings on update. */
  settings?: FormatSettingsInput & FfaSettingsInput;
  /** Circuit link; undefined keeps the stored link on update. */
  circuit?: CircuitLinkInput;
  /** Registration rules; undefined keeps the stored rules on update. */
  registration?: RegistrationInput;
  /** Series length and points by level; undefined keeps the stored rules on update. */
  series?: Record<string, unknown>;
  /** Admission criteria; undefined keeps the stored criteria on update. */
  admission?: AdmissionInput;
  /** Expected match length in minutes (10–600, empty = 60); undefined keeps the stored value. */
  matchMinutes?: unknown;
};

export type RegistrationInput = {
  approvalRequired?: unknown;
  registrationClosesAt?: unknown;
  rosterLocksAt?: unknown;
  noShowMinutes?: unknown;
  /** Raw field rows: field1Label, field1Type, field1Options, field1Required … */
  fields?: Record<string, unknown>;
};

export type RegistrationRules = {
  approvalRequired: boolean;
  registrationClosesAt: Date | null;
  rosterLocksAt: Date | null;
  noShowMinutes: number | null;
  fields: RegField[];
};

const optionalDate = (value: unknown, timeZone: unknown) => (String(value ?? "").trim() ? v.zonedToUtc(value, timeZone) : null);

function parseRegistration(input: RegistrationInput, timeZone: unknown, startsAt: Date): RegistrationRules {
  const registrationClosesAt = optionalDate(input.registrationClosesAt, timeZone);
  const rosterLocksAt = optionalDate(input.rosterLocksAt, timeZone);
  // Both deadlines must fall before the start; the roster lock never before registration closes.
  if (registrationClosesAt && registrationClosesAt.getTime() > startsAt.getTime()) fail("invalid_date");
  if (rosterLocksAt && rosterLocksAt.getTime() > startsAt.getTime()) fail("invalid_date");
  if (registrationClosesAt && rosterLocksAt && rosterLocksAt.getTime() < registrationClosesAt.getTime()) fail("invalid_date");
  return {
    approvalRequired: v.bool(input.approvalRequired),
    registrationClosesAt,
    rosterLocksAt,
    noShowMinutes: optionalInt(input.noShowMinutes, 0, 240),
    fields: parseRegistrationFields(input.fields ?? {}),
  };
}

const storedRegistration = (t: TournamentRow): RegistrationRules => ({
  approvalRequired: t.approval_required,
  registrationClosesAt: t.registration_closes_at ? new Date(t.registration_closes_at) : null,
  rosterLocksAt: t.roster_locks_at ? new Date(t.roster_locks_at) : null,
  noShowMinutes: t.no_show_minutes,
  fields: fieldsOf(t),
});

const fieldsJson = (fields: RegField[]) => (fields.length ? JSON.stringify(fields) : null);

/** Series rules apply to formats played as head-to-head matches; anything else stores none. */
function seriesFor(format: string, input: Record<string, unknown> | undefined, stored: SeriesRules | null): SeriesRules | null {
  if (!isMatchFormat(format)) return null;
  const rules = input ? parseSeriesRules(input, format) : stored;
  return rules && seriesCustomised(rules) ? rules : null;
}

const jsonOrNull = (value: object | null) => (value ? JSON.stringify(value) : null);

/** Settings added in release 6, written after the main insert or update in the same transaction. */
async function saveExtras(q: Queryable, id: string, extras: { series: SeriesRules | null; admission: Admission | null; matchMinutes: number | null }) {
  await q.query("update tournaments set series_rules = $2, admission = $3, match_minutes = $4 where id = $1", [
    id,
    jsonOrNull(extras.series),
    jsonOrNull(extras.admission),
    extras.matchMinutes,
  ]);
}

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
  if (isMatchFormat(format) && !game!.bracket) fail("format_not_supported");
  const participantType = input.participantType === "team" ? "team" : input.participantType === "solo" ? "solo" : fail("invalid_input");
  const teamSize = participantType === "solo" ? 1 : v.intIn(input.teamSize || game!.teamSize, 2, 10);
  const leaderboard = format === "leaderboard";
  const maxParticipants = v.intIn(input.maxParticipants, 2, 512);
  if (format === "round_robin" && maxParticipants > RR_MAX_ENTRANTS) fail("round_robin_limit");
  if (format === "gauntlet" && maxParticipants > GAUNTLET_MAX) fail("gauntlet_limit");
  return {
    name,
    format,
    game: game!.slug,
    participantType,
    teamSize,
    maxParticipants,
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
    formatSettings: input.settings === undefined ? undefined : format === "ffa" ? parseFfaSettings(input.settings) : parseFormatSettings(format, input.settings),
  };
}

/** Groups are round robins of 2–32 entrants each, with at least as many entrants as advance from each. */
function checkGroupCapacity(format: string, maxParticipants: number, settings: object | null) {
  const groups = (settings as FormatSettings | null)?.groups;
  if (format !== "groups" || !groups) return;
  const { count, advance } = groups;
  if (maxParticipants > count * RR_MAX_ENTRANTS) fail("round_robin_limit");
  if (maxParticipants < count * Math.max(2, advance)) fail("stage_too_few");
}

const settingsJson = (s: object | null) => (s ? JSON.stringify(s) : null);

/** FFA: the lobbies must reach a single final lobby within the round limit for this many entrants. */
export function checkFfaPlan(format: string, entrants: number, settings: object | null) {
  if (format === "ffa" && settings && !ffaPlanConverges(entrants, settings as FfaSettings)) fail("invalid_ffa_settings");
}

/** The organiser's format settings before the start, for every format that has them (what a copy carries). */
export function editableFormatSettings(t: { format: string; format_settings?: unknown }): object | null {
  if (t.format === "ffa") return ffaSettingsOf(t);
  return editableSettings(t);
}

/** Default settings of a format when the organiser gave none. */
const defaultSettings = (format: string): object | null => (format === "ffa" ? parseFfaSettings({}) : parseFormatSettings(format, {}));

export async function createTournament(db: Database, user: SessionUser, orgId: string, input: TournamentInput) {
  const data = parseInput(input);
  const settings = data.formatSettings ?? defaultSettings(data.format);
  checkGroupCapacity(data.format, data.maxParticipants, settings);
  checkFfaPlan(data.format, data.maxParticipants, settings);
  const reg = parseRegistration(input.registration ?? {}, input.timeZone, data.startsAt);
  const extras = {
    series: seriesFor(data.format, input.series, null),
    admission: input.admission ? parseAdmission(input.admission) : null,
    matchMinutes: optionalInt(input.matchMinutes, 10, 600),
  };
  return db.tx(async (q) => {
    if (!(await canManageOrg(q, orgId, user))) fail("forbidden");
    const link = await validateCircuitLink(q, { orgId, game: data.game, participantType: data.participantType, format: data.format }, input.circuit ?? {});
    const slug = await uniqueSlug(q, "tournaments", data.name);
    const [t] = await q.query<{ id: string; slug: string }>(
      `insert into tournaments (slug, org_id, name, game, format, participant_type, team_size, max_participants,
         check_in_required, region, region_lock, starts_at, description, rules, best_of, submission_hours, scoring,
         prize_text, livestream_url, created_by, format_settings, circuit_id, circuit_division, circuit_weight, qualifier_circuit_id,
         registration_fields, approval_required, registration_closes_at, roster_locks_at, no_show_minutes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30) returning id, slug`,
      [slug, orgId, data.name, data.game, data.format, data.participantType, data.teamSize, data.maxParticipants, data.checkInRequired,
        data.region, data.regionLock, data.startsAt.toISOString(), data.description, data.rules, data.bestOf, data.submissionHours,
        data.scoring ? JSON.stringify(data.scoring) : null, data.prizeText, data.livestreamUrl, user.id, settingsJson(settings),
        link.circuitId, link.circuitDivision, link.circuitWeight, link.qualifierCircuitId,
        fieldsJson(reg.fields), reg.approvalRequired, reg.registrationClosesAt?.toISOString() ?? null, reg.rosterLocksAt?.toISOString() ?? null,
        reg.noShowMinutes],
    );
    await saveExtras(q, t.id, extras);
    await audit(q, {
      actorId: user.id,
      action: "tournament.created",
      entity: "tournament",
      entityId: t.id,
      data: { name: data.name, game: data.game, format: data.format, settings, circuit: link.circuitId, qualifier: link.qualifierCircuitId, registration: reg, ...extras },
    });
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
      "select count(*)::int as n, count(*) filter (where status = 'registered')::int as active from registrations where tournament_id = $1 and status not in ('withdrawn','rejected')",
      [t.id],
    );
    const reg = input.registration ? parseRegistration(input.registration, input.timeZone, data.startsAt) : storedRegistration(t);
    // Answers are keyed by question: the questions are frozen once anyone has applied.
    if ((count?.n ?? 0) > 0 && JSON.stringify(reg.fields) !== JSON.stringify(fieldsOf(t))) fail("not_editable");
    // Admission criteria apply to everyone alike: frozen once anyone has applied.
    const admission = input.admission !== undefined ? parseAdmission(input.admission) : admissionOf(t);
    if ((count?.n ?? 0) > 0 && JSON.stringify(admission) !== JSON.stringify(admissionOf(t))) fail("not_editable");
    const storedSeries = t.series_rules ? seriesRulesOf(t) : null;
    const extras = {
      series: seriesFor(data.format, input.series, data.format === t.format ? storedSeries : null),
      admission,
      matchMinutes: input.matchMinutes !== undefined ? optionalInt(input.matchMinutes, 10, 600) : t.match_minutes,
    };
    const link = await validateCircuitLink(
      q,
      { orgId: t.org_id, game: data.game, participantType: data.participantType, format: data.format },
      input.circuit ?? { circuitId: t.circuit_id, circuitDivision: t.circuit_division, circuitWeight: t.circuit_weight, qualifierCircuitId: t.qualifier_circuit_id },
    );
    const settings = data.formatSettings !== undefined ? data.formatSettings : data.format === t.format ? editableFormatSettings(t) : defaultSettings(data.format);
    checkGroupCapacity(data.format, data.maxParticipants, settings);
    checkFfaPlan(data.format, data.maxParticipants, settings);
    // Who may enter depends on the game, the entry type, the format and the circuit rules: frozen once anyone registered.
    const structural =
      data.game !== t.game ||
      data.participantType !== t.participant_type ||
      data.teamSize !== t.team_size ||
      data.format !== t.format ||
      link.circuitId !== t.circuit_id ||
      link.circuitDivision !== t.circuit_division ||
      link.qualifierCircuitId !== t.qualifier_circuit_id;
    if (structural && (count?.n ?? 0) > 0) fail("not_editable");
    if (data.maxParticipants < (count?.active ?? 0)) fail("invalid_input");
    await q.query(
      `update tournaments set name=$2, game=$3, format=$4, participant_type=$5, team_size=$6, max_participants=$7,
         check_in_required=$8, region=$9, region_lock=$10, starts_at=$11, description=$12, rules=$13, best_of=$14,
         submission_hours=$15, scoring=$16, prize_text=$17, livestream_url=$18, format_settings=$19, circuit_id=$20,
         circuit_division=$21, circuit_weight=$22, qualifier_circuit_id=$23, registration_fields=$24, approval_required=$25,
         registration_closes_at=$26, roster_locks_at=$27, no_show_minutes=$28, updated_at=now() where id=$1`,
      [t.id, data.name, data.game, data.format, data.participantType, data.teamSize, data.maxParticipants, data.checkInRequired,
        data.region, data.regionLock, data.startsAt.toISOString(), data.description, data.rules, data.bestOf, data.submissionHours,
        data.scoring ? JSON.stringify(data.scoring) : null, data.prizeText, data.livestreamUrl, settingsJson(settings),
        link.circuitId, link.circuitDivision, link.circuitWeight, link.qualifierCircuitId, fieldsJson(reg.fields), reg.approvalRequired,
        reg.registrationClosesAt?.toISOString() ?? null, reg.rosterLocksAt?.toISOString() ?? null, reg.noShowMinutes],
    );
    await saveExtras(q, t.id, extras);
    const settingsChanged = JSON.stringify(settings) !== JSON.stringify(editableFormatSettings(t));
    const registrationChanged = JSON.stringify(reg) !== JSON.stringify(storedRegistration(t));
    const extrasChanged =
      JSON.stringify(extras.series) !== JSON.stringify(storedSeries) ||
      JSON.stringify(extras.admission) !== JSON.stringify(admissionOf(t)) ||
      extras.matchMinutes !== t.match_minutes;
    await audit(q, {
      actorId: user.id,
      action: "tournament.updated",
      entity: "tournament",
      entityId: t.id,
      data:
        settingsChanged || registrationChanged || extrasChanged || link.circuitWeight !== t.circuit_weight
          ? { settings, circuitWeight: link.circuitWeight, ...(registrationChanged ? { registration: reg } : {}), ...(extrasChanged ? extras : {}) }
          : undefined,
    });
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
      else if (t.format === "ffa") {
        const participants = await lockParticipants(q, t);
        checkFfaPlan(t.format, participants.length, ffaSettingsOf(t));
        const { startFfa } = await import("./lobbies.ts");
        await startFfa(q, t, participants, user.id);
      } else if (isRoundFormat(t.format)) await startRounds(q, t, user);
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
export async function checkRegion(q: Queryable, t: TournamentRow, roster: string[]) {
  if (!t.region_lock?.length) return;
  const rows = await q.query<{ id: string; country_code: string | null }>("select id, country_code from users where id = any($1)", [roster]);
  if (rows.some((r) => !r.country_code)) fail("country_required");
  if (rows.some((r) => !t.region_lock.includes(r.country_code!))) fail("region_locked");
}

/** Registration is open in REGISTRATION_OPEN until the organiser's deadline, if one is set. */
export const registrationOpen = (t: { status: string; registration_closes_at: Date | string | null }, now = Date.now()) =>
  t.status === "REGISTRATION_OPEN" && (!t.registration_closes_at || new Date(t.registration_closes_at).getTime() > now);

export async function register(db: Database, user: SessionUser, tournamentId: string, teamId?: string, answersInput: Record<string, unknown> = {}) {
  return db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    if (!registrationOpen(t)) fail("registration_closed");
    const answers = parseAnswers(fieldsOf(t), answersInput);
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
    await checkAdmission(q, t, roster);
    if (t.circuit_id || t.qualifier_circuit_id) await checkCircuitEligibility(q, t, { userId: regUser, teamId: regTeam });
    const [active] = await q.query<{ n: number }>(
      "select count(*)::int as n from registrations where tournament_id = $1 and status = 'registered'",
      [t.id],
    );
    // With approval, an application waits for the organiser; capacity is applied when it is approved.
    const status = t.approval_required ? "pending" : (active?.n ?? 0) >= t.max_participants ? "waitlisted" : "registered";
    let regId: string;
    try {
      const [reg] = await q.query<{ id: string }>(
        `insert into registrations (tournament_id, user_id, team_id, registered_by, status, answers)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [t.id, regUser, regTeam, user.id, status, answers ? JSON.stringify(answers) : null],
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
    if (status === "pending") {
      await notify(q, roster, "registration_received", { tournament: t.name, slug: t.slug });
      await notify(q, await managersOf(q, t), "registration_pending", { tournament: t.name, slug: t.slug });
    } else await notify(q, roster, status === "registered" ? "registered" : "waitlisted", { tournament: t.name, slug: t.slug });
    await audit(q, { actorId: user.id, action: "registration.created", entity: "tournament", entityId: t.id, data: { registrationId: regId, status, teamId: regTeam } });
    return { id: regId, status };
  });
}

async function findOwnRegistration(q: Queryable, tournamentId: string, user: SessionUser) {
  const rows = await q.query<{ id: string; status: string; checked_in_at: Date | null }>(
    `select r.id, r.status, r.checked_in_at from registrations r left join teams tm on tm.id = r.team_id
      where r.tournament_id = $1 and r.status in ('registered','waitlisted','pending')
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

/** The tournament's managers: owners and admins of the space and its co-organisers. */
async function managersOf(q: Queryable, t: { id: string; org_id: string }) {
  const rows = await q.query<{ user_id: string }>(
    `select user_id from org_members where org_id = $1 and role in ('owner','admin')
     union select user_id from tournament_organizers where tournament_id = $2`,
    [t.org_id, t.id],
  );
  return rows.map((r) => r.user_id);
}

/** Approves a pending application: it enters the event, or the waitlist when the event is full. */
export async function approveRegistration(db: Database, user: SessionUser, tournamentId: string, regId: string) {
  return db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (!["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status)) fail("registration_closed");
    const [reg] = await q.query<{ id: string; status: string }>("select id, status from registrations where id = $1 and tournament_id = $2 for update", [regId, t.id]);
    if (!reg || reg.status !== "pending") fail("not_found");
    const [active] = await q.query<{ n: number }>("select count(*)::int as n from registrations where tournament_id = $1 and status = 'registered'", [t.id]);
    const status = (active?.n ?? 0) >= t.max_participants ? "waitlisted" : "registered";
    await q.query("update registrations set status = $2, decided_by = $3, decided_at = now(), decision_note = '' where id = $1", [reg.id, status, user.id]);
    await notify(q, await regMembers(q, reg.id), status === "registered" ? "registration_approved" : "waitlisted", { tournament: t.name, slug: t.slug });
    await audit(q, { actorId: user.id, action: "registration.approved", entity: "tournament", entityId: t.id, data: { registrationId: reg.id, status } });
    return status;
  });
}

/** Rejects a pending application with a reason the applicant sees; the roster is released. */
export async function rejectRegistration(db: Database, user: SessionUser, tournamentId: string, regId: string, reasonInput: unknown) {
  const reason = v.oneLine(reasonInput, 300);
  if (reason.length < 5) fail("invalid_input");
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    const [reg] = await q.query<{ id: string; status: string }>("select id, status from registrations where id = $1 and tournament_id = $2 for update", [regId, t.id]);
    if (!reg || reg.status !== "pending") fail("not_found");
    const members = await regMembers(q, reg.id);
    await q.query("update registrations set status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1", [reg.id, user.id, reason]);
    await q.query("delete from roster_entries where registration_id = $1", [reg.id]);
    await notify(q, members, "registration_rejected", { tournament: t.name, slug: t.slug, reason });
    await audit(q, { actorId: user.id, action: "registration.rejected", entity: "tournament", entityId: t.id, data: { registrationId: reg.id, reason } });
  });
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

/** Applications nobody decided before the start are closed: the applicant is told, the roster released. */
async function expirePending(q: Queryable, t: TournamentRow) {
  const pending = await q.query<{ id: string }>("select id from registrations where tournament_id = $1 and status = 'pending' for update", [t.id]);
  for (const r of pending) {
    const members = await regMembers(q, r.id);
    await q.query("update registrations set status = 'rejected', decided_at = now(), decision_note = 'expired' where id = $1", [r.id]);
    await q.query("delete from roster_entries where registration_id = $1", [r.id]);
    await notify(q, members, "registration_expired", { tournament: t.name, slug: t.slug });
  }
  if (pending.length) await audit(q, { actorId: null, action: "registration.expired_at_start", entity: "tournament", entityId: t.id, data: { count: pending.length } });
}

async function lockParticipants(q: Queryable, t: TournamentRow) {
  const participants = await seededParticipants(q, t.id, t.check_in_required);
  if (participants.length < 2) fail("not_enough_participants");
  await expirePending(q, t);
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

/** Round robin and Swiss: the schedule or the first round is created from the locked seeds. */
async function startRounds(q: Queryable, t: TournamentRow, user: SessionUser) {
  const participants = await lockParticipants(q, t);
  const rounds = await import("./rounds.ts");
  if (t.format === "round_robin") await rounds.startRoundRobin(q, t, participants, user.id);
  else if (t.format === "groups") await rounds.startGroups(q, t, participants, user.id);
  else await rounds.startSwiss(q, t, participants, user.id);
}

type PlannedRow = {
  bracket: "W" | "L" | "GF" | "G";
  round: number;
  position: number;
  a: string | null;
  b: string | null;
  aVoid: boolean;
  bVoid: boolean;
  next: { bracket: "W" | "L" | "GF" | "G"; round: number; position: number; slot: "a" | "b" } | null;
  loserNext: { bracket: "W" | "L" | "GF" | "G"; round: number; position: number; slot: "a" | "b" } | null;
};

async function startBracket(q: Queryable, t: TournamentRow, user: SessionUser) {
  const participants = await lockParticipants(q, t);
  await q.query("update tournaments set started_at = now(), check_in_open = false where id = $1", [t.id]);
  await buildBracket(q, t, participants.map((p) => p.id), user.id);
  await notify(q, await rosterUsers(q, t.id), "tournament_started", { tournament: t.name, slug: t.slug });
  await notifyReady(q, t);
}

/** Tells both sides of every ready match that it can be played. */
export async function notifyReady(q: Queryable, t: { id: string; name: string }) {
  const ready = await q.query<{ id: string; a_reg: string; b_reg: string }>(
    "select id, a_reg, b_reg from matches where tournament_id = $1 and status = 'ready'",
    [t.id],
  );
  for (const m of ready)
    await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "match_ready", { matchId: m.id, tournament: t.name });
}

export type BracketBuild = {
  /** single_elimination, double_elimination or gauntlet; defaults to the tournament's format. */
  format?: string;
  /** 1 for a bracket tournament; 2 for the playoff after a main stage. */
  stage?: number;
  /** When the first round is scheduled; later winners rounds follow at the tournament's round interval. */
  firstRoundAt?: string | null;
  roundHours?: number;
};

/**
 * Inserts a single-elimination, double-elimination or gauntlet bracket for the seeded entrants and resolves its
 * byes. Used at the start of a bracket tournament and for the playoff after a main stage.
 */
export async function buildBracket(q: Queryable, t: TournamentRow, ids: string[], actorId: string, opts: BracketBuild = {}) {
  const format = opts.format ?? t.format;
  const stage = opts.stage ?? 1;
  const firstRoundAt = opts.firstRoundAt === undefined ? new Date(t.starts_at).toISOString() : opts.firstRoundAt;
  const hours = opts.roundHours ?? 0;
  const at = (round: number) =>
    firstRoundAt ? (hours > 0 ? new Date(new Date(firstRoundAt).getTime() + (round - 1) * hours * 3_600_000).toISOString() : round === 1 ? firstRoundAt : null) : null;
  let planned: PlannedRow[];
  if (format === "double_elimination") planned = planDoubleElimination(ids).matches;
  else if (format === "gauntlet")
    planned = planGauntlet(ids).matches.map((m) => ({
      bracket: "G" as const,
      round: m.round,
      position: 0,
      a: m.a,
      b: m.b,
      aVoid: false,
      bVoid: false,
      next: m.next ? { bracket: "G" as const, round: m.next.round, position: 0, slot: m.next.slot } : null,
      loserNext: null,
    }));
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
  const rank = { GF: 0, L: 1, W: 2, G: 2 } as const;
  const ordered = [...planned].sort((a, b) => rank[a.bracket] - rank[b.bracket] || b.round - a.round || a.position - b.position);
  for (const m of ordered) {
    const both = (m.bracket === "W" || m.bracket === "G") && m.round === 1 && m.a && m.b;
    const empty = m.aVoid && m.bVoid;
    await q.query(
      `insert into matches (id, tournament_id, bracket, round, position, a_reg, b_reg, status, outcome, a_void, b_void,
         next_match_id, next_slot, loser_next_match_id, loser_next_slot, scheduled_at, stage)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
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
        m.bracket === "W" || m.bracket === "G" ? at(m.round) : null,
        stage,
      ],
    );
  }
  // Byes: the present participant advances without a game; a bye has no loser to route anywhere.
  for (const m of planned.filter((m) => m.bracket === "W" && m.round === 1 && Boolean(m.a) !== Boolean(m.b))) {
    const row = await lockMatch(q, uuid.get(refKey(m))!);
    await completeMatch(q, row, { winner: (m.a ?? m.b)!, scoreA: null, scoreB: null, outcome: "bye" }, actorId);
  }
}

export async function lockMatch(q: Queryable, id: string): Promise<MatchRow> {
  const [m] = await q.query<MatchRow>("select * from matches where id = $1 for update", [id]);
  if (!m) fail("not_found");
  return m;
}

export type Completion = {
  /** null is a draw: round robin and Swiss only, and only when the tournament allows draws. */
  winner: string | null;
  scoreA: number | null;
  scoreB: number | null;
  outcome: "played" | "bye" | "walkover" | "no_show" | "disqualification" | "decision";
};

export const loserOf = (m: { a_reg: string | null; b_reg: string | null }, winner: string) =>
  winner === m.a_reg ? m.b_reg : winner === m.b_reg ? m.a_reg : null;

/** Marks a match completed and routes winner and loser. Idempotency is enforced by the status guard. */
export async function completeMatch(q: Queryable, match: MatchRow, c: Completion, actorId: string) {
  if (match.status === "completed") fail("already_completed");
  if (c.winner === null) {
    if (!isRoundBracket(match.bracket) || !match.a_reg || !match.b_reg || (c.outcome !== "played" && c.outcome !== "decision")) fail("draw_not_allowed");
    const [t] = await q.query<{ format: string; format_settings: unknown }>("select format, format_settings from tournaments where id = $1", [match.tournament_id]);
    if (!t || !isRoundFormat(t.format) || !settingsOf(t).allowDraws) fail("draw_not_allowed");
  } else if (c.winner !== match.a_reg && c.winner !== match.b_reg) fail("invalid_input");
  await q.query(
    `update matches set winner_reg = $2, score_a = $3, score_b = $4, outcome = $5, status = 'completed',
       completed_at = now(), updated_at = now() where id = $1`,
    [match.id, c.winner, c.scoreA, c.scoreB, c.outcome],
  );
  await q.query(
    "update disputes set status = 'resolved', resolution = coalesce(nullif(resolution, ''), 'result_confirmed'), resolved_by = $2, resolved_at = now() where match_id = $1 and status = 'open' and kind = 'pre_result'",
    [match.id, actorId],
  );
  const loser = c.outcome === "bye" || c.winner === null ? null : loserOf(match, c.winner);
  if (c.outcome === "played" || c.outcome === "decision") await matchXp(q, match, c.winner, loser);
  await advance(q, match, c.winner, loser, actorId);
}

async function matchXp(q: Queryable, match: MatchRow, winner: string | null, loser: string | null) {
  const [t] = await q.query<{ game: string }>("select game from tournaments where id = $1", [match.tournament_id]);
  const game = t?.game ?? "";
  if (winner === null) {
    // A draw: both sides played the match.
    const both = [...(await regMembers(q, match.a_reg)), ...(await regMembers(q, match.b_reg))];
    await grantXp(q, both, XP.matchPlayed, "match_played", game, match.id, `match:${match.id}:played`);
    return;
  }
  await grantXp(q, await regMembers(q, winner), XP.matchWin, "match_win", game, match.id, `match:${match.id}:win`);
  if (loser) await grantXp(q, await regMembers(q, loser), XP.matchPlayed, "match_played", game, match.id, `match:${match.id}:played`);
}

async function advance(q: Queryable, match: MatchRow, result: string | null, loser: string | null, actorId: string) {
  if (isRoundBracket(match.bracket)) {
    // Round robin and Swiss: the table decides; the next Swiss round is paired once this one is complete.
    const { afterRoundMatch } = await import("./rounds.ts");
    await afterRoundMatch(q, match.tournament_id, actorId);
    return;
  }
  const winner = result!;
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
    `insert into matches (id, tournament_id, bracket, round, position, a_reg, b_reg, status, stage)
     values ($1, $2, 'GF', 2, 0, $3, $4, 'ready', $5) on conflict (tournament_id, bracket, round, position) do nothing returning id`,
    [id, gf.tournament_id, gf.a_reg, gf.b_reg, gf.stage ?? 1],
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
 * Places inside a bracket, or null while it has no champion. Single elimination and the gauntlet rank by the
 * round of elimination (later is better; the gauntlet has one match per round, so its places are unique);
 * double elimination by losers-bracket stage, the grand final and the reset. Entrants eliminated at the same
 * stage share a place.
 */
export function bracketPlacements(format: string, matches: MatchRow[]): Map<string, number> | null {
  const stage = new Map<string, number>();
  let champion: string | null = null;
  if (format !== "double_elimination") {
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
  if (!champion) return null;
  stage.delete(champion);
  const places = new Map<string, number>([[champion, 1]]);
  const entries = [...stage.entries()];
  for (const [reg, s] of entries) places.set(reg, entries.filter(([, other]) => other > s).length + 2);
  return places;
}

/**
 * Final placements. Bracket formats rank by elimination (bracketPlacements); round formats by their table, or
 * by the playoff and then the main stage when a playoff follows; leaderboards use their standings. A
 * disqualified entrant never holds a place.
 */
export async function computePlacements(q: Queryable, tournamentId: string) {
  const [t] = await q.query<{ format: Format; format_settings: unknown }>("select format, format_settings from tournaments where id = $1", [tournamentId]);
  if (!t || t.format === "leaderboard") return;
  if (t.format === "ffa") {
    const { ffaPlacements } = await import("./lobbies.ts");
    await ffaPlacements(q, tournamentId);
    return;
  }
  if (isRoundFormat(t.format)) {
    const rounds = await import("./rounds.ts");
    if (settingsOf(t).playoff) await rounds.stagedPlacements(q, tournamentId);
    else await rounds.roundPlacements(q, tournamentId);
    return;
  }
  const matches = await q.query<MatchRow>("select * from matches where tournament_id = $1 order by bracket, round, position", [tournamentId]);
  if (!matches.length) return;
  await q.query("update registrations set placement = null where tournament_id = $1", [tournamentId]);
  const places = bracketPlacements(t.format, matches);
  if (!places) return;
  for (const [reg, place] of places) await q.query("update registrations set placement = $2 where id = $1", [reg, place]);
  await q.query("update registrations set placement = null where tournament_id = $1 and status = 'disqualified'", [tournamentId]);
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
    const running = t.status === "IN_PROGRESS" || t.status === "PAUSED";
    // During a playoff the open matches are bracket matches, whatever the main stage was.
    if (running && isRoundFormat(t.format) && t.stage === 1) {
      // Round robin: every remaining match is forfeited; Swiss: the current match, and no further pairings.
      const { forfeitOpenMatches } = await import("./rounds.ts");
      await forfeitOpenMatches(q, t.id, reg.id, user.id);
    } else if (running && (isBracketFormat(t.format) || t.stage === 2)) {
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
    if (m.paused_at) fail("match_paused");
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

/** What a copy or a template carries: everything the organiser set up, nothing that happened in the event. */
export type DraftSource = {
  org_id: string;
  name: string;
  game: string;
  format: string;
  participant_type: string;
  team_size: number;
  max_participants: number;
  check_in_required: boolean;
  region: string;
  region_lock: string[];
  description: string;
  rules: string;
  best_of: number | null;
  submission_hours: number | null;
  scoring: Record<string, number> | null;
  prize_text: string;
  livestream_url: string;
  format_settings: object | null;
  circuit_id: string | null;
  circuit_division: number | null;
  circuit_weight: number;
  qualifier_circuit_id: string | null;
  registration_fields: RegField[];
  approval_required: boolean;
  /** Deadlines as their distance before the start, in milliseconds. */
  registration_closes_before: number | null;
  roster_locks_before: number | null;
  no_show_minutes: number | null;
  /** Release 6 (absent in older templates). */
  series_rules?: SeriesRules | null;
  admission?: Admission | null;
  match_minutes?: number | null;
  venues?: Array<{ name: string; kind: string }>;
};

type FullRow = TournamentRow & { region: string; description: string; rules: string; prize_text: string; livestream_url: string };

export function draftSourceOf(src: FullRow): DraftSource {
  const before = (d: Date | null) => (d ? new Date(src.starts_at).getTime() - new Date(d).getTime() : null);
  return {
    org_id: src.org_id,
    name: src.name,
    game: src.game,
    format: src.format,
    participant_type: src.participant_type,
    team_size: src.team_size,
    max_participants: src.max_participants,
    check_in_required: src.check_in_required,
    region: src.region,
    region_lock: src.region_lock,
    description: src.description,
    rules: src.rules,
    best_of: src.best_of,
    submission_hours: src.submission_hours,
    scoring: src.scoring,
    prize_text: src.prize_text,
    livestream_url: src.livestream_url,
    format_settings: editableFormatSettings(src),
    circuit_id: src.circuit_id,
    circuit_division: src.circuit_division,
    circuit_weight: src.circuit_weight,
    qualifier_circuit_id: src.qualifier_circuit_id,
    registration_fields: fieldsOf(src),
    approval_required: src.approval_required,
    registration_closes_before: before(src.registration_closes_at),
    roster_locks_before: before(src.roster_locks_at),
    no_show_minutes: src.no_show_minutes,
    series_rules: src.series_rules ? seriesRulesOf(src) : null,
    admission: admissionOf(src),
    match_minutes: src.match_minutes,
  };
}

/** The venues of a tournament, for copies and templates. */
export async function venuesOf(q: Queryable, tournamentId: string) {
  return q.query<{ name: string; kind: string }>("select name, kind from tournament_venues where tournament_id = $1 order by created_at, name", [tournamentId]);
}

/** Inserts a draft from a copy source. The circuit link is kept only while that circuit is still active. */
export async function insertDraft(q: Queryable, user: SessionUser, src: DraftSource, name: string, startsAt: Date, templateId: string | null) {
  const [circuit] = src.circuit_id ? await q.query<{ status: string }>("select status from circuits where id = $1", [src.circuit_id]) : [];
  const keepCircuit = circuit?.status === "active";
  const slug = await uniqueSlug(q, "tournaments", name);
  const at = (before: number | null) => (before === null ? null : new Date(startsAt.getTime() - before).toISOString());
  const [t] = await q.query<{ id: string; slug: string }>(
    `insert into tournaments (slug, org_id, name, game, format, participant_type, team_size, max_participants,
       check_in_required, region, region_lock, starts_at, description, rules, best_of, submission_hours, scoring,
       prize_text, livestream_url, created_by, format_settings, circuit_id, circuit_division, circuit_weight, qualifier_circuit_id,
       registration_fields, approval_required, registration_closes_at, roster_locks_at, no_show_minutes, template_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31) returning id, slug`,
    [slug, src.org_id, name, src.game, src.format, src.participant_type, src.team_size, src.max_participants, src.check_in_required,
      src.region, src.region_lock, startsAt.toISOString(), src.description, src.rules, src.best_of, src.submission_hours,
      src.scoring ? JSON.stringify(src.scoring) : null, src.prize_text, src.livestream_url, user.id, settingsJson(src.format_settings),
      keepCircuit ? src.circuit_id : null, keepCircuit ? src.circuit_division : null, src.circuit_weight, src.qualifier_circuit_id,
      fieldsJson(src.registration_fields), src.approval_required, at(src.registration_closes_before), at(src.roster_locks_before),
      src.no_show_minutes, templateId],
  );
  await saveExtras(q, t.id, { series: src.series_rules ?? null, admission: src.admission ?? null, matchMinutes: src.match_minutes ?? null });
  for (const venue of src.venues ?? [])
    await q.query("insert into tournament_venues (tournament_id, name, kind) values ($1, $2, $3) on conflict do nothing", [t.id, venue.name, venue.kind]);
  return t;
}

/** The start of a copy: the organiser's choice, or a week after the source (never in the past). */
export function copyStart(input: { startsAt?: unknown; timeZone?: unknown }, sourceStart: Date | null) {
  return String(input.startsAt ?? "").trim()
    ? v.zonedToUtc(input.startsAt, input.timeZone)
    : new Date(Math.max(Date.now(), sourceStart ? new Date(sourceStart).getTime() : Date.now()) + 7 * 86_400_000);
}

/**
 * Copies a tournament's settings into a new draft in the same space: format and its settings, rules,
 * registration rules and questions, entry limits, region lock and circuit link (only while that circuit is
 * still active). Entrants, matches, co-organisers, sponsors and the operator-set award are never copied.
 */
export async function cloneTournament(
  db: Database,
  user: SessionUser,
  tournamentId: string,
  input: { name?: unknown; startsAt?: unknown; timeZone?: unknown },
) {
  return db.tx(async (q) => {
    const [src] = await q.query<FullRow>("select * from tournaments where id = $1", [tournamentId]);
    if (!src) fail("not_found");
    // Creating a tournament in the space is an owner/admin right, so co-organisers cannot clone.
    if (!(await canManageOrg(q, src.org_id, user))) fail("forbidden");
    const name = v.displayName(String(input.name ?? "").trim() || src.name, 80);
    const t = await insertDraft(q, user, { ...draftSourceOf(src), venues: await venuesOf(q, src.id) }, name, copyStart(input, src.starts_at), null);
    await audit(q, { actorId: user.id, action: "tournament.created", entity: "tournament", entityId: t.id, data: { name, game: src.game, format: src.format, clonedFrom: src.id } });
    await audit(q, { actorId: user.id, action: "tournament.cloned", entity: "tournament", entityId: src.id, data: { copy: t.id } });
    return t;
  });
}

/**
 * Safe regeneration (handoff spec, section 8): rebuilds the bracket, the round-robin schedule or the first
 * Swiss round from the entrants still in the event, in their seed order. It is allowed only while nothing
 * a player did would be discarded — no reported or confirmed result, no dispute, no live match, and no
 * completed match other than automatic byes and disqualification forfeits.
 */
export async function regenerateMatches(db: Database, user: SessionUser, tournamentId: string) {
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (!["IN_PROGRESS", "PAUSED"].includes(t.status) || !(isMatchFormat(t.format) || t.format === "ffa")) fail("invalid_transition");
    if (t.format === "ffa") {
      const lobbies = await import("./lobbies.ts");
      if ((await lobbies.ffaActivity(q, t.id)) > 0) fail("regeneration_blocked");
      const entrants = await q.query<{ id: string }>(
        "select id from registrations where tournament_id = $1 and status = 'registered' order by seed asc nulls last, created_at asc, id asc",
        [t.id],
      );
      if (entrants.length < 2) fail("not_enough_participants");
      for (let i = 0; i < entrants.length; i++) await q.query("update registrations set seed = $2, placement = null where id = $1", [entrants[i].id, i + 1]);
      const summary = await lobbies.regenerateFfa(q, t, entrants, user.id);
      await notify(q, await rosterUsers(q, t.id), "bracket_regenerated", { tournament: t.name, slug: t.slug });
      await audit(q, { actorId: user.id, action: "tournament.regenerated", entity: "tournament", entityId: t.id, data: { entrants: entrants.length, ...summary } });
      return;
    }
    // During the playoff only the playoff is rebuilt, from the final table of the main stage.
    const stage = t.stage === 2 ? 2 : null;
    const [state] = await q.query<{ results: number; disputes: number; blocking: number; total: number }>(
      `select (select count(*)::int from match_results r join matches m on m.id = r.match_id where m.tournament_id = $1 and ($2::int is null or m.stage = $2)) as results,
              (select count(*)::int from disputes d join matches m on m.id = d.match_id where m.tournament_id = $1 and ($2::int is null or m.stage = $2)) as disputes,
              (select count(*)::int from matches where tournament_id = $1 and ($2::int is null or stage = $2)
                  and (status in ('in_progress','result_submitted','disputed')
                       or (status = 'completed' and coalesce(outcome, '') not in ('bye','disqualification')))) as blocking,
              (select count(*)::int from matches where tournament_id = $1 and ($2::int is null or stage = $2)) as total`,
      [t.id, stage],
    );
    if ((state?.results ?? 0) + (state?.disputes ?? 0) + (state?.blocking ?? 0) > 0) fail("regeneration_blocked");
    if (stage === 2) {
      const { regeneratePlayoff } = await import("./rounds.ts");
      const summary = await regeneratePlayoff(q, t, user.id);
      await notify(q, await rosterUsers(q, t.id), "bracket_regenerated", { tournament: t.name, slug: t.slug });
      await audit(q, { actorId: user.id, action: "tournament.regenerated", entity: "tournament", entityId: t.id, data: { removedMatches: state?.total ?? 0, ...summary } });
      return;
    }
    const entrants = await q.query<{ id: string }>(
      "select id from registrations where tournament_id = $1 and status = 'registered' order by seed asc nulls last, created_at asc, id asc",
      [t.id],
    );
    if (entrants.length < 2) fail("not_enough_participants");
    // Break the links between matches first, then remove them (no result or dispute rows exist).
    await q.query("update matches set next_match_id = null, loser_next_match_id = null where tournament_id = $1", [t.id]);
    await q.query("delete from matches where tournament_id = $1", [t.id]);
    for (let i = 0; i < entrants.length; i++)
      await q.query("update registrations set seed = $2, placement = null where id = $1", [entrants[i].id, i + 1]);
    let summary: Record<string, unknown> = {};
    if (isRoundFormat(t.format)) {
      const { regenerateRounds } = await import("./rounds.ts");
      summary = await regenerateRounds(q, t, entrants, user.id);
    } else {
      await buildBracket(q, t, entrants.map((e) => e.id), user.id);
      await notifyReady(q, t);
    }
    await notify(q, await rosterUsers(q, t.id), "bracket_regenerated", { tournament: t.name, slug: t.slug });
    await audit(q, {
      actorId: user.id,
      action: "tournament.regenerated",
      entity: "tournament",
      entityId: t.id,
      data: { entrants: entrants.length, removedMatches: state?.total ?? 0, ...summary },
    });
  });
}

export { canReferee };
