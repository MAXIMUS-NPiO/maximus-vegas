import test from "node:test";
import assert from "node:assert/strict";
import { signedHeaders, signPayload, verifyWebhook } from "../src/lib/webhook-signature.ts";

const secret = "whsec_test_secret_value_0123456789";
const body = JSON.stringify({ id: "evt_1", type: "ping", data: {} });
const now = Date.UTC(2026, 9, 1, 12, 0, 0);

function input(h: Record<string, string>, over: Partial<Parameters<typeof verifyWebhook>[0]> = {}) {
  return { secret, id: h["MV-Webhook-Id"], timestamp: h["MV-Webhook-Timestamp"], signature: h["MV-Webhook-Signature"], body, now, ...over };
}

test("a signed delivery verifies; the signature covers id, timestamp and body", () => {
  const h = signedHeaders(secret, "evt_1", body, now);
  assert.equal(h["MV-Webhook-Timestamp"], String(now / 1000));
  assert.match(h["MV-Webhook-Signature"], /^v1=[0-9a-f]{64}$/);
  assert.deepEqual(verifyWebhook(input(h)), { ok: true });
  assert.deepEqual(verifyWebhook(input(h, { body: body.replace("ping", "pong") })), { ok: false, reason: "bad_signature" });
  assert.deepEqual(verifyWebhook(input(h, { id: "evt_2" })), { ok: false, reason: "bad_signature" });
  assert.deepEqual(verifyWebhook(input(h, { secret: "whsec_other" })), { ok: false, reason: "bad_signature" });
});

test("a replayed delivery is rejected: the same id twice, or an old timestamp", () => {
  const seen = new Set<string>();
  const h = signedHeaders(secret, "evt_7", body, now);
  assert.deepEqual(verifyWebhook(input(h, { seen })), { ok: true });
  assert.deepEqual(verifyWebhook(input(h, { seen })), { ok: false, reason: "replayed" });
  // An attacker who captured a request cannot refresh its timestamp without the secret.
  const later = now + 6 * 60_000;
  assert.deepEqual(verifyWebhook(input(h, { now: later })), { ok: false, reason: "stale" });
  const forged = { ...h, "MV-Webhook-Timestamp": String(later / 1000) };
  assert.deepEqual(verifyWebhook(input(forged, { now: later })), { ok: false, reason: "bad_signature" });
  // A bad signature is not remembered as seen.
  const fresh = new Set<string>();
  assert.equal(verifyWebhook(input(h, { seen: fresh, secret: "whsec_other" })).ok, false);
  assert.equal(fresh.size, 0);
});

test("missing headers fail; several v1 values are accepted during a secret change", () => {
  const h = signedHeaders(secret, "evt_9", body, now);
  assert.deepEqual(verifyWebhook(input(h, { signature: undefined })), { ok: false, reason: "missing" });
  assert.deepEqual(verifyWebhook(input(h, { timestamp: "soon" })), { ok: false, reason: "missing" });
  const both = `${signPayload("whsec_old", "evt_9", now / 1000, body)} ${h["MV-Webhook-Signature"]}`;
  assert.deepEqual(verifyWebhook(input(h, { signature: both })), { ok: true });
});
