import test from "node:test";
import assert from "node:assert/strict";
import {
  avoidSameGroup,
  combinePlaces,
  crossGroupOrder,
  firstRoundPairs,
  gauntletPlace,
  groupName,
  groupQualifiers,
  planGauntlet,
  snakeGroups,
  type GroupRow,
  type Qualifier,
} from "../src/server/stages.ts";
import { parseFormatSettings, roundTime, settingsOf } from "../src/server/format-settings.ts";
import { bracketPlacements, type MatchRow } from "../src/server/tournaments.ts";
import type { StandingsRow } from "../src/server/standings.ts";
import { DomainError } from "../src/server/errors.ts";

const throwsCode = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);

const row = (id: string, rank: number | null, over: Partial<StandingsRow> = {}): StandingsRow => ({
  id,
  seed: 1,
  disqualified: rank === null,
  played: 3,
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
  rank,
  annulled: false,
  ...over,
});

test("groups: the snake deals one top seed per group, sizes differ by at most one, full rows balance the seed sums", () => {
  for (let count = 2; count <= 8; count++) {
    for (let n = count * 2; n <= count * 8; n++) {
      const seeds = Array.from({ length: n }, (_, i) => i + 1);
      const groups = snakeGroups(seeds, count);
      assert.equal(groups.length, count);
      assert.deepEqual(groups.flat().sort((a, b) => a - b), seeds, "everyone is placed exactly once");
      const sizes = groups.map((g) => g.length);
      assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `n=${n} count=${count}`);
      groups.forEach((g, i) => assert.equal(g[0], i + 1, "seed i opens group i"));
      if (n % (2 * count) === 0) {
        const sums = groups.map((g) => g.reduce((s, x) => s + x, 0));
        assert.equal(new Set(sums).size, 1, `n=${n} count=${count}: equal seed sums for full snake rows`);
      }
    }
  }
  assert.deepEqual(snakeGroups([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3), [
    [1, 6, 7],
    [2, 5, 8],
    [3, 4, 9, 10],
  ]);
  assert.throws(() => snakeGroups([1, 2], 0));
});

test("groups: names run A…Z, then AA, AB …", () => {
  assert.deepEqual([1, 2, 26, 27, 28, 52, 53].map(groupName), ["A", "B", "Z", "AA", "AB", "AZ", "BA"]);
});

test("gauntlet: the two lowest seeds open, each winner meets the next seed, the top seed plays only the final", () => {
  const { rounds, matches } = planGauntlet([1, 2, 3, 4, 5]);
  assert.equal(rounds, 4);
  assert.deepEqual(
    matches.map((m) => [m.round, m.a, m.b, m.next?.round ?? null]),
    [
      [1, 4, 5, 2],
      [2, 3, null, 3],
      [3, 2, null, 4],
      [4, 1, null, null],
    ],
  );
  assert.ok(matches.every((m) => !m.next || m.next.slot === "b"), "winners climb into slot b");
  assert.deepEqual(planGauntlet(["x", "y"]).matches, [{ round: 1, a: "x", b: "y", next: null }]);
  assert.throws(() => planGauntlet([1]));
  // Places follow the order of elimination: unique, the first loser is last.
  assert.deepEqual([1, 2, 3, 4].map((r) => gauntletPlace(r, 5)), [5, 4, 3, 2]);
});

test("gauntlet placements: unique places by elimination round, the champion first", () => {
  const ids = ["s1", "s2", "s3", "s4", "s5"];
  const plan = planGauntlet(ids);
  // Seed 5 wins its first two steps, then seed 2 beats it, then seed 1 wins the final.
  const winners = ["s5", "s5", "s2", "s1"];
  let climber: string | null = null;
  const matches = plan.matches.map((m, i): MatchRow => {
    const b = m.b ?? climber;
    const w = winners[i];
    climber = w;
    return {
      id: `g${m.round}`, tournament_id: "t", bracket: "G", stage: 1, group_no: 0, round: m.round, position: 0, a_reg: m.a, b_reg: b,
      winner_reg: w, score_a: null, score_b: null, status: "completed", outcome: "played", next_match_id: null, next_slot: null,
      loser_next_match_id: null, loser_next_slot: null, a_void: false, b_void: false,
    };
  });
  const places = bracketPlacements("gauntlet", matches)!;
  assert.deepEqual(Object.fromEntries(places), { s1: 1, s2: 2, s5: 3, s3: 4, s4: 5 });
  // Unfinished: no champion yet, so no places.
  assert.equal(bracketPlacements("gauntlet", matches.map((m) => (m.round === 4 ? { ...m, status: "ready", winner_reg: null } : m))), null);
});

test("qualifiers from groups: winners first across groups by per-game points, then runners-up; disqualified never qualify", () => {
  const groups = new Map<number, StandingsRow[]>([
    [1, [row("a1", 1, { points: 9, played: 3 }), row("a2", 2, { points: 6, played: 3 }), row("a3", 3)]],
    // Group 2 has four entrants: per game, 9 points from 4 games rank below 7 from 3.
    [2, [row("b1", 1, { points: 9, played: 4 }), row("b2", 2, { points: 7, played: 4 }), row("b3", 3), row("bx", null)]],
    [3, [row("c1", 1, { points: 7, played: 3, diff: 5 }), row("cx", null), row("c2", 2, { points: 6, played: 3, diff: 9 })]],
  ]);
  const q = groupQualifiers(groups, 2);
  assert.deepEqual(
    q.map((x) => `${x.id}:${x.group}:${x.groupRank}`),
    ["a1:1:1", "c1:3:1", "b1:2:1", "c2:3:2", "a2:1:2", "b2:2:2"],
  );
  // A group short of qualifiers (disqualifications) simply sends fewer.
  const short = groupQualifiers(new Map([[1, [row("x1", 1), row("x2", null)]], [2, [row("y1", 1), row("y2", 2)]]]), 2);
  assert.deepEqual(short.map((x) => x.id), ["x1", "y1", "y2"]);
  // Ties on every per-game key fall back to group order.
  const tie: GroupRow[] = [{ ...row("p", 1), group: 2 }, { ...row("q", 1), group: 1 }];
  assert.deepEqual([...tie].sort(crossGroupOrder).map((r) => r.id), ["q", "p"]);
});

test("first-round pairs follow the standard seed order; byes leave a seed without a pair", () => {
  assert.deepEqual(firstRoundPairs(8), [
    [0, 7],
    [3, 4],
    [1, 6],
    [2, 5],
  ]);
  assert.deepEqual(firstRoundPairs(6), [
    [3, 4],
    [2, 5],
  ]);
  assert.deepEqual(firstRoundPairs(4), [
    [0, 3],
    [1, 2],
  ]);
});

test("same-group meetings in the first playoff round are removed by swaps inside a rank tier", () => {
  const q = (id: string, group: number, groupRank: number): Qualifier => ({ id, group, groupRank });
  // Seeds 1v4 and 2v3 both pair group-mates; swapping the runners-up fixes both.
  const r = avoidSameGroup([q("A1", 1, 1), q("B1", 2, 1), q("B2", 2, 2), q("A2", 1, 2)]);
  assert.equal(r.clashes, 0);
  assert.deepEqual(r.seeded.map((x) => x.id), ["A1", "B1", "A2", "B2"]);
  // Eight qualifiers from four groups, with every first-round pair a clash before the swaps.
  const eight = [q("A1", 1, 1), q("B1", 2, 1), q("C1", 3, 1), q("D1", 4, 1), q("D2", 4, 2), q("C2", 3, 2), q("B2", 2, 2), q("A2", 1, 2)];
  const before = firstRoundPairs(8).filter(([a, b]) => eight[a].group === eight[b].group).length;
  assert.equal(before, 4);
  const fixed = avoidSameGroup(eight);
  assert.equal(fixed.clashes, 0);
  fixed.seeded.slice(0, 4).forEach((x) => assert.equal(x.groupRank, 1, "group winners keep the top seeds"));
  assert.deepEqual(new Set(fixed.seeded.map((x) => x.id)), new Set(eight.map((x) => x.id)));
  // Randomised fields: whenever a swap can help, no clash is left; the tiers never change.
  let s = 7;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let trial = 0; trial < 300; trial++) {
    const groups = 2 + Math.floor(rnd() * 7);
    const advance = 1 + Math.floor(rnd() * 3);
    const list: Qualifier[] = [];
    for (let tier = 1; tier <= advance; tier++) {
      const order = Array.from({ length: groups }, (_, i) => i + 1).sort(() => rnd() - 0.5);
      for (const g of order) list.push(q(`${g}-${tier}`, g, tier));
    }
    if (list.length < 2) continue;
    const out = avoidSameGroup(list);
    assert.deepEqual(out.seeded.map((x) => x.groupRank), list.map((x) => x.groupRank), "ranks stay in their tiers");
    if (groups >= 2 && advance <= 2) assert.equal(out.clashes, 0, `groups=${groups} advance=${advance}`);
  }
  // Nothing to swap with: the clash is reported, not hidden.
  assert.equal(avoidSameGroup([q("A1", 1, 1), q("A2", 1, 2)]).clashes, 1);
});

test("final places: the playoff first, then the main stage; equal keys share a place", () => {
  const playoff = new Map([
    ["p1", 1],
    ["p2", 2],
    ["p3", 3],
    ["p4", 3],
  ]);
  const places = combinePlaces(playoff, [
    { id: "a3", key: 3 },
    { id: "b3", key: 3 },
    { id: "c3", key: 3 },
    { id: "a4", key: 4 },
    { id: "b4", key: 4 },
  ]);
  assert.deepEqual(Object.fromEntries(places), { p1: 1, p2: 2, p3: 3, p4: 3, a3: 5, b3: 5, c3: 5, a4: 8, b4: 8 });
  // A disqualified playoff entrant without a place still takes a playoff slot.
  const withGap = combinePlaces(new Map([["p1", 1], ["p2", 2], ["p3", 3]]), [{ id: "x", key: 5 }], 4);
  assert.equal(withGap.get("x"), 5);
  // Table ranks are unique: places continue one by one.
  assert.deepEqual([...combinePlaces(new Map([["w", 1], ["l", 2]]), [{ id: "t3", key: 3 }, { id: "t4", key: 4 }]).values()], [1, 2, 3, 4]);
});

test("stage settings: groups imply a playoff of groups × advancing; limits are enforced; old settings have no playoff", () => {
  const g = parseFormatSettings("groups", { groupCount: "4", groupAdvance: "2" })!;
  assert.deepEqual(g.groups, { count: 4, advance: 2 });
  assert.deepEqual(g.playoff, { format: "single_elimination", size: 8 });
  assert.equal(g.stages, "MV-STAGES-1");
  assert.equal(g.disqualification, "annul");
  assert.deepEqual(parseFormatSettings("groups", { groupCount: "8", groupAdvance: "2", playoffFormat: "double_elimination", playoffSize: "3" })!.playoff, {
    format: "double_elimination",
    size: 16,
  });
  throwsCode(() => parseFormatSettings("groups", { groupCount: "1" }), "invalid_stage_settings");
  throwsCode(() => parseFormatSettings("groups", { groupCount: "33" }), "invalid_stage_settings");
  throwsCode(() => parseFormatSettings("groups", { groupCount: "4", groupAdvance: "17" }), "invalid_stage_settings");
  throwsCode(() => parseFormatSettings("groups", { groupCount: "32", groupAdvance: "3" }), "invalid_stage_settings");
  throwsCode(() => parseFormatSettings("groups", { groupCount: "4", groupAdvance: "5", playoffFormat: "gauntlet" }), "gauntlet_limit");
  throwsCode(() => parseFormatSettings("groups", { playoffFormat: "triple" }), "invalid_stage_settings");

  const rr = parseFormatSettings("round_robin", { playoffFormat: "gauntlet", playoffSize: "4", roundHours: "24" })!;
  assert.deepEqual(rr.playoff, { format: "gauntlet", size: 4 });
  assert.equal(rr.roundHours, 24);
  assert.equal(parseFormatSettings("swiss", {})!.playoff, null);
  assert.equal(parseFormatSettings("swiss", {})!.stages, undefined);
  throwsCode(() => parseFormatSettings("swiss", { playoffFormat: "single_elimination", playoffSize: "1" }), "invalid_stage_settings");
  throwsCode(() => parseFormatSettings("swiss", { playoffFormat: "single_elimination", playoffSize: "65" }), "invalid_stage_settings");
  throwsCode(() => parseFormatSettings("round_robin", { playoffFormat: "gauntlet", playoffSize: "17" }), "gauntlet_limit");
  throwsCode(() => parseFormatSettings("round_robin", { roundHours: "721" }), "invalid_stage_settings");
  throwsCode(() => parseFormatSettings("round_robin", { roundHours: "1.5" }), "invalid_stage_settings");
  assert.equal(parseFormatSettings("gauntlet", {}), null, "bracket formats carry no round settings");

  // Settings stored by release 3 read as before: no playoff, no schedule.
  const legacy = settingsOf({ format: "round_robin", format_settings: { v: 1, points: { win: 3, draw: 1, loss: 0, bye: 0 }, allowDraws: false, legs: 1, standings: "MV-STANDINGS-1" } });
  assert.equal(legacy.playoff, null);
  assert.equal(legacy.roundHours, 0);
  assert.equal(legacy.disqualification, "forfeit");
});

test("round dates: round r at the start plus (r − 1) × interval; without an interval only round 1 is dated", () => {
  const start = "2030-01-01T12:00:00.000Z";
  assert.equal(roundTime(start, 1, 24), start);
  assert.equal(roundTime(start, 3, 24), "2030-01-03T12:00:00.000Z");
  assert.equal(roundTime(start, 2, 2), "2030-01-01T14:00:00.000Z");
  assert.equal(roundTime(start, 1, 0), start);
  assert.equal(roundTime(start, 2, 0), null);
});
