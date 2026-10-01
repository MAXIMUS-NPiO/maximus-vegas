import test from "node:test";
import assert from "node:assert/strict";
import { planRepair, type Node } from "../src/server/repair.ts";
import { DomainError } from "../src/server/errors.ts";

const node = (id: string, over: Partial<Node>): Node => ({
  id,
  bracket: "W",
  round: 1,
  position: 1,
  a_reg: null,
  b_reg: null,
  a_void: false,
  b_void: false,
  status: "pending",
  outcome: null,
  winner_reg: null,
  score_a: null,
  score_b: null,
  next_match_id: null,
  next_slot: null,
  loser_next_match_id: null,
  loser_next_slot: null,
  results: 0,
  ...over,
});
const played = (winner: string, a: string, b: string, extra: Partial<Node> = {}): Partial<Node> => ({
  a_reg: a,
  b_reg: b,
  status: "completed",
  outcome: "played",
  winner_reg: winner,
  score_a: winner === a ? 2 : 0,
  score_b: winner === a ? 0 : 2,
  results: 1,
  ...extra,
});
const kinds = (steps: { kind: string; matchId: string }[]) => steps.map((s) => `${s.kind}:${s.matchId}`);
const throws = (f: () => unknown, code: string) => assert.throws(f, (e: unknown) => e instanceof DomainError && e.code === code);

/** Single elimination of eight: QF1..QF4 → SF1, SF2 → F. */
function eight(over: Record<string, Partial<Node>> = {}) {
  const base: Record<string, Partial<Node>> = {
    qf1: { round: 1, position: 1, next_match_id: "sf1", next_slot: "a", ...played("A", "A", "B") },
    qf2: { round: 1, position: 2, next_match_id: "sf1", next_slot: "b", ...played("C", "C", "D") },
    qf3: { round: 1, position: 3, next_match_id: "sf2", next_slot: "a", ...played("E", "E", "F") },
    qf4: { round: 1, position: 4, next_match_id: "sf2", next_slot: "b", ...played("G", "G", "H") },
    sf1: { round: 2, position: 1, next_match_id: "f", next_slot: "a", a_reg: "A", b_reg: "C", status: "ready" },
    sf2: { round: 2, position: 2, next_match_id: "f", next_slot: "b", a_reg: "E", b_reg: "G", status: "ready" },
    f: { round: 3, position: 1, status: "pending" },
  };
  return Object.entries(base).map(([id, b]) => node(id, { ...b, ...(over[id] ?? {}) }));
}

test("a dependent match that has not started only changes its entrant", () => {
  const plan = planRepair(eight(), "qf1", "B");
  assert.deepEqual(plan.steps, [{ kind: "replace", matchId: "sf1", slot: "a", from: "A", to: "B" }]);
  assert.equal(plan.reopens, false);
  assert.equal(planRepair(eight(), "qf1", "A").steps.length, 0, "the same winner changes nothing");
});

test("a played semi-final is replayed and the final loses the entrant it gave", () => {
  const nodes = eight({ sf1: played("A", "A", "C"), f: { a_reg: "A", status: "pending" } });
  const plan = planRepair(nodes, "qf1", "B");
  assert.deepEqual(kinds(plan.steps), ["replay:sf1", "replace:f"]);
  assert.deepEqual(plan.steps[0], { kind: "replay", matchId: "sf1", slot: "a", from: "A", to: "B", annulled: { winner: "A", scoreA: 2, scoreB: 0, outcome: "played" } });
  assert.deepEqual(plan.steps[1], { kind: "replace", matchId: "f", slot: "a", from: "A", to: null });
  assert.equal(plan.reopens, false);
});

test("a replayed final reopens the event; the hash changes with the plan", () => {
  // C beat A in the semi-final and won the final: once the semi-final is replayed, C's final is unearned too.
  const finished = eight({ sf1: played("C", "A", "C"), sf2: played("E", "E", "G"), f: played("C", "C", "E") });
  const plan = planRepair(finished, "qf1", "B");
  assert.deepEqual(kinds(plan.steps), ["replay:sf1", "replay:f"]);
  assert.deepEqual(plan.steps[1], { kind: "replay", matchId: "f", slot: "a", from: "C", to: null, annulled: { winner: "C", scoreA: 2, scoreB: 0, outcome: "played" } });
  assert.equal(plan.reopens, true);
  const other = planRepair(eight({ sf1: played("A", "A", "C"), sf2: played("E", "E", "G"), f: played("A", "A", "E") }), "qf1", "B");
  assert.deepEqual(kinds(other.steps), ["replay:sf1", "replay:f"]);
  assert.notEqual(plan.hash, other.hash, "different consequences, different plan");
  assert.equal(planRepair(finished, "qf1", "B").hash, plan.hash, "the same bracket gives the same plan");
});

test("double elimination: the corrected loser moves through the lower bracket too", () => {
  const nodes = [
    node("w1", { round: 1, position: 1, next_match_id: "w2", next_slot: "a", loser_next_match_id: "l1", loser_next_slot: "a", ...played("A", "A", "B") }),
    node("w2", { round: 2, position: 1, a_reg: "A", b_reg: "C", status: "ready", next_match_id: "gf", next_slot: "a" }),
    node("l1", { bracket: "L", round: 1, position: 1, next_match_id: "l2", next_slot: "a", ...played("B", "B", "D") }),
    node("l2", { bracket: "L", round: 2, position: 1, a_reg: "B", status: "pending", next_match_id: "gf", next_slot: "b" }),
    node("gf", { bracket: "GF", round: 1, position: 0 }),
  ];
  const plan = planRepair(nodes, "w1", "B");
  assert.deepEqual(kinds(plan.steps), ["replace:w2", "replay:l1", "replace:l2"]);
  assert.deepEqual(plan.steps[1], { kind: "replay", matchId: "l1", slot: "a", from: "B", to: "A", annulled: { winner: "B", scoreA: 2, scoreB: 0, outcome: "played" } });
  assert.deepEqual(plan.steps[2], { kind: "replace", matchId: "l2", slot: "a", from: "B", to: null });
});

test("grand final: reversing the losers champion's win removes the played reset", () => {
  const nodes = [
    node("gf", { bracket: "GF", round: 1, position: 0, ...played("Y", "X", "Y") }),
    node("reset", { bracket: "GF", round: 2, position: 0, ...played("Y", "X", "Y") }),
  ];
  const plan = planRepair(nodes, "gf", "X");
  assert.deepEqual(plan.steps, [{ kind: "remove_reset", matchId: "reset", annulled: { winner: "Y", scoreA: 0, scoreB: 2, outcome: "played" } }]);
  assert.equal(planRepair(nodes, "gf", "Y").steps.length, 0);
});

test("a bye passes the corrected entrant on; the match after it is replayed", () => {
  const nodes = [
    node("m1", { round: 1, position: 1, next_match_id: "m2", next_slot: "a", ...played("A", "A", "B") }),
    node("m2", { round: 2, position: 1, next_match_id: "m3", next_slot: "a", a_reg: "A", b_void: true, status: "completed", outcome: "bye", winner_reg: "A" }),
    node("m3", { round: 3, position: 1, ...played("A", "A", "C") }),
  ];
  const plan = planRepair(nodes, "m1", "B");
  assert.deepEqual(kinds(plan.steps), ["replace:m2", "replay:m3"]);
  assert.equal(plan.reopens, true, "m3 is the final");
});

test("refusals: round formats, byes, undecided matches, unknown winners, a bracket that no longer matches", () => {
  throws(() => planRepair([node("r", { bracket: "SW", ...played("A", "A", "B") })], "r", "B"), "not_editable");
  throws(() => planRepair([node("b", { a_reg: "A", b_void: true, status: "completed", outcome: "bye", winner_reg: "A" })], "b", "A"), "not_editable");
  throws(() => planRepair(eight(), "sf1", "A"), "not_editable");
  throws(() => planRepair(eight(), "qf1", "Z"), "invalid_input");
  throws(() => planRepair(eight({ sf1: { a_reg: "Q", b_reg: "C", status: "ready" } }), "qf1", "B"), "dependent_match_played");
  throws(() => planRepair(eight({ sf1: { a_reg: "A", b_reg: "C", status: "cancelled" } }), "qf1", "B"), "dependent_match_played");
  throws(() => planRepair(eight(), "nope", "A"), "not_found");
});
