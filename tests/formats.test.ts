import test from "node:test";
import assert from "node:assert/strict";
import { planDoubleElimination, refKey, losersRounds, type PlannedDE, type SlotRef } from "../src/server/double.ts";
import { DEFAULT_WEIGHTS, flagReasons, kda, matchPoints, mergeWeights, standings, type StatLine } from "../src/server/scoring.ts";

const shape = (n: number, bracket: "W" | "L") => {
  const plan = planDoubleElimination(Array.from({ length: n }, (_, i) => `p${i + 1}`));
  const rounds = new Map<number, number>();
  for (const m of plan.matches.filter((x) => x.bracket === bracket)) rounds.set(m.round, (rounds.get(m.round) ?? 0) + 1);
  return [...rounds.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
};

test("double elimination: winners and losers bracket shapes for 2, 4, 8 and 16 entrants", () => {
  assert.deepEqual(shape(2, "W"), [1]);
  assert.deepEqual(shape(2, "L"), []);
  assert.deepEqual(shape(4, "W"), [2, 1]);
  assert.deepEqual(shape(4, "L"), [1, 1], "4 entrants need two losers rounds, not one");
  assert.deepEqual(shape(8, "W"), [4, 2, 1]);
  assert.deepEqual(shape(8, "L"), [2, 2, 1, 1]);
  assert.deepEqual(shape(16, "L"), [4, 4, 2, 2, 1, 1]);
  assert.equal(losersRounds(5), 8);
});

/** Deterministic PRNG for reproducible random outcomes. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type SimMatch = PlannedDE<string> & { winner: string | null; played: boolean; done: boolean };

/** Plays a plan to completion the way the database engine does: void slots advance automatically. */
function simulate(n: number, pick: (a: string, b: string, m: SimMatch) => string) {
  const entrants = Array.from({ length: n }, (_, i) => `p${i + 1}`);
  const plan = planDoubleElimination(entrants);
  const byKey = new Map<string, SimMatch>(plan.matches.map((m) => [refKey(m), { ...m, winner: null, played: false, done: false }]));
  const losses = new Map<string, number>(entrants.map((e) => [e, 0]));
  const meetings = new Map<string, number>();
  let played = 0;
  let reset: SimMatch | null = null;
  let champion: string | null = null;

  const place = (to: SlotRef, who: string) => {
    const m = byKey.get(refKey(to))!;
    assert.equal(m[to.slot], null, `slot ${refKey(to)}:${to.slot} filled twice`);
    m[to.slot] = who;
  };
  const complete = (m: SimMatch, winner: string, loser: string | null) => {
    m.winner = winner;
    m.done = true;
    if (m.next) place(m.next, winner);
    if (m.loserNext && loser) place(m.loserNext, loser);
  };
  // Byes in winners round 1.
  for (const m of byKey.values()) if (m.bracket === "W" && m.round === 1 && Boolean(m.a) !== Boolean(m.b)) complete(m, (m.a ?? m.b)!, null);
  // Fully empty losers matches never play.
  for (const m of byKey.values()) if (m.aVoid && m.bVoid) m.done = true;

  for (let guard = 0; guard < 10_000 && !champion; guard++) {
    const ready = [...byKey.values()].find((m) => !m.done && ((m.a && m.b) || (m.a && m.bVoid) || (m.b && m.aVoid)));
    if (!ready) {
      if (reset && !reset.done) {
        const w = pick(reset.a!, reset.b!, reset);
        const l = w === reset.a ? reset.b! : reset.a!;
        losses.set(l, losses.get(l)! + 1);
        played++;
        reset.done = true;
        champion = w;
        break;
      }
      assert.fail(`bracket stuck for ${n} entrants`);
    }
    if (!ready.a || !ready.b) {
      complete(ready, (ready.a ?? ready.b)!, null); // opponent slot is void
      continue;
    }
    const pair = [ready.a, ready.b].sort().join("|");
    meetings.set(pair, (meetings.get(pair) ?? 0) + 1);
    const w = pick(ready.a, ready.b, ready);
    const l = w === ready.a ? ready.b : ready.a;
    losses.set(l, losses.get(l)! + 1);
    played++;
    if (ready.bracket === "GF") {
      ready.done = true;
      ready.winner = w;
      if (w === ready.a) champion = w;
      else reset = { ...ready, round: 2, winner: null, played: false, done: false };
      continue;
    }
    complete(ready, w, l);
  }
  return { champion, losses, played, reset: Boolean(reset), meetings, plan };
}

test("double elimination: every entrant count from 2 to 64 completes with correct loss counts", () => {
  for (let n = 2; n <= 64; n++) {
    for (const seed of [1, 7, 42]) {
      const r = rng(seed * 1000 + n);
      const { champion, losses, played, reset } = simulate(n, (a, b) => (r() < 0.5 ? a : b));
      assert.ok(champion, `no champion for ${n}`);
      assert.ok(losses.get(champion!)! <= 1, `champion lost twice for ${n}`);
      for (const [who, l] of losses) if (who !== champion) assert.equal(l, 2, `${who} has ${l} losses in a ${n}-entrant bracket`);
      assert.equal(played, reset ? 2 * n - 1 : 2 * n - 2, `match count for ${n}`);
    }
  }
});

test("double elimination: bracket reset only when the losers champion wins the grand final", () => {
  // Higher seed (lower number) always wins: winners champion p1 takes the grand final, no reset.
  const favourite = simulate(8, (a, b) => (Number(a.slice(1)) < Number(b.slice(1)) ? a : b));
  assert.equal(favourite.champion, "p1");
  assert.equal(favourite.reset, false);
  // p1 wins everything except the grand final and the reset: p2 becomes champion after a reset.
  const upset = simulate(8, (a, b, m) => {
    if (m.bracket === "GF") return a === "p1" ? b : a;
    return Number(a.slice(1)) < Number(b.slice(1)) ? a : b;
  });
  assert.equal(upset.reset, true);
  assert.equal(upset.champion, "p2");
});

test("double elimination: the first drop round never pairs a player with someone they just beat", () => {
  for (const n of [8, 16, 32]) {
    const seen = new Set<string>();
    const repeatsInFirstDrop: string[] = [];
    simulate(n, (a, b, m) => {
      const pair = [a, b].sort().join("|");
      if (m.bracket === "L" && m.round === 2 && seen.has(pair)) repeatsInFirstDrop.push(pair);
      seen.add(pair);
      return m.bracket === "GF" ? a : Number(a.slice(1)) < Number(b.slice(1)) ? a : b;
    });
    assert.deepEqual(repeatsInFirstDrop, [], `immediate rematches for ${n} entrants`);
  }
});

test("double elimination: byes never route a loser into the losers bracket", () => {
  const plan = planDoubleElimination(["p1", "p2", "p3", "p4", "p5"]);
  const byes = plan.matches.filter((m) => m.bracket === "W" && m.round === 1 && Boolean(m.a) !== Boolean(m.b));
  assert.equal(byes.length, 3);
  const voidSlots = plan.matches.filter((m) => m.bracket === "L" && (m.aVoid || m.bVoid)).length;
  assert.ok(voidSlots >= 2, "losers slots fed by byes are void");
  assert.ok(plan.matches.every((m) => !(m.bracket === "GF" && (m.aVoid || m.bVoid))), "grand final always has two real slots");
});

const line = (over: Partial<StatLine> = {}): StatLine => ({ kills: 0, assists: 0, deaths: 0, headshots: 0, damage: 0, distance: 0, placement: null, ...over });

test("scoring: default weights match the handoff table", () => {
  assert.deepEqual({ ...DEFAULT_WEIGHTS }, { kills: 5, assists: 0.5, headshots: 3, damage: 0.01, distance: 0.002, place1: 80, place2: 40, place3: 15 });
  // 5 kills (25) + 2 assists (1) + 1 headshot (3) + 500 damage (5) + 1000 m (2) + 1st place (80)
  assert.equal(matchPoints(line({ kills: 5, assists: 2, headshots: 1, damage: 500, distance: 1000, placement: 1 })), 116);
  assert.equal(matchPoints(line({ placement: 2 })), 40);
  assert.equal(matchPoints(line({ placement: 3 })), 15);
  assert.equal(matchPoints(line({ damage: 333 })), 3.33);
});

test("scoring: stored weights merge over defaults and ignore invalid values", () => {
  const w = mergeWeights({ kills: 10, place1: "x", distance: -1, unknown: 5 });
  assert.equal(w.kills, 10);
  assert.equal(w.place1, 80);
  assert.equal(w.distance, 0.002);
  assert.equal(mergeWeights(null).assists, 0.5);
});

test("scoring: implausible and impossible lines are flagged for review", () => {
  assert.deepEqual(flagReasons(line({ kills: 3, headshots: 4 })), ["headshots_exceed_kills"]);
  assert.deepEqual(flagReasons(line({ kills: 41, headshots: 1 })), ["kills_extreme"]);
  assert.deepEqual(flagReasons(line({ damage: 6001 })), ["damage_extreme"]);
  assert.deepEqual(flagReasons(line({ distance: 20001 })), ["distance_extreme"]);
  assert.deepEqual(flagReasons(line({ kills: 40, damage: 6000, distance: 20000, headshots: 40 })), []);
});

test("scoring: best-of-N counts only the top lines; KDA then kills break ties; pending lines are excluded", () => {
  const lines = [
    { participantId: "a", ...line({ kills: 10 }), accepted: true, pending: false }, // 50
    { participantId: "a", ...line({ kills: 2 }), accepted: true, pending: false }, // 10
    { participantId: "a", ...line({ kills: 1 }), accepted: true, pending: false }, // 5
    { participantId: "b", ...line({ kills: 12 }), accepted: true, pending: false }, // 60
    { participantId: "b", ...line({ kills: 50 }), accepted: false, pending: true }, // flagged, not counted
    { participantId: "c", ...line({ kills: 8, deaths: 1 }), accepted: true, pending: false }, // 40, KDA 8
    { participantId: "d", ...line({ kills: 8, deaths: 4 }), accepted: true, pending: false }, // 40, KDA 2
    { participantId: "e", ...line({ kills: 6, assists: 20, deaths: 4 }), accepted: true, pending: false }, // 40, KDA 6.5
  ];
  const all = standings(["a", "b", "c", "d", "e"], lines, DEFAULT_WEIGHTS, null);
  assert.deepEqual(all.map((s) => s.participantId), ["a", "b", "c", "e", "d"]);
  assert.equal(all[0].points, 65);
  assert.equal(all.find((s) => s.participantId === "b")!.pending, 1);
  const best2 = standings(["a", "b"], lines, DEFAULT_WEIGHTS, 2);
  assert.equal(best2.find((s) => s.participantId === "a")!.points, 60);
  assert.equal(best2[0].participantId, "a", "a and b share the same counted metrics; stable ID ordering");
  assert.equal(kda(10, 5, 0), 15);
  const tie = standings(["x", "y"], [
    { participantId: "x", ...line({ kills: 2 }), accepted: true, pending: false },
    { participantId: "y", ...line({ kills: 2 }), accepted: true, pending: false },
  ]);
  assert.deepEqual(tie.map((s) => s.rank), [1, 1], "exact ties share a rank");
});
