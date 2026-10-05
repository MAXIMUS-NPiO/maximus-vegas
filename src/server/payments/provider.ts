/**
 * Payment provider boundary. The portal never sees card data: checkout happens on the provider's hosted
 * page. Every state change is taken from a signature-verified webhook or from a server-side retrieval of
 * the provider's authoritative object — never from a browser redirect.
 */

export type Mode = "test" | "live";

export type CheckoutRequest = {
  attemptId: string;
  invoiceId: string;
  invoiceNumber: string;
  amountMinor: number;
  currency: string;
  description: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  locale: "ru" | "en";
  idempotencyKey: string;
  metadata: Record<string, string>;
};

export type CheckoutSession = { id: string; url: string; expiresAt: Date | null };

export type SessionState = {
  id: string;
  /** Present only while the session is open. */
  url: string | null;
  status: "open" | "complete" | "expired";
  paymentStatus: "paid" | "unpaid" | "no_payment_required";
  amountTotal: number | null;
  currency: string | null;
  paymentIntentId: string | null;
  clientReferenceId: string | null;
  metadata: Record<string, string>;
  livemode: boolean;
  /** Authoritative settlement adjustments, when supported by the provider. */
  refundedTotal?: number;
  disputed?: boolean;
  voided?: boolean;
};

export type PaymentIntentInfo = { id: string; metadata: Record<string, string>; amount: number; currency: string; status: string; livemode: boolean };

export type ProviderEvent = {
  id: string;
  type: string;
  livemode: boolean;
  created: Date;
  object: Record<string, unknown>;
  payloadSha256: string;
};

export interface PaymentProvider {
  readonly name: string;
  readonly mode: Mode;
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  retrieveSession(id: string): Promise<SessionState>;
  retrievePaymentIntent(id: string): Promise<PaymentIntentInfo>;
  /** Verifies the signature against the raw request body and returns the parsed event, or throws. */
  verifyWebhook(rawBody: string, signature: string | null): ProviderEvent;
  refund(paymentIntentId: string, amountMinor: number, idempotencyKey: string): Promise<{ id: string }>;
  /** Hosts a checkout URL may redirect to; anything else is refused (no open redirects). */
  readonly checkoutHosts: string[];
}

export class WebhookSignatureError extends Error {
  constructor(message = "invalid signature") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}
