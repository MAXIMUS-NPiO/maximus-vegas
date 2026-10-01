import test from "node:test";
import assert from "node:assert/strict";
import { clanTag, isRated, isSeason, ladderChange, seasonBounds, seasonOf, seasonsBetween, seriesWinner, winsNeeded } from "../src/server/ladder-rules.ts";

test("a season is a calendar quarter in UTC", () => {
  assert.equal(seasonOf(new Date("2026-10-01T00:00:00Z")), "2026-Q4");
  assert.equal(seasonOf(new Date("2026-03-31T23:59:59Z")), "2026-Q1");
  assert.equal(seasonOf(new Date("2026-04-01T00:00:00Z")), "2026-Q2");
  assert.deepEqual(seasonBounds("2026-Q4"), { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2027-01-01T00:00:00Z") });
  assert.deepEqual(seasonBounds("2027-Q1"), { start: new Date("2027-01-01T00:00:00Z"), end: new Date("2027-04-01T00:00:00Z") });
  assert.equal(seasonBounds("2026-Q5"), null);
  assert.equal(isSeason("2026-Q3"), true);
  assert.equal(isSeason("2026-q3"), false);
  assert.equal(isSeason("x"), false);
});

test("seasons to offer run from the first data point to now, newest first, capped", () => {
  assert.deepEqual(seasonsBetween(new Date("2025-11-05T00:00:00Z"), new Date("2026-10-01T00:00:00Z")), ["2026-Q4", "2026-Q3", "2026-Q2", "2026-Q1", "2025-Q4"]);
  assert.deepEqual(seasonsBetween(new Date("2026-10-02T00:00:00Z"), new Date("2026-10-01T00:00:00Z")), ["2026-Q4"]);
  assert.equal(seasonsBetween(new Date("2010-01-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"), 12).length, 12);
});

test("a series score names a winner only when it is a finished series of that length", () => {
  assert.equal(winsNeeded(1), 1);
  assert.equal(winsNeeded(3), 2);
  assert.equal(winsNeeded(5), 3);
  assert.equal(seriesWinner(1, 1, 0), "a");
  assert.equal(seriesWinner(1, 0, 1), "b");
  assert.equal(seriesWinner(1, 1, 1), null);
  assert.equal(seriesWinner(3, 2, 1), "a");
  assert.equal(seriesWinner(3, 0, 2), "b");
  assert.equal(seriesWinner(3, 2, 2), null);
  assert.equal(seriesWinner(3, 3, 0), null, "a best-of-three ends at two");
  assert.equal(seriesWinner(5, 3, 2), "a");
  assert.equal(seriesWinner(5, 1, 3), "b");
  assert.equal(seriesWinner(2, 1, 0), null, "only 1, 3 and 5");
  assert.equal(seriesWinner(3, -1, 2), null);
  assert.equal(seriesWinner(3, 1.5, 2), null);
});

test("ladder change: Elo with K 32, the winner gains what the loser loses, never below 100", () => {
  assert.deepEqual(ladderChange(1000, 1000), { winnerBefore: 1000, winnerAfter: 1016, loserBefore: 1000, loserAfter: 984, delta: 16 });
  assert.equal(ladderChange(1200, 1000).delta, 8, "the favourite gains little");
  assert.equal(ladderChange(1000, 1200).delta, 24, "an upset gains a lot");
  assert.equal(ladderChange(2000, 110).delta, 1, "at least one point");
  assert.deepEqual(ladderChange(100, 110), { winnerBefore: 100, winnerAfter: 116, loserBefore: 110, loserAfter: 100, delta: 16 }, "the floor holds");
});

test("the same pair is rated again only 7 days after its last rated war", () => {
  const t = new Date("2026-10-20T18:00:00Z");
  assert.equal(isRated(t, null), true);
  assert.equal(isRated(t, new Date("2026-10-14T18:00:00Z")), false);
  assert.equal(isRated(t, new Date("2026-10-13T18:00:00Z")), true);
});

test("a clan tag is 2–5 Latin capitals or digits", () => {
  assert.equal(clanTag(" ab1 "), "AB1");
  assert.equal(clanTag("MVX99"), "MVX99");
  assert.equal(clanTag("A"), null);
  assert.equal(clanTag("ABCDEF"), null);
  assert.equal(clanTag("AB-1"), null);
  assert.equal(clanTag("АБВ"), null, "Cyrillic is refused");
  assert.equal(clanTag(42), null);
});
