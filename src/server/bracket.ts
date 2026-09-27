/** Pure single-elimination planning. No I/O — covered by unit tests. */

export function bracketSize(count: number): number {
  if (!Number.isInteger(count) || count < 2) throw new Error("At least two participants are required");
  let size = 2;
  while (size < count) size *= 2;
  return size;
}

export const roundsFor = (count: number) => Math.log2(bracketSize(count));

/** Standard seeding order: seed 1 and seed 2 can only meet in the final. */
export function seedOrder(size: number): number[] {
  let order = [1];
  while (order.length < size) {
    const len = order.length * 2;
    order = order.flatMap((seed) => [seed, len + 1 - seed]);
  }
  return order;
}

export type PlannedMatch<T> = {
  round: number;
  position: number;
  a: T | null;
  b: T | null;
  next: { round: number; position: number; slot: "a" | "b" } | null;
};

/**
 * Plans every match of a single-elimination bracket for participants given in seed order.
 * Byes go to the highest seeds; a first-round match never has two empty slots.
 */
export function planSingleElimination<T>(seeded: T[]): { rounds: number; matches: PlannedMatch<T>[] } {
  const size = bracketSize(seeded.length);
  const rounds = Math.log2(size);
  const order = seedOrder(size);
  const matches: PlannedMatch<T>[] = [];
  for (let round = 1; round <= rounds; round++) {
    const count = size / 2 ** round;
    for (let position = 0; position < count; position++) {
      const next =
        round < rounds
          ? { round: round + 1, position: Math.floor(position / 2), slot: (position % 2 === 0 ? "a" : "b") as "a" | "b" }
          : null;
      if (round === 1) {
        const seedA = order[position * 2];
        const seedB = order[position * 2 + 1];
        matches.push({
          round,
          position,
          a: seedA <= seeded.length ? seeded[seedA - 1] : null,
          b: seedB <= seeded.length ? seeded[seedB - 1] : null,
          next,
        });
      } else matches.push({ round, position, a: null, b: null, next });
    }
  }
  return { rounds, matches };
}

/** Placement of a participant eliminated in `round` of a bracket with `rounds` rounds. */
export const placementForLoss = (round: number, rounds: number) => 2 ** (rounds - round) + 1;

export function roundName(round: number, rounds: number, lang: "ru" | "en"): string {
  const fromEnd = rounds - round;
  if (fromEnd === 0) return lang === "ru" ? "Финал" : "Final";
  if (fromEnd === 1) return lang === "ru" ? "Полуфинал" : "Semi-final";
  if (fromEnd === 2) return lang === "ru" ? "Четвертьфинал" : "Quarter-final";
  const size = 2 ** (fromEnd + 1);
  return lang === "ru" ? `1/${size / 2} финала` : `Round of ${size}`;
}
