/**
 * Pure rules of quick match: pairing (MV-MATCH-1), rating (MV-RATING-1) and the dodge cooldown.
 * No database access: the server module feeds queue units and ratings in and stores the outcome.
 */

/** A ready check lasts this long; the server settles it on the next request after the deadline. */
export const READY_SECONDS = 90;
export const MAX_PARTY = 5;

// MV-MATCH-1: the rating window widens with the longer wait of the two units.
export const BASE_WINDOW = 200;
export const WINDOW_STEP = 100;
export const OPEN_AFTER_SECONDS = 300;
export const REGION_AFTER_SECONDS = 120;

// MV-RATING-1: Elo over side averages with a faster start.
export const RATING_START = 1000;
export const RATING_FLOOR = 100;
export const PROVISIONAL_MATCHES = 10;
export const K_PROVISIONAL = 40;
export const K_SETTLED = 20;

/** A solo player or a whole party waiting in the queue of one game. */
export type QueueUnit = {
  /** The party id, or the user id of a solo player. */
  key: string;
  leaderId: string;
  members: string[];
  /** Average rating of the members, rounded. */
  rating: number;
  region: string;
  queuedAt: Date;
};

export type PairReasons = {
  size: number;
  gap: number;
  /** Allowed rating gap at the moment of pairing; null once any gap is accepted. */
  window: number | null;
  region: "same" | "any" | "relaxed";
  waitedSeconds: number;
};

/** Allowed rating gap after the longer of the two waits; null means any gap. */
export function ratingWindow(waitSeconds: number): number | null {
  if (waitSeconds >= OPEN_AFTER_SECONDS) return null;
  return BASE_WINDOW + WINDOW_STEP * Math.floor(Math.max(0, waitSeconds) / 60);
}

const regionKey = (r: string) => r.trim().toLowerCase();

/**
 * Whether two units can play each other now, and why. Same size only (1v1 … 5v5); a rating gap within the
 * window of the longer wait; a different stated region only after two minutes; no open challenge between
 * the two leaders for this game (`blocked`).
 */
export function compatible(x: QueueUnit, y: QueueUnit, now: Date, blocked: (a: string, b: string) => boolean = () => false): PairReasons | null {
  if (x.key === y.key || x.members.length !== y.members.length) return null;
  if (x.members.some((m) => y.members.includes(m))) return null;
  if (blocked(x.leaderId, y.leaderId)) return null;
  const waitedSeconds = Math.max(0, Math.floor((now.getTime() - Math.min(x.queuedAt.getTime(), y.queuedAt.getTime())) / 1000));
  const gap = Math.abs(x.rating - y.rating);
  const window = ratingWindow(waitedSeconds);
  if (window !== null && gap > window) return null;
  const rx = regionKey(x.region);
  const ry = regionKey(y.region);
  let region: PairReasons["region"] = "any";
  if (rx && ry) {
    if (rx === ry) region = "same";
    else if (waitedSeconds >= REGION_AFTER_SECONDS) region = "relaxed";
    else return null;
  }
  return { size: x.members.length, gap, window, region, waitedSeconds };
}

/**
 * Pairs waiting units: the longest-waiting unit takes the longest-waiting compatible unit, and so on.
 * Deterministic for the same input; each unit is used at most once.
 */
export function pairUnits(
  units: QueueUnit[],
  now: Date,
  blocked: (a: string, b: string) => boolean = () => false,
): { a: QueueUnit; b: QueueUnit; reasons: PairReasons }[] {
  const order = [...units].sort((p, q) => p.queuedAt.getTime() - q.queuedAt.getTime() || (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
  const used = new Set<string>();
  const pairs: { a: QueueUnit; b: QueueUnit; reasons: PairReasons }[] = [];
  for (let i = 0; i < order.length; i++) {
    const x = order[i];
    if (used.has(x.key)) continue;
    for (let j = i + 1; j < order.length; j++) {
      const y = order[j];
      if (used.has(y.key)) continue;
      const reasons = compatible(x, y, now, blocked);
      if (!reasons) continue;
      used.add(x.key);
      used.add(y.key);
      pairs.push({ a: x, b: y, reasons });
      break;
    }
  }
  return pairs;
}

export type RatedPlayer = { userId: string; rating: number; matches: number };
export type RatingChange = { userId: string; side: "a" | "b"; result: "win" | "loss"; before: number; after: number; delta: number };

/** Expected score of a side rated `ra` against a side rated `rb`. */
export const expectedScore = (ra: number, rb: number) => 1 / (1 + 10 ** ((rb - ra) / 400));

const average = (players: RatedPlayer[]) => players.reduce((s, p) => s + p.rating, 0) / Math.max(1, players.length);

/**
 * MV-RATING-1: each side is rated by its members' average; every player moves by their own K
 * (40 for the first 10 rated matches of the game, then 20) times the side's surprise. Floor 100.
 */
export function ratingChanges(sideA: RatedPlayer[], sideB: RatedPlayer[], winner: "a" | "b"): RatingChange[] {
  const ea = expectedScore(average(sideA), average(sideB));
  const out: RatingChange[] = [];
  for (const [side, players, expected] of [
    ["a", sideA, ea],
    ["b", sideB, 1 - ea],
  ] as const) {
    const score = winner === side ? 1 : 0;
    for (const p of players) {
      const k = p.matches < PROVISIONAL_MATCHES ? K_PROVISIONAL : K_SETTLED;
      const after = Math.max(RATING_FLOOR, p.rating + Math.round(k * (score - expected)));
      out.push({ userId: p.userId, side, result: score ? "win" : "loss", before: p.rating, after, delta: after - p.rating });
    }
  }
  return out;
}

/** Queue cooldown after a declined or missed ready check: 5, 10, 20, 40, then 60 minutes within 24 hours. */
export function dodgeMinutes(dodgesIn24h: number): number {
  const n = Math.max(1, dodgesIn24h);
  return Math.min(60, 5 * 2 ** (n - 1));
}
