import test from "node:test";
import assert from "node:assert/strict";
import {
  compatible,
  dodgeMinutes,
  expectedScore,
  pairUnits,
  ratingChanges,
  ratingWindow,
  type QueueUnit,
} from "../src/server/matchmaking-rules.ts";

const t0 = new Date("2026-10-01T12:00:00Z");
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
const unit = (key: string, members: number, rating: number, queuedSecond = 0, region = ""): QueueUnit => ({
  key,
  leaderId: `${key}-0`,
  members: Array.from({ length: members }, (_, i) => `${key}-${i}`),
  rating,
  region,
  queuedAt: at(queuedSecond),
});

test("MV-MATCH-1 rating window widens by the minute and opens after five minutes", () => {
  assert.equal(ratingWindow(0), 200);
  assert.equal(ratingWindow(59), 200);
  assert.equal(ratingWindow(60), 300);
  assert.equal(ratingWindow(299), 600);
  assert.equal(ratingWindow(300), null);
  assert.equal(ratingWindow(-5), 200, "clock skew never narrows the window below the base");
});

test("MV-MATCH-1 compatibility: same size, rating gap within the window, region after two minutes, no open challenge", () => {
  const now = at(30);
  assert.equal(compatible(unit("a", 1, 1000), unit("b", 2, 1000), now), null, "a solo player never meets a party");
  assert.equal(compatible(unit("a", 2, 1000), unit("a", 2, 1000), now), null, "a unit never meets itself");
  const near = compatible(unit("a", 1, 1000), unit("b", 1, 1150), now);
  assert.deepEqual(near, { size: 1, gap: 150, window: 200, region: "any", waitedSeconds: 30 });
  assert.equal(compatible(unit("a", 1, 1000), unit("b", 1, 1350), now), null, "gap 350 is outside the first window");
  assert.ok(compatible(unit("a", 1, 1000, 0), unit("b", 1, 1350, 25), at(120)), "the longer wait (120 s) allows 400");
  assert.equal(compatible(unit("a", 1, 1000), unit("b", 1, 2400), at(299)), null);
  assert.equal(compatible(unit("a", 1, 1000), unit("b", 1, 2400), at(300))?.window, null, "after five minutes any gap is accepted");
  // Regions: same, unstated, different.
  assert.equal(compatible(unit("a", 1, 1000, 0, "MENA"), unit("b", 1, 1000, 0, " mena "), now)?.region, "same", "case and spaces are ignored");
  assert.equal(compatible(unit("a", 1, 1000, 0, "MENA"), unit("b", 1, 1000, 0, ""), now)?.region, "any");
  assert.equal(compatible(unit("a", 1, 1000, 0, "MENA"), unit("b", 1, 1000, 0, "EU"), now), null);
  assert.equal(compatible(unit("a", 1, 1000, 0, "MENA"), unit("b", 1, 1000, 0, "EU"), at(120))?.region, "relaxed");
  // An open challenge between the two leaders keeps them apart.
  assert.equal(compatible(unit("a", 1, 1000), unit("b", 1, 1000), now, (x, y) => x === "a-0" && y === "b-0"), null);
});

test("MV-MATCH-1 pairing: the longest-waiting unit takes the longest-waiting compatible unit; each unit once", () => {
  const units = [unit("d", 1, 1000, 30), unit("a", 1, 1000, 0), unit("p", 2, 1000, 5), unit("c", 1, 1900, 10), unit("b", 1, 1100, 20), unit("q", 2, 1050, 40)];
  const pairs = pairUnits(units, at(45));
  assert.deepEqual(
    pairs.map((p) => [p.a.key, p.b.key]),
    [
      ["a", "b"],
      ["p", "q"],
    ],
    "c is too far in rating; d waits; parties pair with parties",
  );
  assert.deepEqual(pairUnits([...units].reverse(), at(45)).map((p) => [p.a.key, p.b.key]), pairs.map((p) => [p.a.key, p.b.key]), "input order does not matter");
  const later = pairUnits(units, at(310));
  assert.deepEqual(
    later.map((p) => [p.a.key, p.b.key]),
    [
      ["a", "c"],
      ["p", "q"],
      ["b", "d"],
    ],
    "after five minutes the oldest unit takes the oldest other unit",
  );
  assert.deepEqual(pairUnits([unit("solo", 1, 1000)], at(10)), []);
});

test("MV-RATING-1: Elo over side averages, faster first ten matches, floor 100", () => {
  assert.equal(expectedScore(1000, 1000), 0.5);
  const even = ratingChanges([{ userId: "x", rating: 1000, matches: 0 }], [{ userId: "y", rating: 1000, matches: 0 }], "a");
  assert.deepEqual(
    even.map((c) => [c.userId, c.result, c.delta, c.after]),
    [
      ["x", "win", 20, 1020],
      ["y", "loss", -20, 980],
    ],
  );
  const settled = ratingChanges([{ userId: "x", rating: 1000, matches: 30 }], [{ userId: "y", rating: 1000, matches: 30 }], "b");
  assert.deepEqual(settled.map((c) => c.delta), [-10, 10], "K 20 after ten matches");
  // Upset: the lower-rated side wins and gains more.
  const upset = ratingChanges([{ userId: "low", rating: 1000, matches: 20 }], [{ userId: "high", rating: 1400, matches: 20 }], "a");
  assert.deepEqual(upset.map((c) => c.delta), [18, -18]);
  // Parties: each side is its average; each player moves by their own K.
  const party = ratingChanges(
    [
      { userId: "a1", rating: 1100, matches: 20 },
      { userId: "a2", rating: 900, matches: 2 },
    ],
    [
      { userId: "b1", rating: 1000, matches: 20 },
      { userId: "b2", rating: 1000, matches: 20 },
    ],
    "a",
  );
  assert.deepEqual(party.map((c) => [c.userId, c.delta]), [
    ["a1", 10],
    ["a2", 20],
    ["b1", -10],
    ["b2", -10],
  ]);
  const floor = ratingChanges([{ userId: "x", rating: 110, matches: 0 }], [{ userId: "y", rating: 110, matches: 0 }], "b");
  assert.deepEqual(floor.map((c) => [c.after, c.delta]), [
    [100, -10],
    [130, 20],
  ], "the floor caps the loss");
});

test("dodge cooldown grows with repeats within a day", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(dodgeMinutes), [5, 5, 10, 20, 40, 60, 60]);
});
