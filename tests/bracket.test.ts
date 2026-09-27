import test from "node:test";
import assert from "node:assert/strict";
import { bracketSize, planSingleElimination, seedOrder, placementForLoss } from "../src/server/bracket.ts";
import { zonedToUtc } from "../src/server/validate.ts";

test("bracket size rounds up to a power of two", () => {
  assert.equal(bracketSize(2), 2);
  assert.equal(bracketSize(3), 4);
  assert.equal(bracketSize(5), 8);
  assert.equal(bracketSize(17), 32);
  assert.throws(() => bracketSize(1));
});

test("standard seed order keeps seeds 1 and 2 on opposite halves", () => {
  assert.deepEqual(seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
  for (const size of [4, 8, 16, 32, 64]) {
    const order = seedOrder(size);
    assert.equal(new Set(order).size, size);
    assert.ok(order.indexOf(1) < size / 2 && order.indexOf(2) >= size / 2);
  }
});

test("every participant count from 2 to 130 yields a valid bracket with byes on top seeds", () => {
  for (let n = 2; n <= 130; n++) {
    const people = Array.from({ length: n }, (_, i) => i + 1);
    const { rounds, matches } = planSingleElimination(people);
    const size = bracketSize(n);
    assert.equal(rounds, Math.log2(size));
    assert.equal(matches.length, size - 1);
    const first = matches.filter((m) => m.round === 1);
    const seen = first.flatMap((m) => [m.a, m.b]).filter((x) => x !== null);
    assert.equal(seen.length, n, `n=${n}`);
    assert.equal(new Set(seen).size, n);
    for (const m of first) assert.ok(m.a !== null || m.b !== null, `double bye n=${n}`);
    const byes = first.filter((m) => m.a === null || m.b === null).map((m) => (m.a ?? m.b) as number);
    assert.equal(byes.length, size - n);
    assert.deepEqual([...byes].sort((a, b) => a - b), people.slice(0, size - n));
    for (const m of matches) {
      if (m.round === rounds) assert.equal(m.next, null);
      else assert.ok(matches.some((x) => x.round === m.next!.round && x.position === m.next!.position));
    }
  }
});

test("placements follow the elimination round", () => {
  assert.equal(placementForLoss(3, 3), 2);
  assert.equal(placementForLoss(2, 3), 3);
  assert.equal(placementForLoss(1, 3), 5);
});

test("wall-clock time converts from the user's time zone to UTC", () => {
  assert.equal(zonedToUtc("2026-10-01T18:00", "Asia/Dubai").toISOString(), "2026-10-01T14:00:00.000Z");
  assert.equal(zonedToUtc("2026-07-01T12:00", "Europe/London").toISOString(), "2026-07-01T11:00:00.000Z");
  assert.equal(zonedToUtc("2026-01-15T12:00", "Europe/London").toISOString(), "2026-01-15T12:00:00.000Z");
  assert.equal(zonedToUtc("2026-01-15T12:00", "Not/AZone").toISOString(), "2026-01-15T12:00:00.000Z");
  assert.throws(() => zonedToUtc("tomorrow", "UTC"));
});
