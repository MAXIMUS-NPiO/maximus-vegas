/**
 * Pure standings for round robin and Swiss, algorithm version MV-STANDINGS-1. No I/O — unit tested.
 *
 * Points per result come from the tournament's settings, which are frozen when it starts, so the same
 * results always give the same table. A match may carry its own points (a round, a group or the match itself
 * overrides the tournament's table — see series.ts); head-to-head then sums the points actually earned.
 *
 * Tie-breakers, in order:
 *   Swiss        points → Buchholz → Median Buchholz → Sonneborn-Berger → score difference → seed
 *   Round robin  points → head-to-head points among the entrants tied on points → Sonneborn-Berger
 *                → score difference → scores for → seed
 *
 * Definitions:
 *   Buchholz          the sum of the points of every opponent met.
 *   Median Buchholz   Buchholz without the single highest and single lowest opponent (with 3+ opponents).
 *   Sonneborn-Berger  the points of every opponent beaten, plus half the points of every opponent drawn.
 *   A bye scores bye points but adds no opponent. Forfeits (no-show, disqualification) count as results.
 *   Score for / against use reported scores of played matches only.
 *
 * Disqualified entrants are listed last and get no place. What happens to their results is a rule of the
 * tournament (round robin only; Swiss always keeps played results):
 *   annul    every match of the entrant is removed from the table, played or not;
 *   forfeit  results already played stand, the remaining matches are forfeited to the opponents;
 *   half     annul when the entrant had played fewer than half of their scheduled matches, else forfeit.
 * The rule is part of the frozen settings, and the decision is recomputed from the matches alone.
 */
export const STANDINGS_VERSION = "MV-STANDINGS-1";

export type PointsTable = { win: number; draw: number; loss: number; bye: number };
export const DEFAULT_POINTS: PointsTable = { win: 3, draw: 1, loss: 0, bye: 3 };

export const DQ_RULES = ["annul", "forfeit", "half"] as const;
export type DisqualificationRule = (typeof DQ_RULES)[number];

export type StandingsEntrant = { id: string; seed: number; disqualified?: boolean };
export type StandingsMatch = {
  a: string | null;
  b: string | null;
  winner: string | null;
  scoreA: number | null;
  scoreB: number | null;
  outcome: string | null;
  status: string;
  /** Points of this match when they differ from the tournament's table. */
  points?: PointsTable;
};

export type StandingsRow = {
  id: string;
  seed: number;
  disqualified: boolean;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  byes: number;
  points: number;
  scoreFor: number;
  scoreAgainst: number;
  diff: number;
  buchholz: number;
  medianBuchholz: number;
  sonnebornBerger: number;
  headToHead: number;
  rank: number | null;
  /** Disqualified with every result removed from the table (round-robin rule "annul", or "half" below 50%). */
  annulled: boolean;
};

type Result = { opponent: string; result: "w" | "d" | "l"; pts: number };

/**
 * Disqualified round-robin entrants whose results are removed under the tournament's rule. "Played" means
 * decided before the disqualification: completed with any outcome other than a disqualification forfeit.
 */
export function annulledEntrants(entrants: StandingsEntrant[], matches: StandingsMatch[], rule: DisqualificationRule): Set<string> {
  const out = new Set<string>();
  if (rule === "forfeit") return out;
  for (const e of entrants) {
    if (!e.disqualified) continue;
    if (rule === "annul") {
      out.add(e.id);
      continue;
    }
    const mine = matches.filter((m) => m.a === e.id || m.b === e.id);
    const played = mine.filter((m) => m.status === "completed" && m.outcome !== "disqualification" && m.outcome !== "bye").length;
    if (played * 2 < mine.length) out.add(e.id);
  }
  return out;
}

export function computeStandings(
  format: "round_robin" | "swiss",
  entrants: StandingsEntrant[],
  matches: StandingsMatch[],
  points: PointsTable,
  rules: { disqualification?: DisqualificationRule } = {},
): StandingsRow[] {
  const annulled = format === "round_robin" ? annulledEntrants(entrants, matches, rules.disqualification ?? "forfeit") : new Set<string>();
  const rows = new Map<string, StandingsRow>();
  const results = new Map<string, Result[]>();
  for (const e of entrants) {
    rows.set(e.id, {
      id: e.id,
      seed: e.seed,
      disqualified: Boolean(e.disqualified),
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      byes: 0,
      points: 0,
      scoreFor: 0,
      scoreAgainst: 0,
      diff: 0,
      buchholz: 0,
      medianBuchholz: 0,
      sonnebornBerger: 0,
      headToHead: 0,
      rank: null,
      annulled: annulled.has(e.id),
    });
    results.set(e.id, []);
  }
  for (const m of matches) {
    if (m.status !== "completed") continue;
    if ((m.a && annulled.has(m.a)) || (m.b && annulled.has(m.b))) continue;
    const pt = m.points ?? points;
    if (m.outcome === "bye") {
      const solo = m.a ?? m.b;
      const row = solo ? rows.get(solo) : undefined;
      if (row) {
        row.byes += 1;
        row.points += pt.bye;
      }
      continue;
    }
    if (!m.a || !m.b) continue;
    const ra = rows.get(m.a);
    const rb = rows.get(m.b);
    if (!ra || !rb) continue;
    ra.played += 1;
    rb.played += 1;
    if (m.winner === null) {
      ra.draws += 1;
      rb.draws += 1;
      ra.points += pt.draw;
      rb.points += pt.draw;
      results.get(m.a)!.push({ opponent: m.b, result: "d", pts: pt.draw });
      results.get(m.b)!.push({ opponent: m.a, result: "d", pts: pt.draw });
    } else {
      const [w, l] = m.winner === m.a ? [ra, rb] : [rb, ra];
      w.wins += 1;
      l.losses += 1;
      w.points += pt.win;
      l.points += pt.loss;
      results.get(w.id)!.push({ opponent: l.id, result: "w", pts: pt.win });
      results.get(l.id)!.push({ opponent: w.id, result: "l", pts: pt.loss });
    }
    if (m.outcome === "played" && m.scoreA !== null && m.scoreB !== null) {
      ra.scoreFor += m.scoreA;
      ra.scoreAgainst += m.scoreB;
      rb.scoreFor += m.scoreB;
      rb.scoreAgainst += m.scoreA;
    }
  }
  for (const row of rows.values()) {
    row.diff = row.scoreFor - row.scoreAgainst;
    const opp = results.get(row.id)!;
    const oppPoints = opp.map((r) => rows.get(r.opponent)!.points);
    row.buchholz = oppPoints.reduce((s, p) => s + p, 0);
    row.medianBuchholz = oppPoints.length >= 3 ? row.buchholz - Math.max(...oppPoints) - Math.min(...oppPoints) : row.buchholz;
    row.sonnebornBerger = opp.reduce((s, r) => s + (r.result === "w" ? rows.get(r.opponent)!.points : r.result === "d" ? rows.get(r.opponent)!.points / 2 : 0), 0);
  }
  if (format === "round_robin") {
    // Head-to-head: points earned only in matches between entrants tied on points.
    const byPoints = new Map<number, string[]>();
    for (const row of rows.values()) {
      if (row.disqualified) continue;
      byPoints.set(row.points, [...(byPoints.get(row.points) ?? []), row.id]);
    }
    for (const group of byPoints.values()) {
      if (group.length < 2) continue;
      const inGroup = new Set(group);
      for (const id of group) {
        rows.get(id)!.headToHead = results
          .get(id)!
          .filter((r) => inGroup.has(r.opponent))
          .reduce((s, r) => s + r.pts, 0);
      }
    }
  }
  const sorted = [...rows.values()].sort(standingsOrder(format));
  let rank = 0;
  for (const row of sorted) row.rank = row.disqualified ? null : ++rank;
  return sorted;
}

/** Ordering of standings rows: disqualified last, then the tie-breakers of the format, then seed. */
export function standingsOrder(format: "round_robin" | "swiss") {
  return (x: StandingsRow, y: StandingsRow) => {
    if (x.disqualified !== y.disqualified) return x.disqualified ? 1 : -1;
    const keys =
      format === "swiss"
        ? [y.points - x.points, y.buchholz - x.buchholz, y.medianBuchholz - x.medianBuchholz, y.sonnebornBerger - x.sonnebornBerger, y.diff - x.diff]
        : [y.points - x.points, y.headToHead - x.headToHead, y.sonnebornBerger - x.sonnebornBerger, y.diff - x.diff, y.scoreFor - x.scoreFor];
    for (const k of keys) if (k !== 0) return k;
    return x.seed - y.seed;
  };
}

/** Validates an organiser's points table: loss ≤ draw ≤ win, win > loss, integers 0–100. */
export function validPoints(p: PointsTable): boolean {
  const ints = [p.win, p.draw, p.loss, p.bye].every((x) => Number.isInteger(x) && x >= 0 && x <= 100);
  return ints && p.win > p.loss && p.draw >= p.loss && p.draw <= p.win;
}
