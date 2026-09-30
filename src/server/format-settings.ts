/**
 * Settings of round-robin and Swiss tournaments: points table, draws, legs and rounds. Pure — no I/O.
 * They are validated when the organiser saves the tournament and frozen when it starts.
 */
import { fail } from "./errors.ts";
import { SWISS_MAX_ROUNDS, SWISS_VERSION } from "./swiss.ts";
import { DEFAULT_POINTS, STANDINGS_VERSION, validPoints, type PointsTable } from "./standings.ts";
import { RR_MAX_ENTRANTS } from "./roundrobin.ts";
import * as v from "./validate.ts";

export { RR_MAX_ENTRANTS, SWISS_MAX_ROUNDS };

export type RoundFormat = "round_robin" | "swiss";
export const isRoundFormat = (f: string | null | undefined): f is RoundFormat => f === "round_robin" || f === "swiss";

export type FormatSettings = {
  v: 1;
  points: PointsTable;
  allowDraws: boolean;
  /** Round robin: one leg, or two (home and away). */
  legs?: 1 | 2;
  /** Swiss: requested rounds (null = automatic); replaced by the number actually played at the start. */
  rounds?: number | null;
  /** Swiss, after the start: the organiser's original request, kept so a regeneration or a clone can recompute. */
  requestedRounds?: number | null;
  standings: string;
  pairing?: string;
};

export type FormatSettingsInput = {
  pointsWin?: unknown;
  pointsDraw?: unknown;
  pointsLoss?: unknown;
  pointsBye?: unknown;
  allowDraws?: unknown;
  legs?: unknown;
  swissRounds?: unknown;
};

const int = (value: unknown, fallback: number) => {
  const text = String(value ?? "").trim();
  if (text === "") return fallback;
  const n = Number(text);
  return Number.isInteger(n) ? n : Number.NaN;
};

/** Parses and validates the organiser's settings for a round-robin or Swiss tournament. */
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
  if (format === "round_robin") settings.legs = String(input.legs ?? "1") === "2" ? 2 : 1;
  else {
    const text = String(input.swissRounds ?? "").trim();
    settings.rounds = text === "" ? null : v.intIn(text, 1, SWISS_MAX_ROUNDS);
    settings.pairing = SWISS_VERSION;
  }
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
  } else out.legs = raw.legs === 2 ? 2 : 1;
  return out;
}

/** The organiser's settings before the start: what a clone copies and what the edit form shows. */
export function editableSettings(t: { format: string; format_settings?: unknown }): FormatSettings | null {
  if (!isRoundFormat(t.format)) return null;
  const { requestedRounds, ...rest } = settingsOf(t);
  if (requestedRounds !== undefined) rest.rounds = requestedRounds;
  return rest;
}
