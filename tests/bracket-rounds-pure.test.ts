import test from "node:test";
import assert from "node:assert/strict";
import { roundSummary } from "../src/lib/bracket-rounds.ts";
import type { BracketMatch } from "../src/server/queries.ts";

let n = 0;
const m = (round: number, status: string, a: string | null, b: string | null, extra: Partial<BracketMatch> = {}): BracketMatch => ({
  id: `m${++n}`,
  round,
  position: n,
  status,
  outcome: status === "completed" ? "played" : null,
  a_reg: a,
  b_reg: b,
  a_name: a,
  b_name: b,
  winner_reg: status === "completed" ? a : null,
  score_a: null,
  score_b: null,
  scheduled_at: null,
  ...extra,
});

test("the round being played is the first with an open match; empty slots are not counted", () => {
  const matches = [
    m(1, "completed", "A", "B"),
    m(1, "completed", "C", "D"),
    m(1, "pending", null, null, { a_void: true, b_void: true }),
    m(2, "ready", "A", "C"),
    m(2, "pending", null, "E"),
    m(3, "pending", null, null),
  ];
  const s = roundSummary(matches, new Set(["C"]));
  assert.equal(s.current, 2);
  assert.deepEqual(
    s.rounds.map((r) => [r.round, r.done, r.total, r.mine]),
    [
      [1, 2, 2, false],
      [2, 0, 2, true],
      [3, 0, 1, false],
    ],
  );
  assert.equal(s.myMatch, matches[3].id, "the viewer's first open match");
});

test("a finished bracket points at its last round; nobody's match without entries", () => {
  const matches = [m(1, "completed", "A", "B"), m(2, "completed", "A", "C")];
  const s = roundSummary(matches);
  assert.equal(s.current, 2);
  assert.equal(s.myMatch, null);
  assert.ok(s.rounds.every((r) => !r.mine));
  assert.deepEqual(roundSummary([]), { rounds: [], current: null, myMatch: null });
});

test("completed and cancelled matches of the viewer do not mark a round", () => {
  const s = roundSummary([m(1, "completed", "A", "B"), m(2, "cancelled", "A", "C"), m(3, "ready", "D", "E")], new Set(["A"]));
  assert.deepEqual(
    s.rounds.map((r) => r.mine),
    [false, false, false],
  );
  assert.equal(s.current, 3);
  assert.equal(s.myMatch, null);
});
