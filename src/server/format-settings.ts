/**
 * Settings of tournaments played in rounds — round robin, Swiss and groups — and of the stages that follow
 * them: points table, draws, legs, rounds, disqualification rule, groups, playoff and round dates. Pure — no
 * I/O. They are validated when the organiser saves the tournament and frozen when it starts.
 */
import { fail } from "./errors.ts";
import { SWISS_MAX_ROUNDS, SWISS_VERSION } from "./swiss.ts";
import { DEFAULT_POINTS, DQ_RULES, STANDINGS_VERSION, validPoints, type DisqualificationRule, type PointsTable } from "./standings.ts";
import { RR_MAX_ENTRANTS } from "./roundrobin.ts";
import { GAUNTLET_MAX, MAX_GROUPS, PLAYOFF_FORMATS, STAGES_VERSION, type PlayoffFormat } from "./stages.ts";
import * as v from "./validate.ts";

export { RR_MAX_ENTRANTS, SWISS_MAX_ROUNDS, GAUNTLET_MAX, MAX_GROUPS };

export type RoundFormat = "round_robin" | "swiss" | "groups";
/** Formats whose main stage is played in rounds with a table: round robin, Swiss and groups of round robins. */
export const isRoundFormat = (f: string | null | undefined): f is RoundFormat => f === "round_robin" || f === "swiss" || f === "groups";
export const PLAYOFF_MAX = 64;
export const ROUND_HOURS_MAX = 720;

export type Playoff = { format: PlayoffFormat; size: number };

export type FormatSettings = {
  v: 1;
  points: PointsTable;
  allowDraws: boolean;
  /** Round robin and groups: one leg, or two (home and away). */
  legs?: 1 | 2;
  /** Round robin and groups: what a disqualification does to the entrant's results (see standings.ts). */
  disqualification?: DisqualificationRule;
  /** Swiss: requested rounds (null = automatic); replaced by the number actually played at the start. */
  rounds?: number | null;
  /** Swiss, after the start: the organiser's original request, kept so a regeneration or a clone can recompute. */
  requestedRounds?: number | null;
  /** Groups: how many groups and how many of each group advance. */
  groups?: { count: number; advance: number };
  /** A playoff after the main stage (required for groups; optional for round robin and Swiss). */
  playoff?: Playoff | null;
  /** Hours between rounds: round r is scheduled at the start + (r − 1) × hours. 0 = rounds are not scheduled. */
  roundHours?: number;
  standings: string;
  pairing?: string;
  stages?: string;
};

export type FormatSettingsInput = {
  pointsWin?: unknown;
  pointsDraw?: unknown;
  pointsLoss?: unknown;
  pointsBye?: unknown;
  allowDraws?: unknown;
  legs?: unknown;
  swissRounds?: unknown;
  dqRule?: unknown;
  groupCount?: unknown;
  groupAdvance?: unknown;
  playoffFormat?: unknown;
  playoffSize?: unknown;
  roundHours?: unknown;
};

const int = (value: unknown, fallback: number) => {
  const text = String(value ?? "").trim();
  if (text === "") return fallback;
  const n = Number(text);
  return Number.isInteger(n) ? n : Number.NaN;
};

const inRange = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

function parsePlayoff(format: RoundFormat, input: FormatSettingsInput, groups: FormatSettings["groups"]): Playoff | null {
  const chosen = String(input.playoffFormat ?? "").trim();
  // Groups always end in a playoff: without a choice it is single elimination.
  const kind = (chosen === "" || chosen === "none") && format === "groups" ? "single_elimination" : chosen;
  if (kind === "" || kind === "none") return null;
  if (!(PLAYOFF_FORMATS as readonly string[]).includes(kind)) fail("invalid_stage_settings");
  const size = format === "groups" ? groups!.count * groups!.advance : int(input.playoffSize, 8);
  if (!inRange(size, 2, PLAYOFF_MAX)) fail("invalid_stage_settings");
  if (kind === "gauntlet" && size > GAUNTLET_MAX) fail("gauntlet_limit");
  return { format: kind as PlayoffFormat, size };
}

/** Parses and validates the organiser's settings for a round-robin, Swiss or groups tournament. */
export function parseFormatSettings(format: string, input: FormatSettingsInput): FormatSettings | null {
  if (!isRoundFormat(format)) return null;
  const points: PointsTable = {
    win: int(input.pointsWin, DEFAULT_POINTS.win),
    draw: int(input.pointsDraw, DEFAULT_POINTS.draw),
    loss: int(input.pointsLoss, DEFAULT_POINTS.loss),
    bye: format === "swiss" ? int(input.pointsBye, int(input.pointsWin, DEFAULT_POINTS.win)) : 0,
  };
  if (!validPoints(points)) fail("invalid_points");
  const settings: FormatSettings = { v: 1, points, allowDraws: v.bool(input.allowDraws), standings: STANDINGS_VERSION };
  if (format === "swiss") {
    const text = String(input.swissRounds ?? "").trim();
    settings.rounds = text === "" ? null : v.intIn(text, 1, SWISS_MAX_ROUNDS);
    settings.pairing = SWISS_VERSION;
  } else {
    settings.legs = String(input.legs ?? "1") === "2" ? 2 : 1;
    const rule = String(input.dqRule ?? "").trim();
    // New tournaments annul a disqualified entrant's results unless the organiser chooses otherwise.
    settings.disqualification = rule === "" ? "annul" : (DQ_RULES as readonly string[]).includes(rule) ? (rule as DisqualificationRule) : fail("invalid_input");
  }
  if (format === "groups") {
    const count = int(input.groupCount, 4);
    const advance = int(input.groupAdvance, 2);
    if (!inRange(count, 2, MAX_GROUPS) || !inRange(advance, 1, 16)) fail("invalid_stage_settings");
    settings.groups = { count, advance };
  }
  settings.playoff = parsePlayoff(format, input, settings.groups);
  const hours = int(input.roundHours, 0);
  if (!inRange(hours, 0, ROUND_HOURS_MAX)) fail("invalid_stage_settings");
  settings.roundHours = hours;
  if (settings.playoff || settings.groups) settings.stages = STAGES_VERSION;
  return settings;
}

/** Stored settings with defaults filled in (defensive against partial JSON). */
export function settingsOf(t: { format: string; format_settings?: unknown }): FormatSettings {
  const raw = (t.format_settings ?? {}) as Partial<FormatSettings>;
  const p = raw.points ?? DEFAULT_POINTS;
  const swiss = t.format === "swiss";
  const out: FormatSettings = {
    v: 1,
    points: { win: p.win ?? 3, draw: p.draw ?? 1, loss: p.loss ?? 0, bye: swiss ? (p.bye ?? p.win ?? 3) : 0 },
    allowDraws: Boolean(raw.allowDraws),
    standings: raw.standings ?? STANDINGS_VERSION,
  };
  if (swiss) {
    out.rounds = raw.rounds ?? null;
    if (raw.requestedRounds !== undefined) out.requestedRounds = raw.requestedRounds;
    out.pairing = raw.pairing ?? SWISS_VERSION;
  } else {
    out.legs = raw.legs === 2 ? 2 : 1;
    // Settings stored before the rule existed keep the behaviour they were started with.
    out.disqualification = raw.disqualification && (DQ_RULES as readonly string[]).includes(raw.disqualification) ? raw.disqualification : "forfeit";
  }
  if (t.format === "groups") out.groups = { count: raw.groups?.count ?? 4, advance: raw.groups?.advance ?? 2 };
  if (isRoundFormat(t.format)) {
    out.playoff =
      raw.playoff && (PLAYOFF_FORMATS as readonly string[]).includes(raw.playoff.format) ? { format: raw.playoff.format, size: raw.playoff.size } : null;
    out.roundHours = inRange(Number(raw.roundHours ?? 0), 0, ROUND_HOURS_MAX) ? Number(raw.roundHours ?? 0) : 0;
    if (raw.stages) out.stages = raw.stages;
  }
  return out;
}

/** The organiser's settings before the start: what a clone copies and what the edit form shows. */
export function editableSettings(t: { format: string; format_settings?: unknown }): FormatSettings | null {
  if (!isRoundFormat(t.format)) return null;
  const { requestedRounds, ...rest } = settingsOf(t);
  if (requestedRounds !== undefined) rest.rounds = requestedRounds;
  return rest;
}

/** When round `round` is scheduled: the start plus (round − 1) × the interval, or only round 1 without one. */
export function roundTime(startsAt: Date | string, round: number, hours: number): string | null {
  const start = new Date(startsAt).getTime();
  if (hours > 0) return new Date(start + (round - 1) * hours * 3_600_000).toISOString();
  return round === 1 ? new Date(start).toISOString() : null;
}
