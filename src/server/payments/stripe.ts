/**
 * Stripe adapter (hosted Checkout). It is a technical candidate only: configuring it is not evidence
 * that the merchant account belongs to MAXIMUS VEGAS L.L.C-FZ or is approved for membership fees —
 * that is attested separately (MERCHANT_VERIFIED, MERCHANT_LEGAL_NAME) and checked by the readiness gate.
 */
import { createHash } from "node:crypto";
import Stripe from "stripe";
import { WebhookSignatureError, type CheckoutRequest, type Mode, type PaymentProvider, type ProviderEvent, type SessionState } from "./provider.ts";

type Client = Pick<Stripe, "checkout" | "paymentIntents" | "refunds" | "webhooks">;

export function stripeModeOf(secretKey: string): Mode | null {
  if (/^(sk|rk)_live_/.test(secretKey)) return "live";
  if (/^(sk|rk)_test_/.test(secretKey)) return "test";
  return null;
}

const meta = (m: Stripe.Metadata | null | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, String(v)]));

export function createStripeProvider(options: { secretKey: string; webhookSecret: string; client?: Client }): PaymentProvider {
  const mode = stripeModeOf(options.secretKey);
  if (!mode) throw new Error("Unrecognised Stripe key");
  const stripe: Client = options.client ?? new Stripe(options.secretKey, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: "maximus-vegas-portal" } });

  const toState = (s: Stripe.Checkout.Session): SessionState => ({
    id: s.id,
    url: s.status === "open" ? s.url ?? null : null,
    status: (s.status ?? "open") as SessionState["status"],
    paymentStatus: s.payment_status as SessionState["paymentStatus"],
    amountTotal: s.amount_total ?? null,
    currency: s.currency ? s.currency.toUpperCase() : null,
    paymentIntentId: typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id ?? null,
    clientReferenceId: s.client_reference_id ?? null,
    metadata: meta(s.metadata),
    livemode: s.livemode,
  });

  return {
    name: "stripe",
    mode,
    checkoutHosts: ["checkout.stripe.com"],
    async createCheckout(req: CheckoutRequest) {
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          line_items: [
            {
              quantity: 1,
              price_data: { currency: req.currency.toLowerCase(), unit_amount: req.amountMinor, product_data: { name: req.description } },
            },
          ],
          client_reference_id: req.invoiceId,
          customer_email: req.customerEmail,
          success_url: req.successUrl,
          cancel_url: req.cancelUrl,
          expires_at: Math.floor(req.expiresAt.getTime() / 1000),
          locale: req.locale,
          metadata: req.metadata,
          payment_intent_data: { metadata: req.metadata, description: `${req.description} · ${req.invoiceNumber}` },
        },
        { idempotencyKey: req.idempotencyKey },
      );
      if (!session.url) throw new Error("Stripe returned no checkout URL");
      return { id: session.id, url: session.url, expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : null };
    },
    async retrieveSession(id) {
      return toState(await stripe.checkout.sessions.retrieve(id));
    },
    async retrievePaymentIntent(id) {
      const pi = await stripe.paymentIntents.retrieve(id);
      return { id: pi.id, metadata: meta(pi.metadata), amount: pi.amount, currency: pi.currency.toUpperCase(), status: pi.status, livemode: pi.livemode };
    },
    verifyWebhook(rawBody, signature): ProviderEvent {
      if (!signature) throw new WebhookSignatureError("missing signature");
      let event: Stripe.Event;
      try {
        // Verifies the HMAC over the exact raw body and rejects timestamps outside a 5-minute tolerance.
        event = stripe.webhooks.constructEvent(rawBody, signature, options.webhookSecret, 300);
      } catch (error) {
        throw new WebhookSignatureError((error as Error).message);
      }
      return {
        id: event.id,
        type: event.type,
        livemode: event.livemode,
        created: new Date(event.created * 1000),
        object: event.data.object as unknown as Record<string, unknown>,
        payloadSha256: createHash("sha256").update(rawBody).digest("hex"),
      };
    },
    async refund(paymentIntentId, amountMinor, idempotencyKey) {
      const refund = await stripe.refunds.create({ payment_intent: paymentIntentId, amount: amountMinor }, { idempotencyKey });
      return { id: refund.id };
    },
  };
}
