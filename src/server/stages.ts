/**
 * Multi-stage structures, version MV-STAGES-1. Pure — no I/O, covered by unit tests.
 *
 *  - Groups: entrants in seed order are dealt into groups in a snake (1…G, G…1, 1…G …), so every group
 *    gets one of the strongest, one of the next strongest and so on; each group plays a round robin.
 *  - Playoff: after the main stage (groups, round robin or Swiss) the best entrants play a single- or
 *    double-elimination bracket or a gauntlet. From groups, the top K of every group advance; entrants of
 *    the same group rank are ordered across groups by points per game, score difference per game, scores
 *    per game, then group order. Group winners are seeded first, then runners-up, and so on; a first-round
 *    meeting of two entrants from the same group is avoided by swapping within a rank tier whenever possible.
 *  - Gauntlet (stepladder): the two lowest seeds play first; each winner meets the next seed up; seed 1
 *    plays only the final. Places follow the order of elimination, so they are unique.
 *  - Final places after a playoff: playoff places first; everyone else follows by the main stage — from
 *    groups, entrants with the same group rank share a place; from a round robin or Swiss, by table rank.
 */
import { bracketSize, seedOrder } from "./bracket.ts";
import type { StandingsRow } from "./standings.ts";

export const STAGES_VERSION = "MV-STAGES-1";
export const MAX_GROUPS = 32;
export const GAUNTLET_MAX = 16;
export const PLAYOFF_FORMATS = ["single_elimination", "double_elimination", "gauntlet"] as const;
export type PlayoffFormat = (typeof PLAYOFF_FORMATS)[number];

/** Deals entrants (in seed order) into `count` groups in a snake. Group sizes differ by at most one. */
export function snakeGroups<T>(seeded: T[], count: number): T[][] {
  if (!Number.isInteger(count) || count < 1) throw new Error("At least one group is required");
  const groups: T[][] = Array.from({ length: count }, () => []);
  seeded.forEach((e, i) => {
    const row = Math.floor(i / count);
    const pos = i % count;
    groups[row % 2 === 0 ? pos : count - 1 - pos].push(e);
  });
  return groups;
}

/** Group letters: 1 → A … 26 → Z, 27 → AA, 28 → AB … */
export function groupName(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

export type GauntletMatch<T> = { round: number; a: T; b: T | null; next: { round: number; slot: "b" } | null };

/**
 * Plans a gauntlet for entrants in seed order. Match r (1-based): the higher seed waits in slot a; slot b is
 * the lowest seed in match 1 and the previous winner afterwards. Seed 1 is slot a of the final.
 */
export function planGauntlet<T>(seeded: T[]): { rounds: number; matches: GauntletMatch<T>[] } {
  const n = seeded.length;
  if (n < 2) throw new Error("At least two participants are required");
  const rounds = n - 1;
  const matches: GauntletMatch<T>[] = [];
  for (let r = 1; r <= rounds; r++) {
    matches.push({
      round: r,
      a: seeded[n - 1 - r],
      b: r === 1 ? seeded[n - 1] : null,
      next: r < rounds ? { round: r + 1, slot: "b" } : null,
    });
  }
  return { rounds, matches };
}

/** Place of the entrant eliminated in round r of a gauntlet of n entrants (the champion is 1st). */
export const gauntletPlace = (round: number, n: number) => n - round + 1;

export type GroupRow = StandingsRow & { group: number };
export type Qualifier = { id: string; group: number; groupRank: number };

const perGame = (value: number, played: number) => (played > 0 ? value / played : 0);

/** Order of entrants who finished at the same rank in different groups (groups may differ in size). */
export function crossGroupOrder(x: GroupRow, y: GroupRow): number {
  const keys = [
    perGame(y.points, y.played) - perGame(x.points, x.played),
    perGame(y.diff, y.played) - perGame(x.diff, x.played),
    perGame(y.scoreFor, y.played) - perGame(x.scoreFor, x.played),
  ];
  for (const k of keys) if (Math.abs(k) > 1e-9) return k;
  return x.group - y.group;
}

/**
 * Qualifiers from groups: the top `perGroup` of every group (disqualified entrants never qualify), in seed
 * order for the playoff: all group winners first (ordered across groups), then all runners-up, and so on.
 */
export function groupQualifiers(groups: Map<number, StandingsRow[]>, perGroup: number): Qualifier[] {
  const out: Qualifier[] = [];
  for (let tier = 1; tier <= perGroup; tier++) {
    const rows: GroupRow[] = [];
    for (const [group, table] of groups) {
      const row = table.find((r) => r.rank === tier);
      if (row) rows.push({ ...row, group });
    }
    rows.sort(crossGroupOrder);
    for (const r of rows) out.push({ id: r.id, group: r.group, groupRank: tier });
  }
  return out;
}

/** First-round pairs of a single-elimination (or winners) bracket, as 0-based indexes into the seed list. */
export function firstRoundPairs(count: number): Array<[number, number]> {
  const size = bracketSize(count);
  const order = seedOrder(size);
  const pairs: Array<[number, number]> = [];
  for (let p = 0; p < size / 2; p++) {
    const a = order[p * 2] - 1;
    const b = order[p * 2 + 1] - 1;
    if (a < count && b < count) pairs.push([a, b]);
  }
  return pairs;
}

/**
 * Reorders qualifiers so that no first-round pair of the bracket comes from the same group, swapping only
 * within a group-rank tier (a winner stays a winner). Deterministic; if no swap can resolve a clash, the
 * clash stays and is reported.
 */
export function avoidSameGroup(qualifiers: Qualifier[]): { seeded: Qualifier[]; clashes: number } {
  const list = [...qualifiers];
  const pairs = firstRoundPairs(list.length);
  const partnerOf = new Map<number, number>();
  for (const [a, b] of pairs) {
    partnerOf.set(a, b);
    partnerOf.set(b, a);
  }
  const clashAt = (i: number) => {
    const j = partnerOf.get(i);
    return j !== undefined && list[i].group === list[j].group;
  };
  for (let guard = 0; guard < list.length * list.length; guard++) {
    const pair = pairs.find(([a]) => clashAt(a));
    if (!pair) break;
    const [, lower] = pair;
    let swapped = false;
    for (let k = list.length - 1; k >= 0 && !swapped; k--) {
      if (k === lower || k === pair[0] || list[k].groupRank !== list[lower].groupRank) continue;
      const before = pairs.filter(([a]) => clashAt(a)).length;
      [list[lower], list[k]] = [list[k], list[lower]];
      const after = pairs.filter(([a]) => clashAt(a)).length;
      if (after < before) swapped = true;
      else [list[lower], list[k]] = [list[k], list[lower]];
    }
    if (!swapped) break;
  }
  return { seeded: list, clashes: pairs.filter(([a]) => clashAt(a)).length };
}

/**
 * Final places after a playoff. `playoff` holds the places inside the playoff (1…); everyone else follows.
 * `rest` lists the other entrants in main-stage order with a sharing key: equal keys share a place. `base` is the
 * size of the playoff field, so the rest start after it even when a disqualified entrant holds no playoff place.
 */
export function combinePlaces(playoff: Map<string, number>, rest: Array<{ id: string; key: number }>, base = playoff.size): Map<string, number> {
  const out = new Map(playoff);
  const sorted = [...rest].sort((x, y) => x.key - y.key);
  for (const r of sorted) out.set(r.id, base + 1 + sorted.filter((o) => o.key < r.key).length);
  return out;
}
