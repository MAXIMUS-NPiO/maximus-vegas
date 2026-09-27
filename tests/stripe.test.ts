/**
 * Stripe adapter checks with the real Stripe SDK and no network:
 *  - webhook signatures are verified by the SDK over the raw body, with a timestamp tolerance;
 *  - checkout parameters are built from server-side values only (captured through a fake client).
 * No Stripe sandbox call is made here: sandbox integration requires keys that are NOT PROVIDED.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { createStripeProvider, stripeModeOf } from "../src/server/payments/stripe.ts";
import { WebhookSignatureError } from "../src/server/payments/provider.ts";

const secret = "whsec_test_" + "a".repeat(32);
const sdk = new Stripe("sk_test_offline_key_for_signature_tests");

test("stripe: key prefixes decide the mode; unknown keys are refused", () => {
  assert.equal(stripeModeOf("sk_test_123"), "test");
  assert.equal(stripeModeOf("sk_live_123"), "live");
  assert.equal(stripeModeOf("rk_test_123"), "test");
  assert.equal(stripeModeOf("pk_test_123"), null, "publishable keys are never accepted");
  assert.throws(() => createStripeProvider({ secretKey: "nope", webhookSecret: secret }));
});

test("stripe: webhook signatures are verified over the raw body with replay protection", () => {
  const provider = createStripeProvider({ secretKey: "sk_test_offline", webhookSecret: secret });
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed", livemode: false, created: 1, data: { object: { id: "cs_1" } } });
  const header = sdk.webhooks.generateTestHeaderString({ payload, secret });
  const event = provider.verifyWebhook(payload, header);
  assert.equal(event.id, "evt_1");
  assert.equal(event.type, "checkout.session.completed");
  assert.equal((event.object as { id: string }).id, "cs_1");
  assert.throws(() => provider.verifyWebhook(payload.replace("cs_1", "cs_2"), header), WebhookSignatureError, "tampered body");
  assert.throws(() => provider.verifyWebhook(payload, null), WebhookSignatureError, "missing signature");
  const wrongSecret = sdk.webhooks.generateTestHeaderString({ payload, secret: "whsec_other" });
  assert.throws(() => provider.verifyWebhook(payload, wrongSecret), WebhookSignatureError, "wrong secret");
  const old = sdk.webhooks.generateTestHeaderString({ payload, secret, timestamp: Math.floor(Date.now() / 1000) - 3600 });
  assert.throws(() => provider.verifyWebhook(payload, old), WebhookSignatureError, "stale timestamp (replay)");
});

test("stripe: checkout is built from server values with an idempotency key and hosted page only", async () => {
  const calls: Array<{ params: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const fake = {
    checkout: {
      sessions: {
        create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
          calls.push({ params, options });
          return { id: "cs_test_x", url: "https://checkout.stripe.com/c/pay/cs_test_x", expires_at: 2_000_000_000 };
        },
        retrieve: async () => ({ id: "cs_test_x", status: "open", url: "https://checkout.stripe.com/c/pay/cs_test_x", payment_status: "unpaid", amount_total: 9900, currency: "aed", payment_intent: null, client_reference_id: "inv", metadata: {}, livemode: false }),
      },
    },
    paymentIntents: { retrieve: async () => ({}) },
    refunds: { create: async () => ({ id: "re_1" }) },
    webhooks: sdk.webhooks,
  };
  const provider = createStripeProvider({ secretKey: "sk_test_offline", webhookSecret: secret, client: fake as never });
  const session = await provider.createCheckout({
    attemptId: "att-1",
    invoiceId: "inv-1",
    invoiceNumber: "MV-INV-2026-00001",
    amountMinor: 9900,
    currency: "AED",
    description: "MAXIMUS VEGAS membership",
    customerEmail: "member@example.com",
    successUrl: "https://www.maximus.vegas/en/billing/return?attempt=att-1",
    cancelUrl: "https://www.maximus.vegas/en/billing/invoices/MV-INV-2026-00001?canceled=1",
    expiresAt: new Date(Date.now() + 3600_000),
    locale: "en",
    idempotencyKey: "checkout:inv-1:1",
    metadata: { invoice_id: "inv-1", attempt_id: "att-1" },
  });
  assert.equal(session.url.startsWith("https://checkout.stripe.com/"), true);
  assert.ok(provider.checkoutHosts.includes(new URL(session.url).host));
  const [{ params, options }] = calls;
  assert.equal(options.idempotencyKey, "checkout:inv-1:1");
  assert.equal(params.mode, "payment", "one-time payment, no recurring billing");
  assert.equal(params.client_reference_id, "inv-1");
  const item = (params.line_items as Array<{ price_data: { currency: string; unit_amount: number } }>)[0];
  assert.equal(item.price_data.currency, "aed");
  assert.equal(item.price_data.unit_amount, 9900);
  assert.equal(params.payment_method_types, undefined, "no payment methods are asserted by the portal");
  const state = await provider.retrieveSession("cs_test_x");
  assert.equal(state.currency, "AED");
  assert.equal(state.url, "https://checkout.stripe.com/c/pay/cs_test_x");
});
