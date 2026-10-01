/**
 * MV-LADDER-1: clan wars and seasonal ladders. Pure rules, no database.
 *
 * - A season is a calendar quarter in UTC ("2026-Q4"); a war counts in the season of its scheduled start.
 * - Every clan starts each season and game at 1000; a rated war moves both clans by Elo with K = 32,
 *   never below 100.
 * - Between the same two clans in one game, a war is rated only if their previous rated war in that game
 *   started at least 7 days earlier (no farming one opponent).
 * - The players' seasonal ladder reads quick-match rating changes (MV-RATING-1) inside the season: the
 *   rating after a player's last match of the season, for players with at least 5 matches in it.
 */
import { expectedScore } from "./matchmaking-rules.ts";

export const LADDER_START = 1000;
export const LADDER_K = 32;
export const LADDER_FLOOR = 100;
export const PAIR_COOLDOWN_DAYS = 7;
export const PLAYER_LADDER_MIN = 5;

/** Hours the challenged clan has to answer (never later than the start). */
export const WAR_ANSWER_HOURS = 72;
/** Hours after the start to report the result; afterwards the war lapses without a result. */
export const WAR_REPORT_HOURS = 72;
/** Hours the other clan has to confirm or dispute a report; afterwards the report stands. */
export const WAR_CONFIRM_HOURS = 48;
/** The start is at least this many minutes ahead and at most this many days ahead. */
export const WAR_MIN_LEAD_MINUTES = 10;
export const WAR_MAX_DAYS_AHEAD = 14;
export const BEST_OF = [1, 3, 5] as const;

export const CLAN_MAX_MEMBERS = 100;
export const CLAN_MAX_PENDING_INVITES = 30;
export const CLAN_MAX_OPEN_PROPOSALS = 10;

const SEASON = /^(\d{4})-Q([1-4])$/;

export const isSeason = (value: unknown): value is string => typeof value === "string" && SEASON.test(value);

/** The season (calendar quarter, UTC) of an instant. */
export function seasonOf(at: Date): string {
  return `${at.getUTCFullYear()}-Q${Math.floor(at.getUTCMonth() / 3) + 1}`;
}

/** Start (inclusive) and end (exclusive) of a season, or null for a malformed key. */
export function seasonBounds(season: string): { start: Date; end: Date } | null {
  const m = SEASON.exec(season);
  if (!m) return null;
  const year = Number(m[1]);
  const q = Number(m[2]);
  return { start: new Date(Date.UTC(year, (q - 1) * 3, 1)), end: new Date(Date.UTC(year, q * 3, 1)) };
}

/** Seasons from the one containing `from` to the one containing `to`, newest first, at most `max`. */
export function seasonsBetween(from: Date, to: Date, max = 12): string[] {
  const out: string[] = [];
  let year = to.getUTCFullYear();
  let q = Math.floor(to.getUTCMonth() / 3) + 1;
  const stop = seasonOf(from < to ? from : to);
  for (let i = 0; i < max; i++) {
    const key = `${year}-Q${q}`;
    out.push(key);
    if (key === stop) break;
    q -= 1;
    if (q === 0) {
      q = 4;
      year -= 1;
    }
  }
  return out;
}

/** Wins needed to take a series. */
export const winsNeeded = (bestOf: number) => Math.floor(bestOf / 2) + 1;

/**
 * The winner of a series score, or null when the score is not a finished series of this length:
 * the winner has exactly the wins needed, the loser fewer.
 */
export function seriesWinner(bestOf: number, a: number, b: number): "a" | "b" | null {
  if (!(BEST_OF as readonly number[]).includes(bestOf)) return null;
  if (![a, b].every((n) => Number.isInteger(n) && n >= 0)) return null;
  const need = winsNeeded(bestOf);
  if (a === need && b < need) return "a";
  if (b === need && a < need) return "b";
  return null;
}

export type LadderChange = { winnerBefore: number; winnerAfter: number; loserBefore: number; loserAfter: number; delta: number };

/** Elo change of a rated war: the winner gains what the loser loses, the loser never below the floor. */
export function ladderChange(winnerRating: number, loserRating: number): LadderChange {
  const delta = Math.max(1, Math.round(LADDER_K * (1 - expectedScore(winnerRating, loserRating))));
  return {
    winnerBefore: winnerRating,
    winnerAfter: winnerRating + delta,
    loserBefore: loserRating,
    loserAfter: Math.max(LADDER_FLOOR, loserRating - delta),
    delta,
  };
}

/** Whether a war is rated, given the start of the pair's previous rated war in this game (if any). */
export function isRated(scheduledAt: Date, previousRatedStart: Date | null): boolean {
  if (!previousRatedStart) return true;
  return scheduledAt.getTime() - previousRatedStart.getTime() >= PAIR_COOLDOWN_DAYS * 86_400_000;
}

/** Normalises a clan tag: 2–5 Latin capitals or digits, or null. */
export function clanTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tag = value.trim().toUpperCase();
  return /^[A-Z0-9]{2,5}$/.test(tag) ? tag : null;
}
