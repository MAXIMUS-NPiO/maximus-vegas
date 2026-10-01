import test from "node:test";
import assert from "node:assert/strict";
import { vetoSequence, vetoState, type VetoRow } from "../src/server/veto.ts";
import { parseMapPool } from "../src/server/map-pool.ts";
import { DomainError } from "../src/server/errors.ts";

const seq = (pool: number, bestOf: number) => vetoSequence(pool, bestOf)?.map((t) => `${t.side}:${t.action}`).join(" ");

test("turns by pool and series length: opening bans, picks, remaining bans; side A starts", () => {
  assert.equal(seq(7, 1), "a:ban b:ban a:ban b:ban a:ban b:ban");
  assert.equal(seq(7, 3), "a:ban b:ban a:pick b:pick a:ban b:ban");
  assert.equal(seq(7, 5), "a:ban b:ban a:pick b:pick a:pick b:pick");
  assert.equal(seq(7, 7), "a:pick b:pick a:pick b:pick a:pick b:pick");
  assert.equal(seq(3, 3), "a:pick b:pick");
  assert.equal(seq(4, 3), "a:ban b:pick a:pick", "one spare map: one opening ban, then the picks");
  assert.equal(seq(2, 1), "a:ban");
  assert.equal(vetoSequence(2, 3), null, "a pool smaller than the series cannot be vetoed");
  assert.equal(vetoSequence(1, 1), null);
  assert.deepEqual(vetoSequence(7, 3)!.map((t) => t.step), [1, 2, 3, 4, 5, 6]);
});

test("state: next turn, remaining maps, picks in order and the decider", () => {
  const pool = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"];
  const rows: VetoRow[] = [
    { step: 1, side: "a", action: "ban", map: "Golf" },
    { step: 2, side: "b", action: "ban", map: "Alpha" },
    { step: 3, side: "a", action: "pick", map: "Delta" },
  ];
  let s = vetoState(pool, 3, rows)!;
  assert.deepEqual(s.next, { step: 4, side: "b", action: "pick" });
  assert.deepEqual(s.remaining, ["Bravo", "Charlie", "Echo", "Foxtrot"]);
  assert.equal(s.complete, false);
  assert.deepEqual(s.maps, [{ map: "Delta", by: "a" }], "the decider appears only at the end");
  s = vetoState(pool, 3, [
    ...rows,
    { step: 4, side: "b", action: "pick", map: "Bravo" },
    { step: 5, side: "a", action: "ban", map: "Charlie" },
    { step: 6, side: "b", action: "ban", map: "Echo" },
  ])!;
  assert.equal(s.complete, true);
  assert.equal(s.next, null);
  assert.deepEqual(s.maps, [
    { map: "Delta", by: "a" },
    { map: "Bravo", by: "b" },
    { map: "Foxtrot", by: null },
  ]);
  assert.equal(vetoState(["One", "Two"], 3, []), null);
});

test("map pool: separators, duplicates ignoring case, limits", () => {
  assert.deepEqual(parseMapPool("Alpha, Bravo;Charlie\nDelta\r\n  Echo  "), ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
  assert.deepEqual(parseMapPool("Alpha, alpha, ALPHA, Bravo"), ["Alpha", "Bravo"]);
  assert.equal(parseMapPool(""), null);
  assert.equal(parseMapPool("  ,  ; "), null);
  const bad = (input: string) => assert.throws(() => parseMapPool(input), (e: unknown) => e instanceof DomainError && e.code === "invalid_input");
  bad("Solo");
  bad(Array.from({ length: 16 }, (_, i) => `Map ${i}`).join(","));
  bad(`${"x".repeat(33)}, Bravo`);
});
