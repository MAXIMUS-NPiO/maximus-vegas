/**
 * Settings of tournaments played in rounds — round robin, Swiss and groups — and of the stages that follow
 * them: points table, draws, legs, rounds, disqualification rule, groups, playoff and round dates. Pure — no
 * I/O. They are validated when the organiser saves the tournament and frozen when it starts.
 */
import { fail } from "./errors.ts";
import { SWISS_MAX_ROUNDS, SWISS_VERSION } from "./swiss.ts";
import { DEFAULT_POINTS, DQ_RULES, STANDINGS_VERSION, validPoints, type DisqualificationRule, type PointsTable } from "./standings.ts";
import { RR_MAX_ENTRANTS } from "./roundrobin.ts";
import { CHAIN_VERSION, GAUNTLET_MAX, MAX_GROUPS, PLAYOFF_FORMATS, STAGES_VERSION, type PlayoffFormat } from "./stages.ts";
import * as v from "./validate.ts";

export { RR_MAX_ENTRANTS, SWISS_MAX_ROUNDS, GAUNTLET_MAX, MAX_GROUPS };

export type RoundFormat = "round_robin" | "swiss" | "groups";
/** Formats whose main stage is played in rounds with a table: round robin, Swiss and groups of round robins. */
export const isRoundFormat = (f: string | null | undefined): f is RoundFormat => f === "round_robin" || f === "swiss" || f === "groups";
export const PLAYOFF_MAX = 64;
export const ROUND_HOURS_MAX = 720;

export type Playoff = { format: PlayoffFormat; size: number };

/**
 * A further round stage between the main stage and the playoff (MV-STAGES-2): the best `size` entrants of the
 * previous stage play it (from groups: every group's qualifiers, so `size` is the groups' count × advance).
 */
export type ChainStage = {
  format: RoundFormat;
  size: number;
  /** Swiss: requested rounds (null = automatic); replaced by the rounds actually played when the stage starts. */
  rounds?: number | null;
  requestedRounds?: number | null;
  /** Groups: how many groups and how many of each advance; `count` may shrink at the start to fit the field. */
  groups?: { count: number; advance: number };
  legs?: 1 | 2;
};
export const CHAIN_MAX = 3;
export const CHAIN_SIZE_MAX = 128;

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
  /** A playoff after the last round stage (required after groups; optional after round robin and Swiss). */
  playoff?: Playoff | null;
  /** Round stages after the main stage and before the playoff (MV-STAGES-2). Absent: main stage, then playoff. */
  chain?: ChainStage[];
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
  /**
   * Intermediate stages of the form, from stage 2 up to stage CHAIN_MAX + 1: stage{k}Format, stage{k}Size,
   * stage{k}Rounds, stage{k}GroupCount, stage{k}GroupAdvance and stage{k}Legs.
   */
  [key: `stage${number}${string}`]: unknown;
};

const int = (value: unknown, fallback: number) => {
  const text = String(value ?? "").trim();
  if (text === "") return fallback;
  const n = Number(text);
  return Number.isInteger(n) ? n : Number.NaN;
};

const inRange = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

/** New tournaments annul a disqualified entrant's results unless the organiser chooses otherwise. */
const dqRuleOf = (value: unknown): DisqualificationRule => {
  const rule = String(value ?? "").trim();
  return rule === "" ? "annul" : (DQ_RULES as readonly string[]).includes(rule) ? (rule as DisqualificationRule) : fail("invalid_input");
};

/** Entrants that leave a round stage for the next one: groups pass count × advance; otherwise the next stage's size decides. */
const groupsOut = (g: { count: number; advance: number }) => g.count * g.advance;

const stageKind = (input: FormatSettingsInput, k: number) => String(input[`stage${k}Format`] ?? "").trim();

/** The intermediate stages, in order; the first empty one ends the chain, and a stage after a gap is refused. */
function parseChain(main: RoundFormat, input: FormatSettingsInput, groups: FormatSettings["groups"]): ChainStage[] {
  const chain: ChainStage[] = [];
  let k = 2;
  for (; k <= CHAIN_MAX + 1; k++) {
    const kind = stageKind(input, k);
    if (kind === "" || kind === "none") break;
    if (!isRoundFormat(kind)) return fail("invalid_stage_settings");
    const field = (name: string) => input[`stage${k}${name}`];
    const prev = chain.length ? chain[chain.length - 1] : null;
    const prevGroups = prev ? prev.groups : main === "groups" ? groups : undefined;
    const stage: ChainStage = { format: kind, size: 0 };
    if (kind === "groups") {
      const count = int(field("GroupCount"), 2);
      const advance = int(field("GroupAdvance"), 2);
      if (!inRange(count, 2, MAX_GROUPS) || !inRange(advance, 1, 16)) fail("invalid_stage_settings");
      stage.groups = { count, advance };
    }
    // After groups the field is every group's qualifiers; otherwise the organiser names it, at most the stage before.
    stage.size = prevGroups ? groupsOut(prevGroups) : int(field("Size"), 8);
    if (!inRange(stage.size, 2, CHAIN_SIZE_MAX)) fail("invalid_stage_settings");
    if (prev && !prevGroups && stage.size > prev.size) fail("invalid_stage_settings");
    if (kind === "groups" && stage.size < stage.groups!.count * Math.max(2, stage.groups!.advance)) fail("invalid_stage_settings");
    if (kind === "groups" && stage.size > stage.groups!.count * RR_MAX_ENTRANTS) fail("round_robin_limit");
    if (kind === "round_robin" && stage.size > RR_MAX_ENTRANTS) fail("round_robin_limit");
    if (kind === "swiss") {
      const text = String(field("Rounds") ?? "").trim();
      stage.rounds = text === "" ? null : v.intIn(text, 1, SWISS_MAX_ROUNDS);
    } else stage.legs = String(field("Legs") ?? "1") === "2" ? 2 : 1;
    chain.push(stage);
  }
  // A stage set after an empty one would be silently lost.
  for (let later = k + 1; later <= CHAIN_MAX + 1; later++) if (!["", "none"].includes(stageKind(input, later))) fail("invalid_stage_settings");
  return chain;
}

function parsePlayoff(format: RoundFormat, input: FormatSettingsInput, groups: FormatSettings["groups"], chain: ChainStage[]): Playoff | null {
  const last = chain.length ? chain[chain.length - 1] : null;
  const lastGroups = last ? (last.format === "groups" ? last.groups! : null) : format === "groups" ? groups! : null;
  const chosen = String(input.playoffFormat ?? "").trim();
  // A last stage of groups always ends in a playoff: without a choice it is single elimination.
  const kind = (chosen === "" || chosen === "none") && lastGroups ? "single_elimination" : chosen;
  if (kind === "" || kind === "none") return null;
  if (!(PLAYOFF_FORMATS as readonly string[]).includes(kind)) fail("invalid_stage_settings");
  const size = lastGroups ? groupsOut(lastGroups) : int(input.playoffSize, 8);
  if (!inRange(size, 2, PLAYOFF_MAX)) fail("invalid_stage_settings");
  // The playoff takes the best of the stage before it, so it cannot be larger than that stage.
  if (last && last.format !== "groups" && size > last.size) fail("invalid_stage_settings");
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
    settings.disqualification = dqRuleOf(input.dqRule);
  }
  if (format === "groups") {
    const count = int(input.groupCount, 4);
    const advance = int(input.groupAdvance, 2);
    if (!inRange(count, 2, MAX_GROUPS) || !inRange(advance, 1, 16)) fail("invalid_stage_settings");
    settings.groups = { count, advance };
  }
  const chain = parseChain(format, input, settings.groups);
  if (chain.length) settings.chain = chain;
  // A chained round robin or groups stage after a Swiss main stage follows the disqualification rule too.
  if (format === "swiss" && chain.some((c) => c.format !== "swiss")) settings.disqualification = dqRuleOf(input.dqRule);
  settings.playoff = parsePlayoff(format, input, settings.groups, chain);
  const hours = int(input.roundHours, 0);
  if (!inRange(hours, 0, ROUND_HOURS_MAX)) fail("invalid_stage_settings");
  settings.roundHours = hours;
  if (settings.playoff || settings.groups) settings.stages = STAGES_VERSION;
  if (chain.length) settings.stages = CHAIN_VERSION;
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
    // Only for the chained round robin or groups stages after it (MV-STAGES-2); a Swiss table ignores it.
    if (raw.disqualification && (DQ_RULES as readonly string[]).includes(raw.disqualification)) out.disqualification = raw.disqualification;
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
    const chain = chainOf(raw.chain);
    if (chain.length) out.chain = chain;
  }
  return out;
}

/** Stored chain stages, defensively: unknown or broken entries end the chain. */
function chainOf(raw: unknown): ChainStage[] {
  if (!Array.isArray(raw)) return [];
  const out: ChainStage[] = [];
  for (const x of raw.slice(0, CHAIN_MAX) as Array<Partial<ChainStage>>) {
    if (!x || !isRoundFormat(x.format) || !inRange(Number(x.size), 2, CHAIN_SIZE_MAX)) break;
    const stage: ChainStage = { format: x.format, size: Number(x.size) };
    if (x.format === "groups") {
      const count = Number(x.groups?.count);
      const advance = Number(x.groups?.advance);
      if (!inRange(count, 1, MAX_GROUPS) || !inRange(advance, 1, 16)) break;
      stage.groups = { count, advance };
    }
    if (x.format === "swiss") {
      stage.rounds = x.rounds ?? null;
      if (x.requestedRounds !== undefined) stage.requestedRounds = x.requestedRounds;
    } else stage.legs = x.legs === 2 ? 2 : 1;
    out.push(stage);
  }
  return out;
}

/** The organiser's settings before the start: what a clone copies and what the edit form shows. */
export function editableSettings(t: { format: string; format_settings?: unknown }): FormatSettings | null {
  if (!isRoundFormat(t.format)) return null;
  const { requestedRounds, ...rest } = settingsOf(t);
  if (requestedRounds !== undefined) rest.rounds = requestedRounds;
  if (rest.chain)
    rest.chain = rest.chain.map(({ requestedRounds: asked, ...stage }) => (asked !== undefined ? { ...stage, rounds: asked } : stage));
  return rest;
}

/** The number of the playoff stage: after the main stage (1) and every further round stage. */
export const playoffStage = (s: FormatSettings) => 2 + (s.chain?.length ?? 0);

/** What is played at stage `stage`: a round stage (main or chained) or the playoff; null past the end. */
export function stageSpec(s: FormatSettings, mainFormat: RoundFormat, stage: number): { kind: "round"; format: RoundFormat; chain: ChainStage | null } | { kind: "playoff"; playoff: Playoff } | null {
  if (stage === 1) return { kind: "round", format: mainFormat, chain: null };
  const chained = s.chain?.[stage - 2];
  if (chained) return { kind: "round", format: chained.format, chain: chained };
  if (stage === playoffStage(s) && s.playoff) return { kind: "playoff", playoff: s.playoff };
  return null;
}

/** When round `round` is scheduled: the start plus (round − 1) × the interval, or only round 1 without one. */
export function roundTime(startsAt: Date | string, round: number, hours: number): string | null {
  const start = new Date(startsAt).getTime();
  if (hours > 0) return new Date(start + (round - 1) * hours * 3_600_000).toISOString();
  return round === 1 ? new Date(start).toISOString() : null;
}
