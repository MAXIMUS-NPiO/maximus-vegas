/**
 * Pure double-elimination planning. No I/O — covered by unit tests.
 *
 * Construction (winners bracket of k rounds, bracket size S = 2^k):
 *  - The losers bracket has 2 × (k − 1) rounds.
 *  - Losers round 1 pairs the winners-round-1 losers with each other.
 *  - Every even losers round is a "drop" round: survivors of the previous losers round (slot a)
 *    meet the fresh losers of winners round (j / 2 + 1) (slot b).
 *  - Every odd losers round after the first is consolidation: survivors play each other.
 *  - The winners champion takes grand-final slot a, the losers champion slot b. If the losers
 *    champion wins the grand final, a single bracket-reset match (grand final, round 2) decides it.
 *
 * Differences from the reference prototype, both deliberate:
 *  - Drops into odd-numbered drop rounds are mirrored, so a player who just lost in the winners
 *    bracket does not immediately meet someone they already met in the same quarter.
 *  - Byes are resolved for the whole plan, not only at generation time: a winners-round-1 bye has
 *    no loser, so the losers slot it feeds is marked void and whoever arrives opposite a void slot
 *    advances automatically. The reference left such losers matches waiting forever.
 */
import { bracketSize, seedOrder } from "./bracket.ts";

export type BracketSide = "W" | "L" | "GF";
export type Slot = "a" | "b";
export type Ref = { bracket: BracketSide; round: number; position: number };
export type SlotRef = Ref & { slot: Slot };

export type PlannedDE<T> = Ref & {
  a: T | null;
  b: T | null;
  /** The slot will never receive a participant (its feeder is a bye or an empty match). */
  aVoid: boolean;
  bVoid: boolean;
  next: SlotRef | null;
  loserNext: SlotRef | null;
};

/** Key of a planned match; also used for gauntlet matches (bracket "G"). */
export const refKey = (r: { bracket: string; round: number; position: number }) => `${r.bracket}:${r.round}:${r.position}`;

/** Number of losers-bracket rounds for a winners bracket of `k` rounds. */
export const losersRounds = (k: number) => (k >= 2 ? 2 * (k - 1) : 0);

/** Matches in losers round `j` (1-based) for bracket size `size`. */
export const losersCount = (size: number, j: number) => size / 2 ** (Math.ceil(j / 2) + 1);

/** Where the loser of winners round `w` (≥ 2), match `p`, drops. */
export function dropTarget(size: number, w: number, p: number): SlotRef {
  const j = 2 * w - 2;
  const count = losersCount(size, j);
  const drop = w - 1;
  const position = drop % 2 === 1 ? count - 1 - p : p;
  return { bracket: "L", round: j, position, slot: "b" };
}

export function planDoubleElimination<T>(seeded: T[]): { size: number; winnersRounds: number; losersRounds: number; matches: PlannedDE<T>[] } {
  const size = bracketSize(seeded.length);
  const k = Math.log2(size);
  const lRounds = losersRounds(k);
  const order = seedOrder(size);
  const matches = new Map<string, PlannedDE<T>>();
  const add = (m: PlannedDE<T>) => matches.set(refKey(m), m);

  for (let round = 1; round <= k; round++) {
    const count = size / 2 ** round;
    for (let position = 0; position < count; position++) {
      const next: SlotRef =
        round < k
          ? { bracket: "W", round: round + 1, position: Math.floor(position / 2), slot: position % 2 === 0 ? "a" : "b" }
          : { bracket: "GF", round: 1, position: 0, slot: "a" };
      let loserNext: SlotRef;
      if (k === 1) loserNext = { bracket: "GF", round: 1, position: 0, slot: "b" };
      else if (round === 1) loserNext = { bracket: "L", round: 1, position: Math.floor(position / 2), slot: position % 2 === 0 ? "a" : "b" };
      else loserNext = dropTarget(size, round, position);
      const seedA = order[position * 2];
      const seedB = order[position * 2 + 1];
      add({
        bracket: "W",
        round,
        position,
        a: round === 1 && seedA <= seeded.length ? seeded[seedA - 1] : null,
        b: round === 1 && seedB <= seeded.length ? seeded[seedB - 1] : null,
        aVoid: false,
        bVoid: false,
        next,
        loserNext,
      });
    }
  }

  for (let j = 1; j <= lRounds; j++) {
    const count = losersCount(size, j);
    for (let position = 0; position < count; position++) {
      let next: SlotRef;
      if (j === lRounds) next = { bracket: "GF", round: 1, position: 0, slot: "b" };
      else if (j % 2 === 1) next = { bracket: "L", round: j + 1, position, slot: "a" };
      else next = { bracket: "L", round: j + 1, position: Math.floor(position / 2), slot: position % 2 === 0 ? "a" : "b" };
      add({ bracket: "L", round: j, position, a: null, b: null, aVoid: false, bVoid: false, next, loserNext: null });
    }
  }

  add({ bracket: "GF", round: 1, position: 0, a: null, b: null, aVoid: false, bVoid: false, next: null, loserNext: null });

  // Void analysis. Only a winners-round-1 bye can lack a loser (later winners matches always get two
  // real winners); an empty losers match propagates an empty slot onward.
  const feeders = new Map<string, Array<{ from: PlannedDE<T>; kind: "winner" | "loser" }>>();
  for (const m of matches.values()) {
    for (const [target, kind] of [[m.next, "winner"], [m.loserNext, "loser"]] as const) {
      if (!target) continue;
      const key = `${refKey(target)}:${target.slot}`;
      feeders.set(key, [...(feeders.get(key) ?? []), { from: m, kind }]);
    }
  }
  const empty = new Set<string>(); // matches that will never have a winner
  const noLoser = new Set<string>(); // matches that will never produce a loser
  for (const m of matches.values()) if (m.bracket === "W" && m.round === 1 && Boolean(m.a) !== Boolean(m.b)) noLoser.add(refKey(m));
  const ordered = [...matches.values()].filter((m) => m.bracket === "L").sort((x, y) => x.round - y.round || x.position - y.position);
  for (const m of ordered) {
    for (const slot of ["a", "b"] as const) {
      const list = feeders.get(`${refKey(m)}:${slot}`) ?? [];
      const isVoid = list.length > 0 && list.every((f) => (f.kind === "loser" ? noLoser.has(refKey(f.from)) : empty.has(refKey(f.from))));
      if (slot === "a") m.aVoid = isVoid;
      else m.bVoid = isVoid;
    }
    if (m.aVoid && m.bVoid) {
      empty.add(refKey(m));
      noLoser.add(refKey(m));
    } else if (m.aVoid || m.bVoid) noLoser.add(refKey(m));
  }

  return { size, winnersRounds: k, losersRounds: lRounds, matches: [...matches.values()] };
}

/** Human-readable round names for each part of a double-elimination bracket. */
export function deRoundName(bracket: BracketSide, round: number, winnersRounds: number, lRounds: number, lang: "ru" | "en"): string {
  if (bracket === "GF") return round === 1 ? (lang === "ru" ? "Гранд-финал" : "Grand final") : lang === "ru" ? "Перезапуск финала" : "Bracket reset";
  if (bracket === "W") {
    const fromEnd = winnersRounds - round;
    if (fromEnd === 0) return lang === "ru" ? "Финал верхней сетки" : "Winners final";
    if (fromEnd === 1) return lang === "ru" ? "Полуфинал верхней сетки" : "Winners semi-final";
    return lang === "ru" ? `Верхняя сетка, раунд ${round}` : `Winners round ${round}`;
  }
  if (round === lRounds) return lang === "ru" ? "Финал нижней сетки" : "Losers final";
  return lang === "ru" ? `Нижняя сетка, раунд ${round}` : `Losers round ${round}`;
}

/**
 * Elimination stage used for final placements: later stages rank higher. Losers-round losers are
 * eliminated at stage = round; the grand-final (or reset) loser at lRounds + 1.
 */
export const deStage = (bracket: BracketSide, round: number, lRounds: number) => (bracket === "GF" ? lRounds + 1 : bracket === "L" ? round : 0);
