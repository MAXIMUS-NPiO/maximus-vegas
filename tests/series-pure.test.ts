import test from "node:test";
import assert from "node:assert/strict";
import {
  bracketDepth,
  bracketPart,
  DEFAULT_SERIES,
  parseGroup,
  parseMatchOverride,
  parseSeriesRules,
  pointsOf,
  seriesCustomised,
  seriesMap,
  seriesOf,
  seriesRulesOf,
  seriesScoreValid,
  winsNeeded,
  type SeriesMatch,
} from "../src/server/series.ts";
import { findConflicts, planWaves, type Slot } from "../src/server/conflicts.ts";
import { admissionOf, parseAdmission, unmetCriteria } from "../src/server/admission.ts";
import { computeStandings, type StandingsMatch } from "../src/server/standings.ts";
import { DomainError } from "../src/server/errors.ts";

const throwsCode = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
const P = { win: 3, draw: 1, loss: 0, bye: 0 };

test("series rules: defaults, levels, rows, and refusals", () => {
  assert.deepEqual(parseSeriesRules({}, "single_elimination"), DEFAULT_SERIES);
  assert.equal(seriesCustomised(parseSeriesRules({}, "single_elimination")), false);
  const r = parseSeriesRules(
    {
      seriesBestOf: "1",
      seriesPlayoff: "3",
      seriesSemifinal: "bo3",
      seriesFinal: "5",
      seriesLower: "",
      seriesRound1: "3",
      seriesRound1BestOf: "",
      seriesRound1Win: "6",
      seriesRound1Draw: "2",
      seriesRound1Loss: "0",
      seriesRound2: "",
      seriesGroup1: "b",
      seriesGroup1BestOf: "3",
      seriesGroup2: "A",
      seriesGroup2Win: "2",
      seriesGroup2Draw: "1",
      seriesGroup2Loss: "0",
      seriesGroup3: "C",
    },
    "groups",
  );
  assert.equal(r.bestOf, 1);
  assert.equal(r.playoff, 3);
  assert.equal(r.semifinal, 3);
  assert.equal(r.final, 5);
  assert.equal(r.lower, undefined, "empty = inherited");
  assert.deepEqual(r.rounds, [{ round: 3, points: { win: 6, draw: 2, loss: 0, bye: 0 } }]);
  assert.deepEqual(r.groups, [{ group: 1, points: { win: 2, draw: 1, loss: 0, bye: 0 } }, { group: 2, bestOf: 3 }], "sorted, empty rows skipped");
  assert.equal(seriesCustomised(r), true);
  // Swiss rows carry a bye (defaulting to the win).
  assert.deepEqual(parseSeriesRules({ seriesRound1: "2", seriesRound1Win: "4", seriesRound1Draw: "2", seriesRound1Loss: "0" }, "swiss").rounds[0].points, { win: 4, draw: 2, loss: 0, bye: 4 });
  throwsCode(() => parseSeriesRules({ seriesBestOf: "2" }, "swiss"), "invalid_series");
  throwsCode(() => parseSeriesRules({ seriesFinal: "9" }, "swiss"), "invalid_series");
  throwsCode(() => parseSeriesRules({ seriesRound1: "0", seriesRound1BestOf: "3" }, "swiss"), "invalid_series");
  throwsCode(() => parseSeriesRules({ seriesRound1: "2", seriesRound1BestOf: "3", seriesRound2: "2", seriesRound2BestOf: "5" }, "swiss"), "invalid_series");
  throwsCode(() => parseSeriesRules({ seriesRound1: "2", seriesRound1Win: "3" }, "swiss"), "invalid_points");
  throwsCode(() => parseSeriesRules({ seriesGroup1: "A", seriesGroup1Win: "0", seriesGroup1Draw: "1", seriesGroup1Loss: "2" }, "groups"), "invalid_points");
  throwsCode(() => parseSeriesRules({ seriesGroup1: "A1", seriesGroup1BestOf: "3" }, "groups"), "invalid_series");
  assert.equal(parseGroup("aa"), 27);
  assert.equal(parseGroup("12"), 12);
  assert.equal(parseGroup(""), null);
  throwsCode(() => parseGroup("ZZ"), "invalid_series");
});

test("series rules: stored JSON is read defensively", () => {
  assert.deepEqual(seriesRulesOf({ series_rules: null }), { ...DEFAULT_SERIES, groups: [], rounds: [] });
  const r = seriesRulesOf({ series_rules: { bestOf: 4, final: 5, playoff: "3", rounds: [{ round: 2, bestOf: 3, points: { win: 1, draw: 2, loss: 0, bye: 0 } }, { round: "x" }], groups: "nope" } });
  assert.equal(r.bestOf, 1, "an invalid length falls back to best of 1");
  assert.equal(r.final, 5);
  assert.equal(r.playoff, undefined);
  assert.deepEqual(r.rounds, [{ round: 2, bestOf: 3 }], "invalid points are dropped");
  assert.deepEqual(r.groups, []);
});

test("series inheritance: tournament → playoff → lower bracket → group → round → match", () => {
  const rules = parseSeriesRules(
    { seriesBestOf: "1", seriesPlayoff: "3", seriesSemifinal: "3", seriesFinal: "5", seriesLower: "3", seriesRound1: "2", seriesRound1BestOf: "3", seriesGroup1: "B", seriesGroup1BestOf: "5" },
    "groups",
  );
  // Single elimination with 3 rounds: the final, the semi-finals and an ordinary first round.
  const se: SeriesMatch[] = [1, 2, 3].map((round) => ({ stage: 1, bracket: "W", round, group_no: 0 }));
  const formats = { main: "single_elimination" };
  const depth = bracketDepth(se);
  assert.deepEqual(se.map((m) => seriesOf(rules, m, formats, depth)), [
    { bestOf: 1, source: "tournament" },
    { bestOf: 3, source: "semifinal" },
    { bestOf: 5, source: "final" },
  ]);
  assert.equal(bracketPart(se[2], formats, depth), "final");
  // Double elimination: upper and lower finals are "semi-finals", the grand final and its reset are "the final".
  const de: SeriesMatch[] = [
    { stage: 1, bracket: "W", round: 1 },
    { stage: 1, bracket: "W", round: 2 },
    { stage: 1, bracket: "L", round: 1 },
    { stage: 1, bracket: "L", round: 2 },
    { stage: 1, bracket: "GF", round: 1 },
    { stage: 1, bracket: "GF", round: 2 },
  ];
  const dd = bracketDepth(de);
  assert.deepEqual(
    de.map((m) => seriesOf(rules, m, { main: "double_elimination" }, dd).source),
    ["tournament", "semifinal", "lower", "semifinal", "final", "final"],
  );
  const noSemi = { ...rules, semifinal: undefined };
  assert.equal(seriesOf(noSemi, de[3], { main: "double_elimination" }, dd).source, "lower", "the lower final falls back to the lower bracket");
  // Groups: round beats group; the playoff after the groups uses its own rule.
  assert.deepEqual(seriesOf(rules, { stage: 1, bracket: "RR", round: 2, group_no: 2 }, { main: "groups", playoff: "single_elimination" }, new Map()), { bestOf: 3, source: "round" });
  assert.deepEqual(seriesOf(rules, { stage: 1, bracket: "RR", round: 1, group_no: 2 }, { main: "groups" }, new Map()), { bestOf: 5, source: "group" });
  assert.deepEqual(seriesOf(rules, { stage: 1, bracket: "RR", round: 1, group_no: 1 }, { main: "groups" }, new Map()), { bestOf: 1, source: "tournament" });
  const playoff: SeriesMatch[] = [1, 2, 3].map((round) => ({ stage: 2, bracket: "W", round }));
  const pd = bracketDepth(playoff);
  assert.deepEqual(
    playoff.map((m) => seriesOf(rules, m, { main: "groups", playoff: "single_elimination" }, pd).source),
    ["playoff", "semifinal", "final"],
  );
  // Gauntlet: the last step is the final.
  const g: SeriesMatch[] = [1, 2, 3].map((round) => ({ stage: 1, bracket: "G", round }));
  assert.deepEqual(g.map((m) => seriesOf(rules, m, { main: "gauntlet" }, bracketDepth(g)).bestOf), [1, 3, 5]);
  // A match override beats everything.
  assert.deepEqual(seriesOf(rules, { ...se[0], series_override: 7 }, formats, depth), { bestOf: 7, source: "match" });
  assert.equal(seriesOf(rules, { ...se[0], series_override: 2 }, formats, depth).source, "tournament", "an invalid override is ignored");
  const map = seriesMap(rules, se.map((m, i) => ({ ...m, id: `m${i}` })), formats);
  assert.deepEqual([...map.values()], [1, 3, 5]);
});

test("points by level and series scores", () => {
  const rules = parseSeriesRules(
    { seriesRound1: "3", seriesRound1Win: "6", seriesRound1Draw: "2", seriesRound1Loss: "0", seriesGroup1: "A", seriesGroup1Win: "2", seriesGroup1Draw: "1", seriesGroup1Loss: "0" },
    "groups",
  );
  assert.deepEqual(pointsOf(rules, P, { round: 3, group_no: 1 }).source, "round", "round beats group");
  assert.deepEqual(pointsOf(rules, P, { round: 1, group_no: 1 }), { points: { win: 2, draw: 1, loss: 0, bye: 0 }, source: "group" });
  assert.deepEqual(pointsOf(rules, P, { round: 1, group_no: 2 }), { points: P, source: "tournament" });
  assert.deepEqual(pointsOf(rules, P, { round: 3, group_no: 1, points_override: { win: 9, draw: 4, loss: 1, bye: 0 } }).source, "match");
  assert.equal(pointsOf(rules, P, { round: 1, group_no: 2, points_override: { win: 0, draw: 4, loss: 1, bye: 0 } }).source, "tournament", "invalid override ignored");
  assert.equal(seriesScoreValid(1, 16, 14), true);
  assert.equal(seriesScoreValid(1, 7, 7), true, "best of 1 leaves draws to the draw rule");
  for (const [a, b] of [[2, 0], [2, 1], [0, 2], [1, 2]]) assert.equal(seriesScoreValid(3, a, b), true);
  for (const [a, b] of [[1, 0], [3, 0], [2, 2], [1, 1], [16, 12]]) assert.equal(seriesScoreValid(3, a, b), false, `${a}:${b} in Bo3`);
  assert.equal(seriesScoreValid(5, 3, 2), true);
  assert.equal(seriesScoreValid(7, 4, 3), true);
  assert.equal(seriesScoreValid(7, 4, 4), false);
  assert.deepEqual([1, 3, 5, 7].map(winsNeeded), [1, 2, 3, 4]);
  assert.deepEqual(parseMatchOverride({ series: "5", pointsWin: "4", pointsDraw: "2", pointsLoss: "1" }, true, false), { series: 5, points: { win: 4, draw: 2, loss: 1, bye: 0 } });
  assert.deepEqual(parseMatchOverride({ series: "", pointsWin: "4", pointsDraw: "2", pointsLoss: "1" }, false, false), { series: null, points: null }, "bracket matches carry no points");
  throwsCode(() => parseMatchOverride({ series: "4" }, false, false), "invalid_series");
});

test("standings: per-match points and head-to-head with the points actually earned", () => {
  const e = ["a", "b", "c"].map((id, i) => ({ id, seed: i + 1 }));
  const m = (a: string, b: string, winner: string | null, points?: typeof P): StandingsMatch => ({ a, b, winner, scoreA: 1, scoreB: 0, outcome: "played", status: "completed", ...(points ? { points } : {}) });
  // a beat b in a double-points round, b beat c, c beat a: a and b both reach 6 points only with the override.
  const rows = computeStandings("round_robin", e, [m("a", "b", "a", { win: 6, draw: 2, loss: 0, bye: 0 }), m("b", "c", "b"), m("c", "a", "c")], P);
  const by = new Map(rows.map((r) => [r.id, r]));
  assert.equal(by.get("a")!.points, 6);
  assert.equal(by.get("b")!.points, 3);
  assert.equal(by.get("c")!.points, 3);
  assert.equal(rows[0].id, "a");
  assert.equal(by.get("b")!.headToHead, 3, "b and c are tied: b's win over c earned 3");
  assert.equal(by.get("c")!.headToHead, 0);
});

test("schedule conflicts: venues, entrants and players across tournaments; waves over venues", () => {
  const at = Date.UTC(2030, 0, 1, 12);
  const slot = (id: string, start: number, over: Partial<Slot> = {}): Slot => ({ id, tournamentId: "t1", start, minutes: 60, venue: null, regs: [], users: [], ...over });
  const x = slot("x", at, { venue: "v1", regs: ["r1", "r2"], users: ["u1", "u2"] });
  const y = slot("y", at + 30 * 60_000, { venue: "v1", regs: ["r3", "r4"], users: ["u3", "u4"] });
  const z = slot("z", at + 60 * 60_000, { venue: "v1", regs: ["r1", "r5"], users: ["u1", "u5"] });
  const other = slot("o", at + 10 * 60_000, { tournamentId: "t2", venue: "v1", regs: ["q1"], users: ["u4"] });
  const c = findConflicts([x, y, z], [other]);
  assert.deepEqual(
    c.map((k) => `${k.kind}:${k.a}:${k.b}`),
    ["player:o:y", "venue:x:y", "venue:y:z"],
    "x and z touch but do not overlap; another tournament's venue id never clashes; its player does",
  );
  const same = findConflicts([x, slot("w", at + 15 * 60_000, { regs: ["r2", "r9"], users: ["u2", "u9"] })]);
  assert.deepEqual(same.map((k) => k.kind), ["entrant"], "a shared entrant is reported once, not again per player");
  assert.deepEqual(findConflicts([x], [slot("n", at + 60 * 60_000, { venue: "v1", users: ["u1"] })]), [], "back to back is fine");
  const waves = planWaves(["m1", "m2", "m3", "m4", "m5"], ["A", "B"], at, 45);
  assert.deepEqual(
    waves.map((w) => [w.match, w.venue, (w.start - at) / 60_000]),
    [["m1", "A", 0], ["m2", "B", 0], ["m3", "A", 45], ["m4", "B", 45], ["m5", "A", 90]],
  );
  assert.deepEqual(planWaves(["m1"], [], at, 60), []);
});

test("admission criteria: parsing, stored values and what a player misses", () => {
  assert.equal(parseAdmission({}), null);
  assert.equal(parseAdmission({ minXp: "0", minMatches: "" }), null, "zero means no criterion");
  const a = parseAdmission({ emailVerified: "on", minAccountDays: "30", minXp: "500", minMatches: "5" })!;
  assert.deepEqual(a, { emailVerified: true, minAccountDays: 30, minXp: 500, minMatches: 5 });
  throwsCode(() => parseAdmission({ minAccountDays: "-1" }), "invalid_input");
  assert.deepEqual(admissionOf({ admission: { emailVerified: "yes", minXp: 10.5, minMatches: 3 } }), { emailVerified: false, minAccountDays: null, minXp: null, minMatches: 3 });
  assert.equal(admissionOf({ admission: null }), null);
  const p = { userId: "u", emailVerified: false, accountDays: 29, xp: 500, matches: 4 };
  assert.deepEqual(unmetCriteria(a, p), ["admission_email", "admission_account_age", "admission_matches"]);
  assert.deepEqual(unmetCriteria(a, { ...p, emailVerified: true, accountDays: 30, matches: 5 }), []);
});
