/**
 * Pure leaderboard scoring. No I/O — covered by unit tests.
 * Weights, best-of-N, tie-breakers and the review flags follow the Vegas handoff spec (sections 3.4, 3.5, 4, 6).
 */

export const STATS = ["kills", "assists", "deaths", "headshots", "damage", "distance"] as const;
export type Stat = (typeof STATS)[number];
export type StatLine = Record<Stat, number> & { placement: 1 | 2 | 3 | null };

export type Weights = {
  kills: number;
  assists: number;
  headshots: number;
  damage: number;
  distance: number;
  place1: number;
  place2: number;
  place3: number;
};

export const DEFAULT_WEIGHTS: Weights = Object.freeze({
  kills: 5,
  assists: 0.5,
  headshots: 3,
  damage: 0.01,
  distance: 0.002,
  place1: 80,
  place2: 40,
  place3: 15,
}) as Weights;

export const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS) as Array<keyof Weights>;

/** Upper bounds accepted as input at all; anything above is rejected as malformed, not flagged. */
export const INPUT_LIMITS: Record<Stat, number> = {
  kills: 999,
  assists: 999,
  deaths: 999,
  headshots: 999,
  damage: 99_999,
  distance: 999_999,
};

/** Review thresholds from the handoff spec: excluded from standings until an organiser decides. */
export const FLAG_THRESHOLDS = { kills: 40, damage: 6000, distance: 20000 } as const;

export type FlagReason = "headshots_exceed_kills" | "kills_extreme" | "damage_extreme" | "distance_extreme";

/**
 * Merges stored weights over current defaults, so a newly added field never resolves to undefined
 * in older records (handoff spec, section 8, points 7 and 8).
 */
export function mergeWeights(stored: unknown): Weights {
  const out: Weights = { ...DEFAULT_WEIGHTS };
  if (stored && typeof stored === "object") {
    for (const key of WEIGHT_KEYS) {
      const v = (stored as Record<string, unknown>)[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1000) out[key] = v;
    }
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function matchPoints(line: StatLine, weights: Weights = DEFAULT_WEIGHTS): number {
  let points =
    line.kills * weights.kills +
    line.assists * weights.assists +
    line.headshots * weights.headshots +
    line.damage * weights.damage +
    line.distance * weights.distance;
  if (line.placement === 1) points += weights.place1;
  else if (line.placement === 2) points += weights.place2;
  else if (line.placement === 3) points += weights.place3;
  return round2(points);
}

/** Integrity flags — not anti-cheat. Logically impossible or implausible lines wait for a human. */
export function flagReasons(line: StatLine): FlagReason[] {
  const reasons: FlagReason[] = [];
  if (line.headshots > line.kills) reasons.push("headshots_exceed_kills");
  if (line.kills > FLAG_THRESHOLDS.kills) reasons.push("kills_extreme");
  if (line.damage > FLAG_THRESHOLDS.damage) reasons.push("damage_extreme");
  if (line.distance > FLAG_THRESHOLDS.distance) reasons.push("distance_extreme");
  return reasons;
}

export const kda = (kills: number, assists: number, deaths: number) => round2((kills + assists) / Math.max(1, deaths));

export type ScoreRow = StatLine & { participantId: string; counted: boolean };

export type Standing = {
  participantId: string;
  points: number;
  kills: number;
  assists: number;
  deaths: number;
  kda: number;
  logged: number;
  counted: number;
  pending: number;
  rank: number;
};

/**
 * Standings: accepted lines only; with best-of-N only each participant's top N lines count.
 * Sort: points desc, then KDA desc, then kills desc. Exact ties share a rank (1, 2, 2, 4).
 */
export function standings(
  participantIds: string[],
  lines: Array<StatLine & { participantId: string; accepted: boolean; pending: boolean }>,
  weights: Weights = DEFAULT_WEIGHTS,
  bestOf: number | null = null,
): Standing[] {
  const acc = new Map<string, { lines: StatLine[]; logged: number; pending: number }>();
  for (const id of participantIds) acc.set(id, { lines: [], logged: 0, pending: 0 });
  for (const line of lines) {
    const row = acc.get(line.participantId);
    if (!row) continue;
    row.logged += 1;
    if (line.pending) {
      row.pending += 1;
      continue;
    }
    if (!line.accepted) continue;
    row.lines.push(line);
  }
  const rows = [...acc.entries()].map(([participantId, r]) => {
    // Equal-point records use the same published metric order, then a complete stable
    // stat tuple. Database/input ordering can never select a different best-N set.
    const sorted = [...r.lines].sort((a, b) => matchPoints(b, weights) - matchPoints(a, weights)
      || kda(b.kills,b.assists,b.deaths)-kda(a.kills,a.assists,a.deaths)
      || b.kills-a.kills || b.assists-a.assists || a.deaths-b.deaths
      || b.headshots-a.headshots || b.damage-a.damage || b.distance-a.distance
      || (a.placement ?? 4)-(b.placement ?? 4));
    const counted = bestOf ? sorted.slice(0, bestOf) : sorted;
    const sum = (key: Stat) => counted.reduce((s,line)=>s+line[key],0);
    const kills=sum("kills"), assists=sum("assists"), deaths=sum("deaths");
    return {
      participantId,
      points: round2(counted.reduce((s, line) => s + matchPoints(line,weights), 0)),
      kills,
      assists,
      deaths,
      kda: kda(kills, assists, deaths),
      logged: r.logged,
      counted: counted.length,
      pending: r.pending,
      rank: 0,
    };
  });
  rows.sort((a, b) => b.points - a.points || b.kda - a.kda || b.kills - a.kills || a.participantId.localeCompare(b.participantId));
  rows.forEach((row, i) => {
    const prev = rows[i - 1];
    row.rank = prev && prev.points === row.points && prev.kda === row.kda && prev.kills === row.kills ? prev.rank : i + 1;
  });
  return rows;
}
