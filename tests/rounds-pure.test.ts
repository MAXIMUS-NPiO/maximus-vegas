import test from "node:test";
import assert from "node:assert/strict";
import { roundRobinSchedule } from "../src/server/roundrobin.ts";
import { defaultSwissRounds, effectiveSwissRounds, pairKey, pairSwissRound, type SwissEntrant } from "../src/server/swiss.ts";
import { computeStandings, standingsOrder, validPoints, type StandingsMatch, type StandingsRow } from "../src/server/standings.ts";

const P = { win: 3, draw: 1, loss: 0, bye: 3 };

test("round robin: every pair meets exactly once per leg, nobody plays twice in a round, odd fields rest once", () => {
  for (let n = 2; n <= 32; n++) {
    for (const legs of [1, 2] as const) {
      const ids = Array.from({ length: n }, (_, i) => i + 1);
      const { rounds, matches, rests } = roundRobinSchedule(ids, legs);
      const size = n % 2 === 0 ? n : n + 1;
      assert.equal(rounds, (size - 1) * legs);
      assert.equal(matches.length, ((n * (n - 1)) / 2) * legs, `n=${n}`);
      const seen = new Map<string, number>();
      for (const m of matches) seen.set(pairKey(String(m.a), String(m.b)), (seen.get(pairKey(String(m.a), String(m.b))) ?? 0) + 1);
      assert.equal(seen.size, (n * (n - 1)) / 2);
      for (const c of seen.values()) assert.equal(c, legs);
      for (let r = 1; r <= rounds; r++) {
        const inRound = matches.filter((m) => m.round === r).flatMap((m) => [m.a, m.b]);
        assert.equal(new Set(inRound).size, inRound.length, `n=${n} round ${r}`);
        const resting = rests.filter((x) => x.round === r).map((x) => x.entrant);
        assert.equal(inRound.length + resting.length, n);
      }
      if (n % 2 === 1) for (const id of ids) assert.equal(rests.filter((x) => x.entrant === id).length, legs);
      else assert.equal(rests.length, 0);
      // Second leg swaps sides: each ordered pair appears once when two legs are played.
      if (legs === 2) {
        const ordered = new Set(matches.map((m) => `${m.a}>${m.b}`));
        assert.equal(ordered.size, matches.length);
      }
    }
  }
});

test("swiss: default rounds follow log2 and never exceed n − 1; requests are capped", () => {
  assert.deepEqual([2, 3, 4, 5, 8, 9, 16, 17, 64].map(defaultSwissRounds), [1, 2, 2, 3, 3, 4, 4, 5, 6]);
  assert.equal(effectiveSwissRounds(4, 10), 3);
  assert.equal(effectiveSwissRounds(64, 30), 20);
  assert.equal(effectiveSwissRounds(8, null), 3);
});

const ent = (n: number, points: Record<number, number> = {}, byes: Record<number, number> = {}): SwissEntrant[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(i + 1), seed: i + 1, points: points[i + 1] ?? 0, byes: byes[i + 1] ?? 0 }));
const history = (pairs: Array<[number, number]>) => {
  const set = new Set(pairs.map(([a, b]) => pairKey(String(a), String(b))));
  return (a: string, b: string) => set.has(pairKey(a, b));
};

test("swiss: round one pairs the top half against the bottom half; an odd field gives the bye to the last seed", () => {
  assert.deepEqual(pairSwissRound(ent(8), () => false).pairs, [["1", "5"], ["2", "6"], ["3", "7"], ["4", "8"]]);
  const odd = pairSwissRound(ent(7), () => false);
  assert.equal(odd.bye, "7");
  assert.deepEqual(odd.pairs, [["1", "4"], ["2", "5"], ["3", "6"]]);
});

test("swiss: score groups pair inside, rematches are avoided, odd groups float down, failing groups merge", () => {
  const r1: Array<[number, number]> = [[1, 5], [2, 6], [3, 7], [4, 8]];
  const r2 = pairSwissRound(ent(8, { 1: 3, 2: 3, 3: 3, 4: 3 }), history(r1));
  assert.deepEqual(r2.pairs, [["1", "3"], ["2", "4"], ["5", "7"], ["6", "8"]]);
  // 1 already met 3: 1 takes the next bottom-half candidate.
  const avoid = pairSwissRound(ent(4, { 1: 3, 2: 3, 3: 3, 4: 3 }), history([[1, 3]]));
  assert.deepEqual(avoid.pairs, [["1", "4"], ["2", "3"]]);
  assert.equal(avoid.rematches, 0);
  // A group of one floats into the next group.
  const floated = pairSwissRound(ent(6, { 1: 6, 2: 3, 3: 3, 4: 3 }), () => false);
  assert.deepEqual(floated.pairs, [["1", "3"], ["2", "4"], ["5", "6"]]);
  // A group that already met merges with the one below.
  const merged = pairSwissRound(ent(4, { 1: 6, 2: 6 }), history([[1, 2]]));
  assert.deepEqual(merged.pairs, [["1", "3"], ["2", "4"]]);
  // The last block reopens the blocks above rather than accept a rematch.
  const reopened = pairSwissRound(ent(4, { 1: 3, 2: 3 }), history([[3, 4]]));
  assert.equal(reopened.rematches, 0);
  for (const [a, b] of reopened.pairs) assert.notEqual(pairKey(a, b), pairKey("3", "4"));
});

test("swiss: the bye goes to the lowest-ranked entrant who has had the fewest byes", () => {
  const r = pairSwissRound(ent(5, { 1: 3, 2: 3, 3: 0, 4: 0, 5: 3 }, { 5: 1 }), () => false);
  assert.equal(r.bye, "4");
});

// Deterministic pseudo-random results for simulations.
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

test("swiss: simulated events for 2–40 entrants pair everyone once per round and never repeat a pairing", () => {
  let totalRematches = 0;
  for (let n = 2; n <= 40; n++) {
    for (let trial = 0; trial < 5; trial++) {
      const rand = rng(n * 131 + trial);
      const rounds = defaultSwissRounds(n);
      const pts = new Map<string, number>();
      const byes = new Map<string, number>();
      const met = new Set<string>();
      for (let r = 0; r < rounds; r++) {
        const field = Array.from({ length: n }, (_, i) => ({ id: String(i + 1), seed: i + 1, points: pts.get(String(i + 1)) ?? 0, byes: byes.get(String(i + 1)) ?? 0 }));
        const res = pairSwissRound(field, (a, b) => met.has(pairKey(a, b)));
        const ids = res.pairs.flat();
        if (res.bye) ids.push(res.bye);
        assert.equal(new Set(ids).size, n, `n=${n} round ${r + 1}: everyone exactly once`);
        assert.equal(res.pairs.length, Math.floor(n / 2));
        totalRematches += res.rematches;
        if (res.bye) byes.set(res.bye, (byes.get(res.bye) ?? 0) + 1);
        if (res.bye) pts.set(res.bye, (pts.get(res.bye) ?? 0) + 3);
        for (const [a, b] of res.pairs) {
          met.add(pairKey(a, b));
          const w = rand() < 0.5 ? a : b;
          pts.set(w, (pts.get(w) ?? 0) + 3);
        }
      }
      if (n % 2 === 1) for (const c of byes.values()) assert.ok(c <= 1, `n=${n}: at most one bye each`);
    }
  }
  assert.equal(totalRematches, 0, "no rematch was needed at the default number of rounds");
});

// Six entrants, three Swiss rounds, no draws — values computed by hand:
//  R1: 1>4 2:0, 2>5 2:1, 3>6 2:0   R2: 1>2 2:1, 3>5 2:0, 4>6 2:1   R3: 1>3 2:0, 2>4 2:1, 5>6 2:0
const swissMatches: StandingsMatch[] = [
  [1, 4, 1, 2, 0], [2, 5, 2, 2, 1], [3, 6, 3, 2, 0],
  [1, 2, 1, 2, 1], [3, 5, 3, 2, 0], [4, 6, 4, 2, 1],
  [1, 3, 1, 2, 0], [2, 4, 2, 2, 1], [5, 6, 5, 2, 0],
].map(([a, b, w, sa, sb]) => ({ a: String(a), b: String(b), winner: String(w), scoreA: sa, scoreB: sb, outcome: "played", status: "completed" }));
const six = Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), seed: i + 1 }));

test("standings (Swiss): points, Buchholz, Median Buchholz and Sonneborn-Berger match a hand calculation", () => {
  const rows = computeStandings("swiss", six, swissMatches, P);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(rows.map((r) => r.id), ["1", "2", "3", "4", "5", "6"]);
  assert.deepEqual(["1", "2", "3", "4", "5", "6"].map((id) => by[id].points), [9, 6, 6, 3, 3, 0]);
  assert.deepEqual(["1", "2", "3", "4", "5", "6"].map((id) => by[id].buchholz), [15, 15, 12, 15, 12, 12]);
  assert.deepEqual(["1", "2", "3", "4", "5", "6"].map((id) => by[id].medianBuchholz), [6, 3, 3, 6, 6, 3]);
  assert.deepEqual(["1", "2", "3", "4", "5", "6"].map((id) => by[id].sonnebornBerger), [15, 6, 3, 0, 0, 0]);
  assert.deepEqual(["1", "2", "3", "4", "5", "6"].map((id) => by[id].diff), [5, 1, 2, -2, -1, -5]);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3, 4, 5, 6]);
});

test("standings: draws score draw points and half Sonneborn-Berger; byes score but add no opponent", () => {
  const m: StandingsMatch[] = [
    { a: "1", b: "2", winner: null, scoreA: 1, scoreB: 1, outcome: "played", status: "completed" },
    { a: "3", b: null, winner: "3", scoreA: null, scoreB: null, outcome: "bye", status: "completed" },
    { a: "1", b: "3", winner: "3", scoreA: 0, scoreB: 2, outcome: "played", status: "completed" },
    { a: "2", b: null, winner: "2", scoreA: null, scoreB: null, outcome: "bye", status: "completed" },
    { a: "2", b: "3", winner: null, scoreA: null, scoreB: null, outcome: "played", status: "result_submitted" },
  ];
  const rows = computeStandings("swiss", [{ id: "1", seed: 1 }, { id: "2", seed: 2 }, { id: "3", seed: 3 }], m, P);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by["1"].points, 1);
  assert.equal(by["2"].points, 4);
  assert.equal(by["3"].points, 6);
  assert.equal(by["2"].byes, 1);
  assert.equal(by["2"].played, 1, "an unfinished match does not count");
  assert.equal(by["2"].buchholz, 1, "the bye adds no opponent");
  assert.equal(by["2"].sonnebornBerger, 0.5, "half of a drawn opponent's points");
  assert.equal(by["3"].sonnebornBerger, 1);
});

test("standings (round robin): head-to-head decides a tie on points before Sonneborn-Berger", () => {
  // A beats B, B beats C, C beats D, D beats A, A beats C, B beats D → A 6, B 6, C 3, D 3.
  const res = (a: string, b: string, w: string, sa = 2, sb = 1): StandingsMatch => ({ a, b, winner: w, scoreA: sa, scoreB: sb, outcome: "played", status: "completed" });
  const m = [res("A", "B", "A"), res("B", "C", "B"), res("C", "D", "C"), res("D", "A", "D"), res("A", "C", "A"), res("B", "D", "B")];
  const rows = computeStandings("round_robin", ["A", "B", "C", "D"].map((id, i) => ({ id, seed: i + 1 })), m, P);
  assert.deepEqual(rows.map((r) => r.id), ["A", "B", "C", "D"]);
  assert.equal(rows[0].headToHead, 3);
  assert.equal(rows[1].headToHead, 0);
  // A disqualified entrant is listed last without a place, but still counts for others' tie-breaks.
  const dq = computeStandings("round_robin", ["A", "B", "C", "D"].map((id, i) => ({ id, seed: i + 1, disqualified: id === "A" })), m, P);
  assert.deepEqual(dq.map((r) => r.id), ["B", "C", "D", "A"]);
  assert.deepEqual(dq.map((r) => r.rank), [1, 2, 3, null]);
  assert.equal(dq.find((r) => r.id === "D")!.sonnebornBerger, 6, "D's win over the disqualified A still counts");
});

test("standings order: each tie-breaker applies only when every earlier one is equal", () => {
  const row = (id: string, o: Partial<StandingsRow>): StandingsRow => ({
    id, seed: Number(id), disqualified: false, played: 3, wins: 0, draws: 0, losses: 0, byes: 0, points: 6, scoreFor: 0, scoreAgainst: 0,
    diff: 0, buchholz: 10, medianBuchholz: 4, sonnebornBerger: 5, headToHead: 0, rank: null, ...o,
  });
  const swiss = standingsOrder("swiss");
  const sort = (rows: StandingsRow[], f = swiss) => [...rows].sort(f).map((r) => r.id);
  assert.deepEqual(sort([row("1", {}), row("2", { buchholz: 11 })]), ["2", "1"]);
  assert.deepEqual(sort([row("1", {}), row("2", { medianBuchholz: 5 })]), ["2", "1"]);
  assert.deepEqual(sort([row("1", {}), row("2", { sonnebornBerger: 5.5 })]), ["2", "1"]);
  assert.deepEqual(sort([row("1", {}), row("2", { diff: 1 })]), ["2", "1"]);
  assert.deepEqual(sort([row("2", {}), row("1", {})]), ["1", "2"], "seed last");
  assert.deepEqual(sort([row("1", { buchholz: 20 }), row("2", { points: 7 })]), ["2", "1"], "points first");
  const rr = standingsOrder("round_robin");
  assert.deepEqual(sort([row("1", { sonnebornBerger: 9 }), row("2", { headToHead: 3 })], rr), ["2", "1"]);
  assert.deepEqual(sort([row("1", {}), row("2", { scoreFor: 3 })], rr), ["2", "1"]);
});

test("points tables: loss ≤ draw ≤ win, win above loss, whole numbers 0–100", () => {
  assert.ok(validPoints({ win: 3, draw: 1, loss: 0, bye: 3 }));
  assert.ok(validPoints({ win: 1, draw: 0, loss: 0, bye: 1 }));
  assert.ok(!validPoints({ win: 1, draw: 2, loss: 0, bye: 1 }));
  assert.ok(!validPoints({ win: 0, draw: 0, loss: 0, bye: 0 }));
  assert.ok(!validPoints({ win: 3.5, draw: 1, loss: 0, bye: 3 }));
  assert.ok(!validPoints({ win: 300, draw: 1, loss: 0, bye: 3 }));
});
