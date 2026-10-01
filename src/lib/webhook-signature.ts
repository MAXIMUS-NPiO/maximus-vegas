/**
 * Webhook signatures (MV-HOOK-1). The portal signs every delivery; a receiver verifies it with the same
 * function the portal's tests use.
 *
 *   MV-Webhook-Id:        the event id, the same for every retry of one event
 *   MV-Webhook-Timestamp: Unix seconds when this attempt was sent
 *   MV-Webhook-Signature: "v1=" + hex HMAC-SHA256(secret, `${id}.${timestamp}.${body}`)
 *
 * A receiver rejects a missing or wrong signature, a timestamp more than 5 minutes away from its clock,
 * and an id it has already accepted (a replay). Several "v1=" values separated by spaces are accepted, so a
 * receiver keeps working during a secret rotation.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_VERSION = "v1";
export const TOLERANCE_SECONDS = 300;

export function signPayload(secret: string, id: string, timestamp: number, body: string): string {
  return `${SIGNATURE_VERSION}=${createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("hex")}`;
}

/** Headers of one signed delivery. */
export function signedHeaders(secret: string, id: string, body: string, now = Date.now()): Record<string, string> {
  const timestamp = Math.floor(now / 1000);
  return {
    "MV-Webhook-Id": id,
    "MV-Webhook-Timestamp": String(timestamp),
    "MV-Webhook-Signature": signPayload(secret, id, timestamp, body),
  };
}

export type VerifyResult = { ok: true } | { ok: false; reason: "missing" | "stale" | "bad_signature" | "replayed" };

/** Ids a receiver has already accepted; a Set works, a database table is better in production. */
export type SeenIds = { has(id: string): boolean; add(id: string): unknown };

export function verifyWebhook(input: {
  secret: string;
  id: string | null | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  body: string;
  seen?: SeenIds;
  now?: number;
}): VerifyResult {
  const { secret, id, timestamp, signature, body } = input;
  if (!id || !timestamp || !signature || !/^\d{9,11}$/.test(timestamp)) return { ok: false, reason: "missing" };
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(now - Number(timestamp)) > TOLERANCE_SECONDS) return { ok: false, reason: "stale" };
  const expected = Buffer.from(signPayload(secret, id, Number(timestamp), body));
  const match = signature
    .split(/\s+/)
    .filter(Boolean)
    .some((candidate) => {
      const given = Buffer.from(candidate);
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  if (!match) return { ok: false, reason: "bad_signature" };
  if (input.seen?.has(id)) return { ok: false, reason: "replayed" };
  input.seen?.add(id);
  return { ok: true };
}
