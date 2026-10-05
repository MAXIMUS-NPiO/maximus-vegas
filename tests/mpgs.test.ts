/** Isolated MPGS contract and portal flow checks. No gateway calls or real charges. */
import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { createMpgsProvider, mpgsMinor, type MpgsConfig } from "../src/server/payments/mpgs.ts";
import { mpgsCheckoutPage } from "../src/server/payments/mpgs-page.ts";
import type { CheckoutRequest, PaymentProvider } from "../src/server/payments/provider.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { applyForMembership, approveOffer, createOfferVersion, decideApplication, issueInvoice, paymentReadiness, publicOffer,
  reconcileAttempt, setPaymentProviderForTests, startCheckout } from "../src/server/billing.ts";

const config: MpgsConfig = { gateway: "https://ap-gateway.mastercard.com", merchantId: "TEST_PORTAL", password: "offline-fixture-only",
  merchantName: "Maximus Sports", currency: "AED", origin: "https://www.maximus.vegas" };
const req = (id: string): CheckoutRequest => ({ attemptId: id, invoiceId: id, invoiceNumber: `MV-${id}`, amountMinor: 9900, currency: "AED",
  description: "Membership", customerEmail: "fixture@example.test", successUrl: `https://www.maximus.vegas/en/billing/return?attempt=${id}`,
  cancelUrl: "https://www.maximus.vegas/en/billing", expiresAt: new Date(Date.now() + 3600000), locale: "en", idempotencyKey: id,
  metadata: { attempt_id: id, invoice_id: id } });
let db: Database;
const requests: Array<{ url: string; method: string; body: Record<string, any> }> = [];
const orders = new Map<string, Record<string, unknown>>();
let loseResponse = false;
const fakeFetch: typeof fetch = async (url, init) => {
  const address = String(url), method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : {};
  requests.push({ url: address, method, body });
  assert.equal(init?.redirect, "error", "credentials never follow redirects");
  assert.equal(new Headers(init?.headers).get("authorization"), `Basic ${Buffer.from("merchant.TEST_PORTAL:offline-fixture-only").toString("base64")}`);
  if (method === "POST") {
    assert.equal(body.apiOperation, "INITIATE_CHECKOUT");
    if (loseResponse) throw new Error("Lost response containing sensitive provider details");
    return Response.json({ result: "SUCCESS", session: { id: "SESSION" + body.order.id.replace("MVG-", "").toUpperCase(), updateStatus: "SUCCESS" } });
  }
  const orderId = address.split("/order/")[1]?.split("/")[0];
  const order = orders.get(orderId);
  return order ? Response.json(order) : Response.json({ error: { cause: "INVALID_REQUEST", explanation: "Unable to find order" } }, { status: 400 });
};
let provider: PaymentProvider;
test.before(async () => { db = await openDatabase({ embedded: true, dataDir: "memory://" }); provider = createMpgsProvider(config, { db: async () => db, fetch: fakeFetch }); });
test.after(async () => { setPaymentProviderForTests(null); await db.close(); });

test("MPGS configuration and money reject unsafe gateway URLs, wrong currency and rounding", () => {
  assert.equal(mpgsMinor("0.01"), 1); assert.equal(mpgsMinor(99), 9900);
  for (const amount of ["1.001", "-1", "1e2", "NaN", null]) assert.throws(() => mpgsMinor(amount));
  for (const gateway of ["http://ap-gateway.mastercard.com", "https://ap-gateway.mastercard.com.evil.test", "https://user@ap-gateway.mastercard.com", "https://ap-gateway.mastercard.com/path"])
    assert.throws(() => createMpgsProvider({ ...config, gateway }));
});

test("MPGS checkout uses the persisted AED amount, one session per idempotency key and no customer/card data in the local row", async () => {
  const r = req("contract"), before = requests.length;
  const session = await provider.createCheckout(r);
  assert.match(session.id, /^MVG-[a-f0-9]{32}$/);
  const post = requests[before];
  assert.equal(post.body.order.amount, "99.00"); assert.equal(post.body.order.currency, "AED");
  assert.equal(post.body.interaction.operation, "PURCHASE"); assert.equal(post.body.interaction.merchant.name, "Maximus Sports");
  assert.equal(post.body.interaction.returnUrl, r.successUrl); assert.equal(post.body.interaction.timeout, 1800);
  const again = await provider.createCheckout({ ...r, expiresAt: new Date(Date.now() + 3600000) });
  assert.equal(again.url, session.url); assert.equal(requests.length, before + 1);
  const [saved] = await db.query<{ request: Record<string, unknown> }>("select request from mpgs_sessions where id=$1", [session.id]);
  assert.equal(saved.request.customerEmail, undefined);
  await assert.rejects(provider.createCheckout({ ...r, amountMinor: 10000 }), /idempotency/);
  await assert.rejects(provider.createCheckout({ ...req("usd"), currency: "USD" }), /currency/);
  await assert.rejects(provider.createCheckout({ ...req("redirect"), successUrl: "https://evil.test/pay" }), /return URL/);
});

test("A lost create response cannot open another payable session; provider error text cannot reveal credentials", async () => {
  loseResponse = true; const r = req("ambiguous"), before = requests.filter(r => r.method === "POST").length;
  await assert.rejects(provider.createCheckout(r), /^Error: MPGS request failed \(0\)$/);
  loseResponse = false;
  await assert.rejects(provider.createCheckout(r), /needs reconciliation/);
  assert.equal(requests.filter(r => r.method === "POST").length, before + 1);
});

test("Concurrent MPGS starts create only one external session and a local timeout never authorizes a replacement charge", async () => {
  const r = req("concurrent"), before = requests.filter(r => r.method === "POST").length;
  const outcomes = await Promise.allSettled([provider.createCheckout(r), provider.createCheckout(r)]);
  const success = outcomes.find(x => x.status === "fulfilled");
  assert.ok(success && success.status === "fulfilled");
  assert.equal(requests.filter(r => r.method === "POST").length, before + 1);
  await db.query("update mpgs_sessions set expires_at=now()-interval '1 minute' where id=$1", [success.value.id]);
  const state = await provider.retrieveSession(success.value.id);
  assert.equal(state.status, "complete"); assert.equal(state.paymentStatus, "unpaid"); assert.equal(state.url, null);
});

test("Server reconciliation requires exact merchant, order, captured amount and currency; authorization and redirect indicators cannot pay", async () => {
  const r = req("reconcile"), session = await provider.createCheckout(r);
  const order = { result: "SUCCESS", id: session.id, merchant: config.merchantId, amount: "99.00", currency: "AED", totalCapturedAmount: "0.00", totalRefundedAmount: "0.00", status: "AUTHORIZED" };
  orders.set(session.id, order);
  assert.equal((await provider.retrieveSession(session.id)).paymentStatus, "unpaid");
  orders.set(session.id, { ...order, status: "CAPTURED", totalCapturedAmount: "99.00" });
  assert.equal((await provider.retrieveSession(session.id)).paymentStatus, "paid");
  for (const mismatch of [{ merchant: "ANOTHER" }, { id: "another" }, { currency: "USD" }, { amount: "1.00" }, { totalCapturedAmount: "98.99" }]) {
    orders.set(session.id, { ...order, status: "CAPTURED", totalCapturedAmount: "99.00", ...mismatch });
    await assert.rejects(provider.retrieveSession(session.id), /mismatch/);
  }
  orders.set(session.id, { ...order, status: "REFUNDED", totalCapturedAmount: "99.00", totalRefundedAmount: "99.00" });
  assert.equal((await provider.retrieveSession(session.id)).refundedTotal, 9900);
  assert.throws(() => provider.verifyWebhook('{"paid":true}', "forged"), /server-side/);
});

test("Temporary intercompany collection requires the owner's recorded authorization, correct beneficiary and AED offer", () => {
  Object.assign(process.env, { PAYMENT_PROVIDER: "mpgs", MPGS_GATEWAY_URL: config.gateway, MPGS_MERCHANT_ID: config.merchantId,
    MPGS_API_PASSWORD: config.password, MPGS_MERCHANT_NAME: config.merchantName, MPGS_CURRENCY: "AED", NEXT_PUBLIC_SITE_URL: config.origin,
    PAYMENTS_ENABLED: "1", PAYMENTS_MODE: "test", MPGS_INTERCOMPANY_AUTHORIZED: "1", MPGS_AGREEMENT_REF: "owner-fixture",
    MPGS_BENEFICIARY_LEGAL_NAME: "MAXIMUS VEGAS L.L.C-FZ" });
  assert.equal(paymentReadiness().ready, true); assert.equal(paymentReadiness().collector, "Maximus Sports");
  process.env.MPGS_BENEFICIARY_LEGAL_NAME = "Other"; assert.equal(paymentReadiness().ready, false);
  process.env.MPGS_BENEFICIARY_LEGAL_NAME = "MAXIMUS VEGAS L.L.C-FZ";
  delete process.env.MPGS_AGREEMENT_REF; assert.equal(paymentReadiness().ready, false);
  process.env.MPGS_AGREEMENT_REF = "owner-fixture";
});

test("Hosted handoff discloses the collector in RU/EN, escapes content, is private and contains no API password", () => {
  for (const lang of ["ru", "en"] as const) {
    const page = mpgsCheckoutPage({ gateway: config.gateway, session: "SESSION123", merchant: "Maximus Sports<script>bad</script>",
      beneficiary: "MAXIMUS VEGAS L.L.C-FZ", amount: 9900, lang, cancel: "https://www.maximus.vegas/en/billing" });
    assert.match(page.body, /99\.00 AED/); assert.match(page.body, /Maximus Sports&lt;script&gt;/);
    assert.ok(!page.body.includes(config.password)); assert.equal(page.headers["Referrer-Policy"], "no-referrer");
    assert.match(page.headers["Content-Security-Policy"], /frame-ancestors 'none'/);
    assert.match(page.body, /Checkout.showPaymentPage/);
  }
});

test("Full isolated membership flow: one captured MPGS order activates once; a later full refund ends access and replay cannot restore it", async () => {
  Object.assign(process.env, { MERCHANT_VERIFIED: "1", MERCHANT_LEGAL_NAME: "MAXIMUS VEGAS L.L.C-FZ" });
  setPaymentProviderForTests(provider);
  const createUser = async (username: string): Promise<SessionUser> => {
    const signup = await signUp(db, { email: `${username}@example.test`, username, displayName: username,
      password: "correct horse battery", adult: "on", terms: "on" });
    const u = (await sessionUser(db, signup.token))!;
    await db.query("update users set email_verified_at=now() where id=$1", [u.id]); return u;
  };
  const owner = await createUser("mpgsadmin"); await db.query("insert into user_roles(user_id,role) values($1,'admin')", [owner.id]);
  const admin = { ...owner, roles: ["admin"], mfaAt: new Date() } as SessionUser;
  const offerId = await createOfferVersion(db, admin, { code: "vegas-membership", kind: "membership", titleRu: "Членство", titleEn: "Membership",
    benefitsRu: "Тест", benefitsEn: "Fixture", exclusionsRu: "", exclusionsEn: "", price: "99.00", currency: "AED", taxTreatment: "Fixture",
    durationDays: "30", admission: "review", termsRu: "Тест", termsEn: "Fixture", refundRu: "Тест", refundEn: "Fixture" });
  await approveOffer(db, admin, offerId, "Offline fixture approval"); assert.equal(paymentReadiness(await publicOffer(db)).ready, true);
  const member = await createUser("mpgsmember"), app = await applyForMembership(db, member, {}, "en");
  await decideApplication(db, admin, app.id, "approved", "Fixture", "en");
  const invoice = await issueInvoice(db, admin, app.id, "en");
  const url = await startCheckout(db, member, invoice.id, "on", "en"), orderId = new URL(url).searchParams.get("order")!;
  const [attempt] = await db.query<{ id: string }>("select id from payment_attempts where invoice_id=$1", [invoice.id]);
  const order = { result: "SUCCESS", id: orderId, merchant: config.merchantId, amount: "99.00", currency: "AED", totalCapturedAmount: "99.00", totalRefundedAmount: "0.00", status: "CAPTURED" };
  orders.set(orderId, order);
  await reconcileAttempt(db, attempt.id, "return"); await reconcileAttempt(db, attempt.id, "return");
  let [membership] = await db.query<{ status: string }>("select status from memberships where invoice_id=$1", [invoice.id]); assert.equal(membership.status, "active");
  const [count] = await db.query<{ n: number }>("select count(*)::int as n from ledger_entries where invoice_id=$1 and kind='charge'", [invoice.id]); assert.equal(count.n, 1);
  orders.set(orderId, { ...order, status: "REFUNDED", totalRefundedAmount: "99.00" });
  await reconcileAttempt(db, attempt.id, "sweep");
  [membership] = await db.query<{ status: string }>("select status from memberships where invoice_id=$1", [invoice.id]); assert.equal(membership.status, "ended");
  orders.set(orderId, order); await reconcileAttempt(db, attempt.id, "return");
  [membership] = await db.query<{ status: string }>("select status from memberships where invoice_id=$1", [invoice.id]); assert.equal(membership.status, "ended");
  const [inv] = await db.query<{ status: string }>("select status from invoices where id=$1", [invoice.id]); assert.equal(inv.status, "refunded");
});
