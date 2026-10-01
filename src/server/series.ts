/**
 * Series length and points by level, version MV-SERIES-1. Pure — no I/O, covered by unit tests.
 *
 * A setting comes from the most general level and is overridden by a more specific one:
 *   tournament → stage (the playoff) → part of a bracket (the lower bracket) → group → round → match.
 * The round level covers numbered rounds of a main stage played in rounds (round robin, Swiss, groups) and
 * named rounds of a bracket: the final (single elimination and gauntlet: the last round; double elimination:
 * the grand final, including a reset) and the semi-finals (single elimination and gauntlet: the round before
 * the final; double elimination: the finals of the upper and the lower bracket).
 *
 * Series length: best of 1, 3, 5 or 7. In a best-of-N series the winner's score is (N + 1) / 2 games and the
 * loser's is lower, so a draw is impossible; best of 1 keeps a free score (for example the rounds of one map).
 * Points (win, draw, loss, bye) apply to table matches only: round robin, Swiss and groups.
 * The rules are frozen with the other settings when the tournament starts; a referee may override one match
 * before any result is reported for it.
 */
import { fail } from "./errors.ts";
import { validPoints, type PointsTable } from "./standings.ts";

export const SERIES_VERSION = "MV-SERIES-1";
export const SERIES_LENGTHS = [1, 3, 5, 7] as const;
export type SeriesLength = (typeof SERIES_LENGTHS)[number];
/** Rows of round and group overrides the organiser can fill in. */
export const SERIES_ROWS = 4;
export const SERIES_MAX_ROUND = 64;
export const SERIES_MAX_GROUP = 32;

export type LevelRule = { bestOf?: SeriesLength; points?: PointsTable };
export type SeriesRules = {
  v: 1;
  /** The tournament's default. */
  bestOf: SeriesLength;
  /** The playoff after a main stage. */
  playoff?: SeriesLength;
  /** Double elimination: the lower bracket. */
  lower?: SeriesLength;
  /** Semi-finals (double elimination: upper and lower bracket finals). */
  semifinal?: SeriesLength;
  /** The final (double elimination: the grand final). */
  final?: SeriesLength;
  groups: Array<{ group: number } & LevelRule>;
  rounds: Array<{ round: number } & LevelRule>;
  series: string;
};

export const DEFAULT_SERIES: SeriesRules = { v: 1, bestOf: 1, groups: [], rounds: [], series: SERIES_VERSION };

export type SeriesSource = "match" | "round" | "final" | "semifinal" | "lower" | "group" | "playoff" | "tournament";

const isLength = (n: unknown): n is SeriesLength => (SERIES_LENGTHS as readonly unknown[]).includes(n);

/** A series length from a form value; empty or "inherit" means the level above decides. */
function lengthOf(value: unknown, inherit: boolean): SeriesLength | undefined {
  const text = String(value ?? "").trim();
  if (text === "" || text === "inherit") return inherit ? undefined : 1;
  const n = Number(text.replace(/^bo/i, ""));
  return isLength(n) ? n : fail("invalid_series");
}

/** A group from "B", "b" or "2" (groups are named A, B … Z, AA …). */
export function parseGroup(value: unknown): number | null {
  const text = String(value ?? "").trim().toUpperCase();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n >= 1 && n <= SERIES_MAX_GROUP ? n : fail("invalid_series");
  }
  if (!/^[A-Z]{1,2}$/.test(text)) fail("invalid_series");
  let n = 0;
  for (const ch of text) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n >= 1 && n <= SERIES_MAX_GROUP ? n : fail("invalid_series");
}

/** Points of one override row: all of win, draw and loss, or none (bye: Swiss only, defaults to the win). */
function rowPoints(input: Record<string, unknown>, prefix: string, swiss: boolean): PointsTable | undefined {
  const raw = ["Win", "Draw", "Loss"].map((k) => String(input[`${prefix}${k}`] ?? "").trim());
  if (raw.every((x) => x === "")) return undefined;
  if (raw.some((x) => x === "")) fail("invalid_points");
  const [win, draw, loss] = raw.map(Number);
  const byeText = String(input[`${prefix}Bye`] ?? "").trim();
  const points = { win, draw, loss, bye: swiss ? (byeText === "" ? win : Number(byeText)) : 0 };
  if (!validPoints(points)) fail("invalid_points");
  return points;
}

const clean = <T extends LevelRule>(rule: T): T => {
  const out = { ...rule };
  if (out.bestOf === undefined) delete out.bestOf;
  if (out.points === undefined) delete out.points;
  return out;
};

/**
 * Reads the organiser's form: seriesBestOf, seriesPlayoff, seriesLower, seriesSemifinal, seriesFinal and up to
 * four round rows (seriesRound1, seriesRound1BestOf, seriesRound1Win/Draw/Loss/Bye) and group rows
 * (seriesGroup1, seriesGroup1BestOf, seriesGroup1Win/Draw/Loss). Rows without a value are skipped.
 */
export function parseSeriesRules(input: Record<string, unknown>, format: string): SeriesRules {
  const rules: SeriesRules = { v: 1, bestOf: lengthOf(input.seriesBestOf, false)!, groups: [], rounds: [], series: SERIES_VERSION };
  for (const key of ["playoff", "lower", "semifinal", "final"] as const) {
    const n = lengthOf(input[`series${key[0].toUpperCase()}${key.slice(1)}`], true);
    if (n !== undefined) rules[key] = n;
  }
  const swiss = format === "swiss";
  for (let i = 1; i <= SERIES_ROWS; i++) {
    const roundText = String(input[`seriesRound${i}`] ?? "").trim();
    if (roundText) {
      const round = Number(roundText);
      if (!Number.isInteger(round) || round < 1 || round > SERIES_MAX_ROUND) fail("invalid_series");
      const rule = clean({ round, bestOf: lengthOf(input[`seriesRound${i}BestOf`], true), points: rowPoints(input, `seriesRound${i}`, swiss) });
      if (rule.bestOf !== undefined || rule.points) {
        if (rules.rounds.some((r) => r.round === round)) fail("invalid_series");
        rules.rounds.push(rule);
      }
    }
    const group = parseGroup(input[`seriesGroup${i}`]);
    if (group !== null) {
      const rule = clean({ group, bestOf: lengthOf(input[`seriesGroup${i}BestOf`], true), points: rowPoints(input, `seriesGroup${i}`, false) });
      if (rule.bestOf !== undefined || rule.points) {
        if (rules.groups.some((g) => g.group === group)) fail("invalid_series");
        rules.groups.push(rule);
      }
    }
  }
  rules.rounds.sort((a, b) => a.round - b.round);
  rules.groups.sort((a, b) => a.group - b.group);
  return rules;
}

const pointsOk = (p: unknown): p is PointsTable =>
  Boolean(p) && typeof p === "object" && ["win", "draw", "loss", "bye"].every((k) => Number.isInteger((p as Record<string, unknown>)[k])) && validPoints(p as PointsTable);

/** Stored rules with defaults filled in (defensive against partial JSON); null means best of 1 everywhere. */
export function seriesRulesOf(t: { series_rules?: unknown }): SeriesRules {
  const raw = (t.series_rules ?? null) as Partial<SeriesRules> | null;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SERIES, groups: [], rounds: [] };
  const level = (r: LevelRule): LevelRule => clean({ bestOf: isLength(r.bestOf) ? r.bestOf : undefined, points: pointsOk(r.points) ? r.points : undefined });
  const out: SeriesRules = {
    v: 1,
    bestOf: isLength(raw.bestOf) ? raw.bestOf : 1,
    groups: (Array.isArray(raw.groups) ? raw.groups : []).filter((g) => Number.isInteger(g?.group)).map((g) => ({ group: g.group, ...level(g) })),
    rounds: (Array.isArray(raw.rounds) ? raw.rounds : []).filter((r) => Number.isInteger(r?.round)).map((r) => ({ round: r.round, ...level(r) })),
    series: raw.series ?? SERIES_VERSION,
  };
  for (const key of ["playoff", "lower", "semifinal", "final"] as const) if (isLength(raw[key])) out[key] = raw[key];
  return out;
}

/** True when the rules say anything beyond "best of 1, the tournament's points". */
export const seriesCustomised = (r: SeriesRules) =>
  r.bestOf !== 1 || r.playoff !== undefined || r.lower !== undefined || r.semifinal !== undefined || r.final !== undefined || r.groups.length > 0 || r.rounds.length > 0;

export type SeriesMatch = {
  stage?: number | null;
  bracket?: string | null;
  round: number;
  group_no?: number | null;
  series_override?: number | null;
  points_override?: unknown;
};

/** Highest round of every bracket of every stage: "1:W" → 4. */
export type Depth = Map<string, number>;
export const depthKey = (stage: number, bracket: string) => `${stage}:${bracket}`;

export function bracketDepth(matches: Array<{ stage?: number | null; bracket?: string | null; round: number }>): Depth {
  const depth: Depth = new Map();
  for (const m of matches) {
    const key = depthKey(m.stage ?? 1, m.bracket ?? "W");
    depth.set(key, Math.max(depth.get(key) ?? 0, m.round));
  }
  return depth;
}

/** The bracket of each stage: stage 1 plays the tournament's format, stage 2 its playoff. */
export type StageFormats = { main: string; playoff?: string | null };

/** Named part of a bracket a match belongs to: the final, a semi-final, or the lower bracket. */
export function bracketPart(m: SeriesMatch, formats: StageFormats, depth: Depth): "final" | "semifinal" | "lower" | null {
  const stage = m.stage ?? 1;
  const bracket = m.bracket ?? "W";
  if (bracket === "RR" || bracket === "SW") return null;
  const format = stage === 2 ? (formats.playoff ?? "single_elimination") : formats.main;
  const top = depth.get(depthKey(stage, bracket)) ?? m.round;
  if (bracket === "GF") return "final";
  if (format === "double_elimination") {
    if ((bracket === "W" || bracket === "L") && m.round === top) return "semifinal";
    return bracket === "L" ? "lower" : null;
  }
  if (m.round === top) return "final";
  if (m.round === top - 1) return "semifinal";
  return null;
}

/** The series length of a match and the level it comes from. */
export function seriesOf(rules: SeriesRules, m: SeriesMatch, formats: StageFormats, depth: Depth): { bestOf: SeriesLength; source: SeriesSource } {
  if (isLength(m.series_override)) return { bestOf: m.series_override, source: "match" };
  const bracket = m.bracket ?? "W";
  if (bracket === "RR" || bracket === "SW") {
    const round = rules.rounds.find((r) => r.round === m.round && r.bestOf);
    if (round) return { bestOf: round.bestOf!, source: "round" };
    const group = m.group_no ? rules.groups.find((g) => g.group === m.group_no && g.bestOf) : undefined;
    if (group) return { bestOf: group.bestOf!, source: "group" };
    return { bestOf: rules.bestOf, source: "tournament" };
  }
  const part = bracketPart(m, formats, depth);
  if (part === "final" && rules.final) return { bestOf: rules.final, source: "final" };
  if (part === "semifinal" && rules.semifinal) return { bestOf: rules.semifinal, source: "semifinal" };
  if (bracket === "L" && rules.lower) return { bestOf: rules.lower, source: "lower" };
  if ((m.stage ?? 1) === 2 && rules.playoff) return { bestOf: rules.playoff, source: "playoff" };
  return { bestOf: rules.bestOf, source: "tournament" };
}

/** Series length of every match of a list (for bracket views): match id → best of N. */
export function seriesMap(rules: SeriesRules, matches: Array<SeriesMatch & { id: string }>, formats: StageFormats): Map<string, number> {
  const depth = bracketDepth(matches);
  return new Map(matches.map((m) => [m.id, seriesOf(rules, m, formats, depth).bestOf]));
}

/** Points of a table match: match → round → group → the tournament's points table. */
export function pointsOf(rules: SeriesRules, base: PointsTable, m: SeriesMatch): { points: PointsTable; source: SeriesSource } {
  if (pointsOk(m.points_override)) return { points: m.points_override, source: "match" };
  const round = rules.rounds.find((r) => r.round === m.round && r.points);
  if (round) return { points: round.points!, source: "round" };
  const group = m.group_no ? rules.groups.find((g) => g.group === m.group_no && g.points) : undefined;
  if (group) return { points: group.points!, source: "group" };
  return { points: base, source: "tournament" };
}

/** A best-of-N score: the winner has (N + 1) / 2 games, the loser fewer. Best of 1 accepts any score. */
export function seriesScoreValid(bestOf: number, scoreA: number, scoreB: number): boolean {
  if (bestOf <= 1) return true;
  const need = (bestOf + 1) / 2;
  return Math.max(scoreA, scoreB) === need && Math.min(scoreA, scoreB) < need;
}

/** Games needed to win a series of this length. */
export const winsNeeded = (bestOf: number) => (bestOf + 1) / 2;

/** Reads a referee's override of one match: series length (empty = inherited) and, for table matches, points. */
export function parseMatchOverride(input: Record<string, unknown>, table: boolean, swiss: boolean): { series: SeriesLength | null; points: PointsTable | null } {
  const series = lengthOf(input.series, true) ?? null;
  const points = table ? (rowPoints(input, "points", swiss) ?? null) : null;
  return { series, points };
}
