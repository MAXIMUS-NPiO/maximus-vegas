import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { TokenVerifier } from "livekit-server-sdk";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, exportAccount, deleteAccount, type SessionUser } from "../src/server/auth.ts";
import { setPaymentProviderForTests, RECIPIENT } from "../src/server/billing.ts";
import type { PaymentProvider, CheckoutRequest, SessionState, ProviderEvent } from "../src/server/payments/provider.ts";
import { WebhookSignatureError } from "../src/server/payments/provider.ts";
import { createBroadcastCheckout, reconcileBroadcastPayment, resumeBroadcastCheckout, handleBroadcastPaymentWebhook } from "../src/server/broadcast-payments.ts";
import { broadcastAvailability, broadcastTariff, broadcastQuote } from "../src/server/broadcast-config.ts";
import { startBroadcast, stopBroadcast, broadcastHeartbeat, broadcastToken, archiveDownload, getBroadcast, publicBroadcasts,
  reconcileBroadcast, sweepBroadcasts, eraseBroadcasts, limitBroadcastAction } from "../src/server/broadcasts.ts";
import { liveBroadcastProvider, type BroadcastProvider, type ProviderRoom, type RecordingState } from "../src/server/broadcast-provider.ts";
import { DomainError } from "../src/server/errors.ts";
import { recordRun } from "../src/server/system.ts";
import { verifyAuditChain } from "../src/server/audit.ts";

let db: Database, seq = 0;
const requests = new Map<string, CheckoutRequest>(), sessions = new Map<string, SessionState>();
const money: PaymentProvider = {
  name: "stripe", mode: "test", checkoutHosts: ["checkout.stripe.com"],
  async createCheckout(req) {
    if (requests.has(req.attemptId)) assert.deepEqual(req, requests.get(req.attemptId), "idempotency parameters stay stable");
    requests.set(req.attemptId, req);
    const id = `cs_${req.attemptId}`;
    if (!sessions.has(id)) sessions.set(id, { id, url: `https://checkout.stripe.com/${id}`, status: "open", paymentStatus: "unpaid",
      amountTotal: req.amountMinor, currency: req.currency, paymentIntentId: `pi_${req.attemptId}`, clientReferenceId: req.invoiceId, metadata: req.metadata, livemode: false });
    return { id, url: `https://checkout.stripe.com/${id}`, expiresAt: req.expiresAt };
  },
  async retrieveSession(id) { return sessions.get(id)!; },
  async retrievePaymentIntent(id) {
    const s = [...sessions.values()].find(s => s.paymentIntentId === id)!;
    return { id, metadata: s.metadata, amount: s.amountTotal!, currency: s.currency!, status: "succeeded", livemode: false };
  },
  verifyWebhook(raw, signature) {
    if (signature !== "verified-test-signature") throw new WebhookSignatureError();
    return { ...JSON.parse(raw), created: new Date(), payloadSha256: createHash("sha256").update(raw).digest("hex") };
  },
  async refund() { return { id: "refund-test" }; },
};
class Video implements BroadcastProvider {
  rooms = new Map<string, ProviderRoom>();
  recordings = new Map<string, RecordingState>();
  viewers: string[] = [];
  removed: string[] = [];
  revoked: string[][] = [];
  creates = 0; failClose = false; failRemove = false; delay: Promise<void> | null = null;
  async create(r: ProviderRoom) { this.creates++; if (this.delay) await this.delay; this.rooms.set(r.name, r); return { sid: `RM_${r.name}` }; }
  async close(name: string, identities: string[]) { if (this.failClose) throw new Error("network"); this.revoked.push(identities); this.rooms.delete(name); }
  async recording(name: string) { return this.recordings.get(name) ?? { status: "pending" as const }; }
  async remove(key: string) { if (this.failRemove) throw new Error("storage unavailable"); this.removed.push(key); }
  async download(key: string, ttl: number) { return `https://private.example/${key}?ttl=${ttl}`; }
  async token(name: string, identity: string, publish: boolean, ttl: number) { return JSON.stringify({ name, identity, publish, ttl }); }
  async healthy() { return true; }
  async publishing() { return true; }
  async participants() { return this.viewers; }
  async revokeViewer(_name: string, identity: string) { this.revoked.push([identity]); }
}
const env = { MV_BROADCAST_ENABLED: "1", LIVEKIT_URL: "wss://test-project.livekit.cloud", LIVEKIT_API_KEY: "unit-key",
  LIVEKIT_API_SECRET: "unit-test-secret-not-a-real-key", BROADCAST_S3_BUCKET: "test-private-bucket", BROADCAST_S3_REGION: "eu-west-1",
  BROADCAST_S3_ACCESS_KEY_ID: "unit-key", BROADCAST_S3_SECRET_ACCESS_KEY: "unit-secret", BROADCAST_PRIVATE_STORAGE_CONFIRMED: "1",
  NEXT_PUBLIC_SITE_URL: "https://example.test", PAYMENTS_ENABLED: "1", PAYMENTS_MODE: "test", MERCHANT_VERIFIED: "1", MERCHANT_LEGAL_NAME: RECIPIENT,
  MV_BROADCAST_TARIFF: JSON.stringify({ version: "test-v1", approvalRef: "test-only", currency: "USD", minuteMinor: 2,
    storageMinuteDayMinor: 1, maxViewers: 2, maxDays: 3650, terms: { ru: "Тестовые условия", en: "Test terms" },
    refunds: { ru: "Тестовый возврат", en: "Test refunds" }, tax: { ru: "Тест", en: "Test" } }) };
const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
async function mk(): Promise<SessionUser> {
  const name = `broadcast_${++seq}`;
  const s = await signUp(db, { email: `${name}@example.test`, username: name, displayName: name, password: "correct horse battery", adult: "on", terms: "on" });
  return (await sessionUser(db, s.token))!;
}
const rejects = async (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code);
const input = (over: Record<string, unknown> = {}) => ({ requestId: randomUUID(), title: "My POV", mode: "live_record", minutes: 10,
  retentionDays: 31, version: "test-v1", terms: true, rights: true, expectedMinor: 330, ...over });
async function order(user: SessionUser, data = input()) {
  await recordRun(db, "broadcasts", { healthy: true });
  return createBroadcastCheckout(db, user, data, "en");
}
async function paid(user: SessionUser, data = input()) {
  const o = await order(user, data);
  const s = sessions.get(`cs_${o.orderId}`)!;
  s.status = "complete"; s.paymentStatus = "paid"; s.url = null;
  await reconcileBroadcastPayment(db, o.orderId, s, money);
  return o;
}
test.before(async () => {
  Object.assign(process.env, env); setPaymentProviderForTests(money);
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
});
test.after(async () => {
  await db.close(); setPaymentProviderForTests(null);
  for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test("native billing: no invented tariff, positive bounded quote, chosen retention and scheduler gate", async () => {
  const tariff = broadcastTariff()!;
  assert.equal(broadcastQuote(input(), tariff).amountMinor, 330);
  assert.equal(broadcastQuote(input({ mode: "live" }), tariff).retentionDays, 0);
  for (const change of [{ minutes: -1 }, { minutes: 2.5 }, { retentionDays: 0 }, { retentionDays: 3651 }, { mode: "forged" }])
    assert.throws(() => broadcastQuote(input(change), tariff), DomainError);
  assert.equal((await broadcastAvailability(db)).ready, false);
  await recordRun(db, "broadcasts", { healthy: true });
  assert.equal((await broadcastAvailability(db)).ready, true);
  process.env.MERCHANT_LEGAL_NAME = "Other entity";
  assert.equal((await broadcastAvailability(db)).ready, false);
  process.env.MERCHANT_LEGAL_NAME = RECIPIENT;
  process.env.MV_BROADCAST_TARIFF = "{}"; assert.equal(broadcastTariff(), null); process.env.MV_BROADCAST_TARIFF = env.MV_BROADCAST_TARIFF;
  await db.query("update system_runs set last_at=now()-interval '3 minutes' where name='broadcasts'");
  assert.equal((await broadcastAvailability(db)).ready, false);
});

test("purchase is idempotent, consent-bound and ownership checked; client amounts and redirects never confer access", async () => {
  const user = await mk(), other = await mk(), video = new Video(), req = input();
  await rejects(order(user, input({ terms: false })), "consent_required");
  await rejects(order(user, input({ expectedMinor: 1 })), "offer_unavailable");
  const a = await order(user, req), b = await order(user, req);
  assert.equal(a.id, b.id);
  await rejects(order(user), "checkout_in_progress");
  await rejects(resumeBroadcastCheckout(db, other, a.id), "forbidden");
  await rejects(startBroadcast(db, user, a.id, video), "session_state");
  const s = sessions.get(`cs_${a.orderId}`)!;
  await rejects(reconcileBroadcastPayment(db, a.orderId, { ...s, paymentStatus: "paid", status: "complete", amountTotal: 1 }, money), "provider_error");
  await rejects(reconcileBroadcastPayment(db, a.orderId, { ...s, metadata: { ...s.metadata, userId: other.id } }, money), "provider_error");
  await rejects(reconcileBroadcastPayment(db, a.orderId, { ...s, livemode: true }, money), "provider_error");
  assert.equal((await getBroadcast(db, a.id)).state, "unpaid");
  await rejects(db.tx(q => eraseBroadcasts(q, user.id)), "checkout_in_progress");
  s.status = "expired";
  await reconcileBroadcastPayment(db, a.orderId, s, money);
  assert.equal((await getBroadcast(db, a.id)).state, "ended");
});

test("paid broadcast launches once, verifies publication, scopes tokens and bounds concurrent viewer identities", async () => {
  const user = await mk(), one = await mk(), two = await mk(), three = await mk(), p = new Video();
  const o = await paid(user);
  const launched = await Promise.allSettled([startBroadcast(db, user, o.id, p), startBroadcast(db, user, o.id, p)]);
  assert.equal(launched.filter(r => r.status === "fulfilled").length, 1); assert.equal(p.creates, 1);
  const host = JSON.parse((launched.find(r => r.status === "fulfilled") as PromiseFulfilledResult<{ token: string }>).value.token);
  assert.equal(host.publish, true); assert.equal(host.identity, "host"); assert.ok(host.ttl <= 60);
  await rejects(broadcastToken(db, one, o.id, true, p), "forbidden");
  await broadcastHeartbeat(db, user, o.id, p);
  assert.ok((await publicBroadcasts(db)).some(b => b.id === o.id));
  const v1 = JSON.parse((await broadcastToken(db, one, o.id, false, p)).token);
  const v2 = JSON.parse((await broadcastToken(db, two, o.id, false, p)).token);
  assert.equal(v1.publish, false); assert.notEqual(v1.identity, v2.identity);
  await rejects(broadcastToken(db, three, o.id, false, p), "stream_limit");
  assert.equal(JSON.parse((await broadcastToken(db, one, o.id, false, p)).token).identity, v1.identity);
  await rejects(stopBroadcast(db, one, o.id, false, p), "forbidden");
  await db.query("update native_broadcasts set expires_at=now()-interval '1 second' where id=$1", [o.id]);
  await rejects(broadcastToken(db, one, o.id, false, p), "session_state");
  p.failClose = true;
  await assert.rejects(reconcileBroadcast(db, o.id, p));
  assert.equal((await getBroadcast(db, o.id)).state, "stopping");
  p.failClose = false;
  await reconcileBroadcast(db, o.id, p);
  assert.equal((await getBroadcast(db, o.id)).state, "ended");
  assert.deepEqual(p.revoked.at(-1)?.sort(), ["host", "viewer-1", "viewer-2"]);
});

test("private recording becomes an owner-only archive; selected retention expires before physical deletion; failures retry", async () => {
  const user = await mk(), other = await mk(), p = new Video();
  const o = await paid(user, input({ mode: "record" }));
  await startBroadcast(db, user, o.id, p);
  await broadcastHeartbeat(db, user, o.id, p);
  await rejects(broadcastToken(db, other, o.id, false, p), "forbidden");
  assert.ok(!(await publicBroadcasts(db)).some(b => b.id === o.id));
  await stopBroadcast(db, user, o.id, false, p);
  const b = await getBroadcast(db, o.id);
  p.recordings.set(b.room_name, { status: "ready", id: "EG_test", bytes: 2048 });
  await reconcileBroadcast(db, o.id, p);
  const ready = await getBroadcast(db, o.id);
  assert.equal(ready.archive_state, "ready");
  assert.ok(Math.abs(new Date(ready.retain_until!).getTime() - Date.now() - 31 * 86400000) < 2000);
  await rejects(archiveDownload(db, other, o.id, p), "forbidden");
  assert.match((await archiveDownload(db, user, o.id, p)).url, /ttl=60$/);
  await db.query("update native_broadcasts set retain_until=now()-interval '1 second',cleanup_until=now()-interval '1 second' where id=$1", [o.id]);
  await rejects(archiveDownload(db, user, o.id, p), "session_state");
  p.failRemove = true; await assert.rejects(reconcileBroadcast(db, o.id, p));
  assert.equal((await getBroadcast(db, o.id)).archive_state, "ready", "never claim erasure before storage confirms");
  p.failRemove = false; await reconcileBroadcast(db, o.id, p);
  assert.equal((await getBroadcast(db, o.id)).archive_state, "deleted");
  assert.ok(p.removed.includes(b.archive_key));
  const exported = await exportAccount(db, user);
  assert.ok(exported.broadcasts.length); assert.ok(exported.broadcastOrders.length);
  assert.ok(!JSON.stringify(exported.broadcasts).includes("archive_key"));
});

test("verified payment events are replay safe and a refund arriving before success cannot reopen access", async () => {
  const user = await mk(); const o = await order(user);
  const s = sessions.get(`cs_${o.orderId}`)!;
  const event = (type: string, object: Record<string, unknown>, id = randomUUID()) => JSON.stringify({ id, type, object, livemode: false } satisfies Partial<ProviderEvent>);
  const refund = event("charge.refunded", { id: "ch_test", payment_intent: s.paymentIntentId });
  assert.equal((await handleBroadcastPaymentWebhook(db, refund, "wrong"))?.status, 400);
  assert.equal((await handleBroadcastPaymentWebhook(db, refund, "verified-test-signature"))?.status, 200);
  assert.equal((await handleBroadcastPaymentWebhook(db, refund, "verified-test-signature"))?.status, 200);
  s.status = "complete"; s.paymentStatus = "paid";
  const success = event("checkout.session.completed", { id: s.id, metadata: s.metadata });
  assert.equal((await handleBroadcastPaymentWebhook(db, success, "verified-test-signature"))?.status, 200);
  assert.equal((await getBroadcast(db, o.id)).state, "deleting");
  assert.equal((await db.query<{ state: string }>("select state from broadcast_orders where id=$1", [o.orderId]))[0].state, "revoked");
  assert.equal(await handleBroadcastPaymentWebhook(db, event("unrelated", { metadata: { product: "membership" } }), "verified-test-signature"), null);
});

test("stop during provisioning fences the late room; expired heartbeat and erasure stay effective", async () => {
  const user = await mk(), p = new Video(), o = await paid(user);
  let release!: () => void;
  p.delay = new Promise<void>(resolve => { release = resolve; });
  const start = startBroadcast(db, user, o.id, p);
  while (!p.creates) await new Promise(resolve => setTimeout(resolve, 5));
  await stopBroadcast(db, user, o.id, true, p);
  release(); await assert.rejects(start);
  assert.equal(p.rooms.size, 0);
  await rejects(broadcastToken(db, user, o.id, true, p), "session_state");
  await db.query("update native_broadcasts set cleanup_until=now()-interval '1 second',archive_state='none' where id=$1", [o.id]);
  await reconcileBroadcast(db, o.id, p);
  assert.equal((await getBroadcast(db, o.id)).state, "deleted");
  const another = await paid(user, input({ mode: "live", expectedMinor: 20 }));
  p.delay = null; await startBroadcast(db, user, another.id, p);
  await db.query("update native_broadcasts set heartbeat_at=now()-interval '2 minutes' where id=$1", [another.id]);
  await reconcileBroadcast(db, another.id, p);
  assert.equal((await getBroadcast(db, another.id)).state, "ended");
  await db.tx(q => eraseBroadcasts(q, user.id));
  assert.ok((await getBroadcast(db, another.id)).delete_requested_at);
});

test("real adapter signs least-privilege grants without exposing credentials; rate and worker controls close gaps", async () => {
  const p = liveBroadcastProvider(), verifier = new TokenVerifier(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
  const view = await verifier.verify(await p.token("room", "viewer-1", false, 30));
  assert.equal(view.video?.canPublish, false); assert.equal(view.video?.canSubscribe, true); assert.equal(view.video?.canPublishData, false);
  assert.ok(!view.video?.roomAdmin); assert.ok(!view.video?.roomCreate);
  const host = await verifier.verify(await p.token("room", "host", true, 30));
  assert.deepEqual(host.video?.canPublishSources, ["screen_share", "screen_share_audio", "microphone"]);
  const user = await mk();
  for (let i = 0; i < 6; i++) await limitBroadcastAction(db, user.id, "checkout");
  await rejects(limitBroadcastAction(db, user.id, "checkout"), "too_many_attempts");
  const result = await sweepBroadcasts(db, new Video());
  assert.ok("healthy" in result && result.healthy);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("real PostgreSQL: simultaneous checkout, launch, viewer allocation and account closure keep their limits", { skip: !process.env.PG_TEST_URL }, async () => {
  const memory = db;
  db = await openDatabase({ url: process.env.PG_TEST_URL });
  try {
    const user = await mk();
    await recordRun(db, "broadcasts", { healthy: true });
    const purchases = await Promise.allSettled(Array.from({ length: 8 }, () => createBroadcastCheckout(db, user, input(), "en")));
    const wins = purchases.filter(r => r.status === "fulfilled");
    assert.equal(wins.length, 1);
    const o = (wins[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof createBroadcastCheckout>>>).value;
    const s = sessions.get(`cs_${o.orderId}`)!; s.status = "complete"; s.paymentStatus = "paid";
    await reconcileBroadcastPayment(db, o.orderId, s, money);
    const p = new Video();
    const starts = await Promise.allSettled(Array.from({ length: 8 }, () => startBroadcast(db, user, o.id, p)));
    assert.equal(starts.filter(r => r.status === "fulfilled").length, 1); assert.equal(p.creates, 1);
    await broadcastHeartbeat(db, user, o.id, p);
    const viewers = await Promise.all(Array.from({ length: 6 }, () => mk()));
    const admissions = await Promise.allSettled(viewers.map(v => broadcastToken(db, v, o.id, false, p)));
    assert.equal(admissions.filter(r => r.status === "fulfilled").length, 2);
    const closing = await mk();
    await Promise.allSettled([order(closing), deleteAccount(db, closing, "correct horse battery")]);
    const invalid = await db.query("select 1 from broadcast_orders o join users u on u.id=o.user_id where u.id=$1 and u.status='deleted' and o.state='pending'", [closing.id]);
    assert.equal(invalid.length, 0, "a pending charge is never attached to an erased account");
  } finally { await db.close(); db = memory; }
});
