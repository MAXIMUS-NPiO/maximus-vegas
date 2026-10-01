import test from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../src/server/errors.ts";
import { evidenceHash, evidenceIntact, parseEvidence, publicCount, sanctionTerm } from "../src/server/conduct.ts";

const fails = (f: () => unknown, code: string) => assert.throws(f, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
const now = new Date("2026-10-01T12:00:00Z");

test("evidence: portal paths and https links, one per line, with notes; anything else is refused", () => {
  const list = parseEvidence("/ru/matches/7b1d — счёт не совпадает с демо\nhttps://example.org/clip.mp4 запись раунда 12\n\n/en/players/raven_1");
  assert.deepEqual(list, [
    { url: "/ru/matches/7b1d", note: "счёт не совпадает с демо" },
    { url: "https://example.org/clip.mp4", note: "запись раунда 12" },
    { url: "/en/players/raven_1", note: "" },
  ]);
  fails(() => parseEvidence(""), "invalid_evidence");
  fails(() => parseEvidence("http://example.org/plain"), "invalid_evidence");
  fails(() => parseEvidence("javascript:alert(1)"), "invalid_evidence");
  fails(() => parseEvidence("/de/matches/1"), "invalid_evidence");
  fails(() => parseEvidence(Array.from({ length: 11 }, (_, i) => `/ru/matches/${i}`).join("\n")), "invalid_evidence");
  assert.equal(parseEvidence(`/ru/matches/1 ${"x".repeat(300)}`)[0].note.length, 200, "notes are capped");
});

test("evidence digest: stable for the same list, changes with any edit", () => {
  const a = parseEvidence("/ru/matches/1 — note");
  assert.equal(evidenceHash(a), evidenceHash(parseEvidence("/ru/matches/1 — note")));
  assert.match(evidenceHash(a), /^[0-9a-f]{64}$/);
  const stored = { evidence: a, evidence_hash: evidenceHash(a) };
  assert.equal(evidenceIntact(stored), true);
  assert.equal(evidenceIntact({ ...stored, evidence: [{ url: "/ru/matches/1", note: "edited" }] }), false);
});

test("MV-CONDUCT-1 terms: warning without a term; bans need medium or high and 1–365 days; final suspension needs high", () => {
  assert.equal(sanctionTerm({ kind: "warning", protective: false, confidence: "low", days: 30, hours: null }, now), null, "a warning has no term");
  assert.deepEqual(sanctionTerm({ kind: "queue_ban", protective: false, confidence: "medium", days: 7, hours: null }, now), new Date("2026-10-08T12:00:00Z"));
  fails(() => sanctionTerm({ kind: "queue_ban", protective: false, confidence: "low", days: 7, hours: null }, now), "sanction_confidence");
  fails(() => sanctionTerm({ kind: "tournament_ban", protective: false, confidence: "high", days: null, hours: null }, now), "sanction_term");
  fails(() => sanctionTerm({ kind: "tournament_ban", protective: false, confidence: "high", days: 0, hours: null }, now), "sanction_term");
  fails(() => sanctionTerm({ kind: "tournament_ban", protective: false, confidence: "high", days: 366, hours: null }, now), "sanction_term");
  fails(() => sanctionTerm({ kind: "suspension", protective: false, confidence: "medium", days: 30, hours: null }, now), "sanction_confidence");
  assert.equal(sanctionTerm({ kind: "suspension", protective: false, confidence: "high", days: null, hours: null }, now), null, "a final suspension may have no end");
});

test("MV-CONDUCT-1 protective hold: a suspension of 1–72 hours at any confidence", () => {
  assert.deepEqual(sanctionTerm({ kind: "suspension", protective: true, confidence: "low", days: null, hours: 48 }, now), new Date("2026-10-03T12:00:00Z"));
  fails(() => sanctionTerm({ kind: "suspension", protective: true, confidence: "low", days: null, hours: 73 }, now), "sanction_term");
  fails(() => sanctionTerm({ kind: "suspension", protective: true, confidence: "low", days: null, hours: null }, now), "sanction_term");
  fails(() => sanctionTerm({ kind: "queue_ban", protective: true, confidence: "high", days: null, hours: 24 }, now), "sanction_term");
});

test("public counts hide 1 and 2", () => {
  assert.deepEqual([0, 1, 2, 3, 40].map(publicCount), [0, null, null, 3, 40]);
});
