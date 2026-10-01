import test from "node:test";
import assert from "node:assert/strict";
import { eventStep, matchStep, type EventStepInput, type MatchStepInput, type StepKey } from "../src/server/gameday.ts";
import { actionText, gameDayText, stepText } from "../src/lib/gameday-text.ts";

const now = new Date("2030-01-01T12:00:00Z");
const base = (over: Partial<MatchStepInput> = {}): MatchStepInput => ({
  tStatus: "IN_PROGRESS",
  status: "ready",
  outcome: null,
  side: "a",
  aReg: "A",
  bReg: "B",
  winnerReg: null,
  checkedIn: { a: false, b: false },
  pendingSide: null,
  noShowAt: null,
  hasNext: false,
  now,
  ...over,
});
const key = (over: Partial<MatchStepInput>) => matchStep(base(over)).key;

test("open match: check-in, waiting for the opponent, no-show window, play", () => {
  const deadline = new Date("2030-01-01T12:10:00Z");
  assert.deepEqual(matchStep(base({ noShowAt: deadline })), { key: "check_in", action: "checkin", deadline });
  assert.deepEqual(matchStep(base({ checkedIn: { a: true, b: false }, noShowAt: deadline })), { key: "opponent_check_in", action: null, deadline });
  // From the no-show time the side is pointed at the referee, who records it.
  assert.deepEqual(matchStep(base({ checkedIn: { a: true, b: false }, noShowAt: new Date("2030-01-01T11:59:00Z") })), {
    key: "opponent_absent",
    action: "call_referee",
    deadline: null,
  });
  assert.deepEqual(matchStep(base({ checkedIn: { a: true, b: true } })), { key: "play", action: "report", deadline: null });
  assert.equal(key({ status: "in_progress" }), "play", "a match marked live is played regardless of check-in");
  assert.equal(key({ side: "b", checkedIn: { a: true, b: false } }), "check_in", "the side's own check-in decides");
});

test("results: confirm the opponent's score, wait for one's own, a dispute is with the referee", () => {
  assert.deepEqual(matchStep(base({ status: "result_submitted", pendingSide: "b" })), { key: "confirm", action: "confirm", deadline: null });
  assert.equal(key({ status: "result_submitted", pendingSide: "a" }), "wait_confirm");
  assert.equal(key({ status: "disputed" }), "review");
});

test("unknown opponent, pause and cancellation come before anything else", () => {
  assert.equal(key({ bReg: null, status: "pending" }), "waiting_opponent");
  assert.equal(key({ status: "pending" }), "waiting_opponent");
  assert.equal(key({ tStatus: "PAUSED" }), "paused");
  assert.equal(key({ tStatus: "PAUSED", status: "cancelled" }), "cancelled");
  assert.equal(key({ paused: true }), "match_paused", "a referee's hold comes before check-in and play");
  assert.equal(key({ paused: true, status: "result_submitted", pendingSide: "b" }), "match_paused");
  assert.equal(key({ paused: true, status: "completed", outcome: "played", winnerReg: "A" }), "won_last", "a decided match is past any hold");
});

test("finished match: win, last win, drop to the lower bracket, loss, draw, bye", () => {
  const done = { status: "completed", outcome: "played" };
  assert.deepEqual(matchStep(base({ ...done, winnerReg: "A", hasNext: true })), { key: "won", action: "next", deadline: null });
  assert.equal(key({ ...done, winnerReg: "A" }), "won_last");
  assert.deepEqual(matchStep(base({ ...done, winnerReg: "B", hasNext: true })), { key: "dropped", action: "next", deadline: null });
  assert.equal(key({ ...done, winnerReg: "B" }), "lost");
  assert.equal(key({ ...done, winnerReg: null }), "draw");
  assert.equal(key({ status: "completed", outcome: "bye", winnerReg: "A", bReg: null, hasNext: true }), "bye");
  assert.equal(key({ ...done, winnerReg: "A", side: "b", hasNext: false }), "lost", "the winner is judged from the side's own entry");
});

test("event without an open match: check-in, waiting, out, finished, formats", () => {
  const e = (over: Partial<EventStepInput>) =>
    eventStep({ tStatus: "IN_PROGRESS", format: "single_elimination", regStatus: "registered", checkInOpen: false, checkedIn: false, eliminated: false, lobby: false, ...over });
  assert.deepEqual(e({ tStatus: "REGISTRATION_OPEN", checkInOpen: true }), { key: "event_check_in", action: "event_checkin", deadline: null });
  assert.equal(e({ tStatus: "REGISTRATION_CLOSED", checkInOpen: true, checkedIn: true }).key, "event_ready");
  assert.equal(e({ tStatus: "REGISTRATION_CLOSED" }).key, "waiting_start");
  assert.equal(e({}).key, "waiting_round");
  assert.equal(e({ eliminated: true }).key, "out");
  assert.equal(e({ tStatus: "PAUSED" }).key, "paused");
  assert.equal(e({ tStatus: "COMPLETED" }).key, "finished");
  assert.equal(e({ regStatus: "disqualified" }).key, "disqualified");
  assert.deepEqual(e({ format: "ffa", lobby: true }), { key: "ffa", action: "open_lobby", deadline: null });
  assert.equal(e({ format: "ffa", eliminated: true }).key, "out");
  assert.equal(e({ format: "leaderboard" }).key, "leaderboard");
});

test("every step and action has a text in both languages with no placeholder left", () => {
  const keys: StepKey[] = [
    "paused", "match_paused", "waiting_opponent", "check_in", "opponent_check_in", "opponent_absent", "play", "confirm", "wait_confirm", "review",
    "won", "won_last", "dropped", "lost", "draw", "bye", "cancelled", "event_check_in", "event_ready", "waiting_start",
    "waiting_round", "out", "finished", "disqualified", "ffa", "leaderboard",
  ];
  for (const lang of ["ru", "en"] as const) {
    for (const k of keys) {
      const text = stepText(k, lang, { series: "Bo3", score: "2 : 1", place: 3, reason: "server restart" });
      assert.ok(text.length > 3 && !/[{}]/.test(text), `${lang} ${k}: ${text}`);
    }
    for (const a of ["checkin", "report", "confirm", "call_referee", "next", "event_checkin", "open_lobby", "open_tournament", "open_match", "dispute"] as const)
      assert.ok(actionText(a, lang).length > 1);
    assert.deepEqual(Object.keys(gameDayText[lang]).sort(), Object.keys(gameDayText.ru).sort());
  }
  assert.equal(stepText("play", "ru", { series: "Bo3" }), "Сыграйте матч (Bo3) и отправьте счёт с доказательством.");
  assert.equal(stepText("play", "en"), "Play the match and report the score with evidence.");
  assert.equal(stepText("finished", "en", { place: 2 }), "The event is over. Your place: 2.");
});
