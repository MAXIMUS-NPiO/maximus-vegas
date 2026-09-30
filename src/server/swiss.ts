/**
 * Pure Swiss pairing, algorithm version MV-SWISS-1. No I/O — covered by unit tests.
 *
 *  1. Ranking for pairing: points (high first), then seed (low first). Seeds are fixed at the start and
 *     never change, so the same results always produce the same pairings.
 *  2. Odd field: the bye goes to the lowest-ranked entrant among those with the fewest byes so far.
 *  3. Score groups are paired from the top. Inside a group the top half meets the bottom half
 *     (1st v (h+1)th, 2nd v (h+2)th, …). An odd group floats its lowest-ranked entrant into the next group.
 *  4. Rematches are avoided: if the planned opponent was already met, the next candidates are tried in a
 *     fixed order (the rest of the bottom half, then the top half, nearest first). A group that cannot be
 *     paired without a rematch is merged into the next group; if the last block still fails, the blocks
 *     above it are reopened one at a time, so a rematch is avoided whenever any pairing allows it.
 *  5. Only when no pairing of the whole field avoids it is a rematch accepted (preferring opponents not
 *     met before); the count is reported and recorded, never hidden.
 */
export const SWISS_VERSION = "MV-SWISS-1";
export const SWISS_MAX_ROUNDS = 20;

export type SwissEntrant = { id: string; seed: number; points: number; byes: number };
export type SwissPairing = { pairs: Array<[string, string]>; bye: string | null; rematches: number };

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Default number of rounds: enough for a single undefeated entrant, never more than n − 1. */
export function defaultSwissRounds(entrants: number): number {
  if (entrants < 2) return 0;
  return Math.min(entrants - 1, Math.max(1, Math.ceil(Math.log2(entrants))));
}

/** Rounds actually played: the organiser's request capped by what the field allows. */
export function effectiveSwissRounds(entrants: number, requested: number | null | undefined): number {
  if (entrants < 2) return 0;
  const want = requested && requested > 0 ? requested : defaultSwissRounds(entrants);
  return Math.max(1, Math.min(want, entrants - 1, SWISS_MAX_ROUNDS));
}

function pairBlock(block: SwissEntrant[], played: (a: string, b: string) => boolean, budget: number, allowRematch: boolean): Array<[string, string]> | null {
  let steps = 0;
  const solve = (u: string[]): Array<[string, string]> | null => {
    if (u.length === 0) return [];
    if (++steps > budget) return null;
    const x = u[0];
    const h = u.length / 2;
    const order: number[] = [];
    for (let i = h; i < u.length; i++) order.push(i);
    for (let i = h - 1; i >= 1; i--) order.push(i);
    // With rematches allowed, still prefer opponents not met before.
    const candidates = allowRematch ? [...order.filter((i) => !played(x, u[i])), ...order.filter((i) => played(x, u[i]))] : order;
    for (const i of candidates) {
      const y = u[i];
      if (!allowRematch && played(x, y)) continue;
      const rest = u.filter((_, k) => k !== 0 && k !== i);
      const sub = solve(rest);
      if (sub) return [[x, y], ...sub];
      if (steps > budget) return null;
    }
    return null;
  };
  return solve(block.map((e) => e.id));
}

export function pairSwissRound(entrants: SwissEntrant[], played: (a: string, b: string) => boolean, budget = 20_000): SwissPairing {
  const ranked = [...entrants].sort((a, b) => b.points - a.points || a.seed - b.seed);
  let bye: string | null = null;
  let pool = ranked;
  if (ranked.length % 2 === 1) {
    const fewest = Math.min(...ranked.map((e) => e.byes));
    bye = [...ranked].reverse().find((e) => e.byes === fewest)!.id;
    pool = ranked.filter((e) => e.id !== bye);
  }
  const groups: SwissEntrant[][] = [];
  for (const e of pool) {
    const last = groups[groups.length - 1];
    if (last && last[0].points === e.points) last.push(e);
    else groups.push([e]);
  }
  // Paired blocks, top to bottom; a failing last block reopens the blocks above it one by one.
  const blocks: SwissEntrant[][] = [];
  const blockPairs: Array<Array<[string, string]>> = [];
  let rematches = 0;
  let carry: SwissEntrant[] = [];
  for (let i = 0; i < groups.length; i++) {
    const block = [...carry, ...groups[i]];
    carry = [];
    if (block.length % 2 === 1) carry = [block.pop()!];
    if (!block.length) continue;
    const clean = pairBlock(block, played, budget, false);
    if (clean) {
      blocks.push(block);
      blockPairs.push(clean);
      continue;
    }
    if (i + 1 < groups.length) {
      groups[i + 1] = [...block, ...carry, ...groups[i + 1]];
      carry = [];
      continue;
    }
    let pending: SwissEntrant[] | null = block;
    while (pending && blocks.length) {
      const above = blocks.pop()!;
      blockPairs.pop();
      const merged: SwissEntrant[] = [...above, ...pending];
      const res = pairBlock(merged, played, budget, false);
      if (res) {
        blocks.push(merged);
        blockPairs.push(res);
        pending = null;
      } else pending = merged;
    }
    if (pending) {
      const forced = pairBlock(pending, played, budget, true)!;
      rematches += forced.filter(([a, b]) => played(a, b)).length;
      blocks.push(pending);
      blockPairs.push(forced);
    }
  }
  return { pairs: blockPairs.flat(), bye, rematches };
}
