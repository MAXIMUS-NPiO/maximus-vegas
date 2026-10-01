import test from "node:test";
import assert from "node:assert/strict";
import {
  advancingCount,
  dealLobbies,
  FFA_DEFAULT_POINTS,
  ffaOrder,
  ffaPlaces,
  ffaSettingsOf,
  lobbyCount,
  lobbyTable,
  nextRoundSeeds,
  parseFfaSettings,
  parsePointsTable,
  planRounds,
  ffaPlanConverges,
  validateGame,
  type FfaRow,
} from "../src/server/ffa.ts";
import { fieldsOf, parseAnswers, parseRegistrationFields, answerLines } from "../src/server/registration.ts";
import { parseRoundKey } from "../src/server/schedule.ts";
import { DomainError } from "../src/server/errors.ts";

const throwsCode = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
const S = { placementPoints: [10, 6, 5, 4, 3, 2, 1, 1], killPoints: 1 };

test("ffa settings: defaults, limits, a points table that never rises", () => {
  const d = parseFfaSettings({});
  assert.deepEqual(d, { v: 1, lobbySize: 16, games: 3, advance: 8, placementPoints: FFA_DEFAULT_POINTS, killPoints: 1, roundHours: 0, ffa: "MV-FFA-1" });
  assert.equal(parseFfaSettings({ lobbySize: "4" }).advance, 2, "half a lobby advances by default");
  assert.deepEqual(parsePointsTable("15, 12 10;8"), [15, 12, 10, 8]);
  throwsCode(() => parsePointsTable("5, 6"), "invalid_ffa_settings");
  throwsCode(() => parsePointsTable("5, x"), "invalid_ffa_settings");
  throwsCode(() => parseFfaSettings({ lobbySize: "1" }), "invalid_ffa_settings");
  throwsCode(() => parseFfaSettings({ lobbySize: "101" }), "invalid_ffa_settings");
  throwsCode(() => parseFfaSettings({ ffaGames: "13" }), "invalid_ffa_settings");
  throwsCode(() => parseFfaSettings({ killPoints: "11" }), "invalid_ffa_settings");
  throwsCode(() => parseFfaSettings({ roundHours: "721" }), "invalid_ffa_settings");
  assert.deepEqual(ffaSettingsOf({ format_settings: { lobbySize: 10 } }).advance, 5, "partial JSON is filled in");
});

test("ffa lobbies: snake by seed, sizes differ by at most one", () => {
  assert.equal(lobbyCount(16, 16), 1);
  assert.equal(lobbyCount(17, 16), 2);
  assert.deepEqual(dealLobbies([1, 2, 3, 4, 5, 6, 7], 3), [
    [1, 6, 7],
    [2, 5],
    [3, 4],
  ]);
  for (let n = 2; n <= 120; n++) {
    const lobbies = dealLobbies(Array.from({ length: n }, (_, i) => i + 1), 16);
    const sizes = lobbies.map((l) => l.length);
    assert.ok(Math.max(...sizes) <= 16 && Math.max(...sizes) - Math.min(...sizes) <= 1, `n=${n}`);
    assert.equal(sizes.reduce((a, b) => a + b, 0), n);
  }
});

test("ffa results: places 1…m without gaps or repeats; an empty place means did not play", () => {
  const lobby = ["a", "b", "c", "d"];
  const ok = validateGame(lobby, [
    { reg: "a", placement: "2", kills: "3" },
    { reg: "b", placement: "1", kills: "" },
    { reg: "c", placement: "", kills: "" },
    { reg: "d", placement: "3", kills: "0" },
  ]);
  assert.deepEqual(ok, [
    { reg: "b", placement: 1, kills: 0 },
    { reg: "a", placement: 2, kills: 3 },
    { reg: "d", placement: 3, kills: 0 },
  ]);
  throwsCode(() => validateGame(lobby, [{ reg: "a", placement: "1", kills: "" }, { reg: "b", placement: "1", kills: "" }]), "invalid_ffa_results");
  throwsCode(() => validateGame(lobby, [{ reg: "a", placement: "1", kills: "" }, { reg: "b", placement: "3", kills: "" }]), "invalid_ffa_results");
  throwsCode(() => validateGame(lobby, [{ reg: "x", placement: "1", kills: "" }]), "invalid_ffa_results");
  throwsCode(() => validateGame(lobby, [{ reg: "a", placement: "1", kills: "-1" }]), "invalid_ffa_results");
  throwsCode(() => validateGame(lobby, [{ reg: "a", placement: "", kills: "" }]), "invalid_ffa_results");
  throwsCode(() => validateGame(lobby, [{ reg: "a", placement: "1", kills: "" }, { reg: "a", placement: "2", kills: "" }]), "invalid_ffa_results");
});

test("ffa table: placement and kill points, then wins, kills, best placement, seed; disqualified last", () => {
  const entrants = [
    { id: "a", seed: 1 },
    { id: "b", seed: 2 },
    { id: "c", seed: 3 },
    { id: "d", seed: 4, disqualified: true },
  ];
  const games = [
    { status: "completed", lines: [{ reg: "a", placement: 1, kills: 2 }, { reg: "b", placement: 2, kills: 5 }, { reg: "c", placement: 3, kills: 0 }, { reg: "d", placement: 4, kills: 9 }] },
    { status: "completed", lines: [{ reg: "b", placement: 1, kills: 0 }, { reg: "c", placement: 2, kills: 1 }, { reg: "a", placement: 3, kills: 1 }] },
    { status: "scheduled", lines: [{ reg: "c", placement: 1, kills: 30 }] },
  ];
  const t = lobbyTable(entrants, games, S);
  const by = Object.fromEntries(t.map((r) => [r.id, r]));
  // a: 10 + 2 + 5 + 1 = 18; b: 6 + 5 + 10 + 0 = 21; c: 5 + 0 + 6 + 1 = 12.
  assert.deepEqual([by.a.points, by.b.points, by.c.points], [18, 21, 12]);
  assert.deepEqual(t.map((r) => [r.id, r.rank]), [["b", 1], ["a", 2], ["c", 3], ["d", null]]);
  assert.equal(by.c.played, 2, "a scheduled game does not count");
  assert.equal(by.a.best, 1);
  // Ties: equal points → more wins first; then kills; then best placement; then seed.
  const row = (id: string, over: Partial<FfaRow>): FfaRow => ({ id, seed: 9, disqualified: false, played: 1, wins: 0, kills: 0, placementPoints: 0, killPoints: 0, points: 10, best: 3, rank: null, ...over });
  assert.ok(ffaOrder(row("x", { wins: 1 }), row("y", { wins: 0 })) < 0);
  assert.ok(ffaOrder(row("x", { kills: 1 }), row("y", { kills: 2 })) > 0);
  assert.ok(ffaOrder(row("x", { best: 1 }), row("y", { best: 2 })) < 0);
  assert.ok(ffaOrder(row("x", { seed: 1 }), row("y", { seed: 2 })) < 0);
});

test("ffa advancement: never a whole lobby, at least one; re-seeded by lobby place, then points per game", () => {
  const r = (id: string, rank: number | null, points: number, played = 2): FfaRow => ({ id, seed: Number(id.slice(1)), disqualified: rank === null, played, wins: 0, kills: 0, placementPoints: points, killPoints: 0, points, best: null, rank });
  assert.equal(advancingCount([r("a1", 1, 10), r("a2", 2, 5)], 8), 1, "two ranked: one advances");
  assert.equal(advancingCount([r("a1", 1, 10), r("a2", null, 5)], 8), 1, "one ranked: still one");
  assert.equal(advancingCount([r("a1", null, 10)], 8), 0);
  assert.equal(advancingCount([r("a1", 1, 9), r("a2", 2, 8), r("a3", 3, 7), r("a4", 4, 6)], 2), 2);
  const seeds = nextRoundSeeds(
    [
      [r("a1", 1, 20), r("a2", 2, 12), r("a3", 3, 4)],
      [r("b1", 1, 30, 3), r("b2", 2, 20, 3), r("b3", 3, 9, 3)],
    ],
    2,
  );
  // Winners first: a1 (10 per game) before b1 (10 per game) by seed; then b2 (6.7 per game) before a2 (6).
  assert.deepEqual(seeds, ["a1", "b1", "b2", "a2"]);
});

test("ffa rounds and places: previews end in one final lobby; places by round, shared by lobby place", () => {
  assert.deepEqual(planRounds(16, { lobbySize: 16, advance: 8 }), [{ round: 1, entrants: 16, lobbies: 1 }]);
  assert.deepEqual(planRounds(40, { lobbySize: 16, advance: 6 }), [
    { round: 1, entrants: 40, lobbies: 3 },
    { round: 2, entrants: 18, lobbies: 2 },
    { round: 3, entrants: 12, lobbies: 1 },
  ]);
  for (let n = 2; n <= 512; n += 7) {
    const plan = planRounds(n, { lobbySize: 10, advance: 5 });
    assert.ok(ffaPlanConverges(n, { lobbySize: 10, advance: 5 }), `n=${n} ends with one lobby`);
    assert.equal(plan[plan.length - 1].lobbies, 1);
    for (let i = 1; i < plan.length; i++) assert.ok(plan[i].entrants < plan[i - 1].entrants, "every round shrinks");
  }
  // Nearly everyone advancing from many lobbies would need more than 20 rounds: refused before the start.
  assert.equal(ffaPlanConverges(114, { lobbySize: 10, advance: 9 }), false);
  const r = (id: string, rank: number | null): FfaRow => ({ id, seed: 1, disqualified: rank === null, played: 1, wins: 0, kills: 0, placementPoints: 0, killPoints: 0, points: 0, best: null, rank });
  const places = ffaPlaces([
    { round: 1, lobbies: [[r("a", 1), r("b", 2), r("c", 3), r("x", null)], [r("d", 1), r("e", 2), r("f", 3)]] },
    { round: 2, lobbies: [[r("d", 1), r("a", 2), r("b", 3), r("e", 4)]] },
  ]);
  assert.deepEqual(Object.fromEntries(places), { d: 1, a: 2, b: 3, e: 4, c: 5, f: 5 });
  assert.equal(places.has("x"), false, "disqualified: no place");
  // The event ended with several lobbies (one qualifier left): the qualifier wins.
  const early = ffaPlaces([{ round: 1, lobbies: [[r("a", 1), r("b", 2)], [r("c", null), r("d", null)]] }], ["a"]);
  assert.deepEqual(Object.fromEntries(early), { a: 1, b: 2 });
});

test("registration fields: up to five, labels and choices validated; answers checked against them", () => {
  const fields = parseRegistrationFields({
    field1Label: "Discord",
    field1Type: "text",
    field1Required: "on",
    field2Label: "Region",
    field2Type: "choice",
    field2Options: "EU, MENA; Asia",
    field3Label: "",
    field4Label: "I accept the rules",
    field4Type: "checkbox",
    field4Required: "on",
  });
  assert.deepEqual(
    fields.map((f) => [f.key, f.label, f.type, f.options, f.required]),
    [
      ["f1", "Discord", "text", [], true],
      ["f2", "Region", "choice", ["EU", "MENA", "Asia"], false],
      ["f3", "I accept the rules", "checkbox", [], true],
    ],
  );
  throwsCode(() => parseRegistrationFields({ field1Label: "X" }), "invalid_registration_fields");
  throwsCode(() => parseRegistrationFields({ field1Label: "Region", field1Type: "choice", field1Options: "EU" }), "invalid_registration_fields");
  throwsCode(() => parseRegistrationFields({ field1Label: "Region", field1Type: "radio" }), "invalid_registration_fields");
  assert.deepEqual(parseAnswers(fields, { answer_f1: "player#1", answer_f2: "MENA", answer_f3: "on" }), { f1: "player#1", f2: "MENA", f3: true });
  throwsCode(() => parseAnswers(fields, { answer_f2: "MENA", answer_f3: "on" }), "invalid_answers");
  throwsCode(() => parseAnswers(fields, { answer_f1: "x", answer_f2: "Mars", answer_f3: "on" }), "invalid_answers");
  throwsCode(() => parseAnswers(fields, { answer_f1: "x" }), "invalid_answers");
  assert.equal(parseAnswers([], {}), null);
  assert.deepEqual(fieldsOf({ registration_fields: [{ key: "f1", label: "A", type: "bad" }, ...fields] }).length, 3, "stored fields are filtered");
  assert.deepEqual(answerLines(fields, { f1: "p", f3: false }, "yes", "no"), [["Discord", "p"], ["Region", "—"], ["I accept the rules", "no"]]);
});

test("schedule round keys", () => {
  assert.deepEqual(parseRoundKey("1:W:2"), { stage: 1, bracket: "W", round: 2 });
  assert.deepEqual(parseRoundKey("2:GF:1"), { stage: 2, bracket: "GF", round: 1 });
  assert.equal(parseRoundKey("all"), "all");
  throwsCode(() => parseRoundKey("3:W:1"), "invalid_input");
  throwsCode(() => parseRoundKey("1:X:1"), "invalid_input");
});
