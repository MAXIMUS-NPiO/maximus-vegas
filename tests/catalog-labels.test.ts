/** Roster sizes on game pages read as correct Russian (C-35); English is unchanged. */
import test from "node:test";
import assert from "node:assert/strict";
import { gameRosterLabel } from "../src/lib/catalog-labels.ts";

test("roster sizes use the Russian plural forms", () => {
  const ru = (n: number) => gameRosterLabel({ teamSize: n }, "ru");
  assert.equal(ru(1), "Один игрок");
  assert.equal(ru(2), "2 игрока в составе");
  assert.equal(ru(4), "4 игрока в составе");
  assert.equal(ru(5), "5 игроков в составе");
  assert.equal(ru(11), "11 игроков в составе");
  assert.equal(ru(12), "12 игроков в составе");
  assert.equal(ru(21), "21 игрок в составе");
  assert.equal(ru(22), "22 игрока в составе");
  assert.equal(gameRosterLabel({ teamSize: 4 }, "en"), "4 players per roster");
  assert.equal(gameRosterLabel({ teamSize: 1 }, "en"), "Solo");
});
