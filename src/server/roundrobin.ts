/**
 * Pure round-robin scheduling (circle method, as in Berger tables). No I/O — covered by unit tests.
 *
 *  - Entrants come in seed order. An odd field gets a "rest" slot: whoever meets it sits that round out.
 *  - One leg has n' − 1 rounds (n' = entrants rounded up to even); every pair meets exactly once per leg.
 *  - Entrant 1 stays fixed and the others rotate; sides alternate by round so nobody is always slot a.
 *  - A second leg repeats the first with sides swapped (a league: home and away).
 */
export const RR_MAX_ENTRANTS = 32;

export type RRMatch<T> = { round: number; position: number; a: T; b: T };

export function roundRobinSchedule<T>(entrants: T[], legs: 1 | 2 = 1): { rounds: number; matches: RRMatch<T>[]; rests: Array<{ round: number; entrant: T }> } {
  const n = entrants.length;
  if (n < 2) throw new Error("At least two entrants are required");
  const size = n % 2 === 0 ? n : n + 1;
  const perLeg = size - 1;
  const matches: RRMatch<T>[] = [];
  const rests: Array<{ round: number; entrant: T }> = [];
  let ring = Array.from({ length: size }, (_, i) => i);
  const firstLeg: Array<Array<[number, number]>> = [];
  for (let r = 0; r < perLeg; r++) {
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < size / 2; i++) {
      const x = ring[i];
      const y = ring[size - 1 - i];
      pairs.push((i + r) % 2 === 0 ? [x, y] : [y, x]);
    }
    firstLeg.push(pairs);
    ring = [ring[0], ring[size - 1], ...ring.slice(1, size - 1)];
  }
  for (let leg = 0; leg < legs; leg++) {
    firstLeg.forEach((pairs, r) => {
      const round = leg * perLeg + r + 1;
      let position = 0;
      for (const [x, y] of pairs) {
        const [a, b] = leg === 0 ? [x, y] : [y, x];
        if (a === n || b === n) {
          rests.push({ round, entrant: entrants[a === n ? b : a] });
          continue;
        }
        matches.push({ round, position: position++, a: entrants[a], b: entrants[b] });
      }
    });
  }
  return { rounds: perLeg * legs, matches, rests };
}
