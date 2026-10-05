/** Mastercard MPGS hosted checkout. Card data stays on the gateway's payment page. */
import { createHash, randomBytes } from "node:crypto";
import { getDb, type Database } from "../db.ts";
import { WebhookSignatureError, type CheckoutRequest, type PaymentProvider, type SessionState } from "./provider.ts";

const API_VERSION = "75";
const HOSTS = ["ap-gateway.mastercard.com", "eu-gateway.mastercard.com", "na-gateway.mastercard.com"];
export type MpgsConfig = { gateway: string; merchantId: string; password: string; merchantName: string; currency: "AED"; origin: string };
type SavedRequest = Omit<CheckoutRequest, "customerEmail" | "expiresAt">;
type Row = { id: string; merchant_hash: string; mode: "test" | "live"; request: SavedRequest; fingerprint: string;
  session_id: string | null; token: string; expires_at: Date; creation_started: boolean };
type Json = Record<string, unknown>;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const obj = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const modeOf = (id: string) => id.startsWith("TEST") ? "test" as const : "live" as const;

export function mpgsConfig(): MpgsConfig | null {
  const value = { gateway: process.env.MPGS_GATEWAY_URL?.trim() ?? "", merchantId: process.env.MPGS_MERCHANT_ID?.trim() ?? "",
    password: process.env.MPGS_API_PASSWORD?.trim() ?? "", merchantName: process.env.MPGS_MERCHANT_NAME?.trim() ?? "",
    currency: process.env.MPGS_CURRENCY ?? "AED", origin: process.env.NEXT_PUBLIC_SITE_URL ?? "" };
  try { validateConfig(value as MpgsConfig); return value as MpgsConfig; } catch { return null; }
}

function validateConfig(c: MpgsConfig) {
  const u = new URL(c.gateway), site = new URL(c.origin);
  if (u.protocol !== "https:" || !HOSTS.includes(u.hostname) || u.port || u.username || u.password || u.search || u.hash || u.pathname !== "/" ||
    site.protocol !== "https:" || site.port || site.username || site.password || site.search || site.hash || site.pathname !== "/" ||
    !/^[a-zA-Z0-9_-]{1,40}$/.test(c.merchantId) || !c.password || !c.merchantName || c.merchantName.length > 40 || c.currency !== "AED")
    throw new Error("MPGS configuration is incomplete or invalid");
}

/** Decimal strings only; rounding, exponents, negatives and fractional fils are never accepted. */
export function mpgsMinor(value: unknown): number {
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error("Invalid MPGS amount");
  const n = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(n)) throw new Error("Invalid MPGS amount");
  return n;
}
const decimal = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;
export const isMpgsOrder = (id: string) => /^MVG-[a-f0-9]{32}$/.test(id);

class MpgsError extends Error {
  readonly status: number;
  readonly absent: boolean;
  constructor(status: number, absent = false) { super(`MPGS request failed (${status})`); this.status = status; this.absent = absent; }
}

export function createMpgsProvider(config: MpgsConfig, options: { db?: () => Promise<Database>; fetch?: typeof fetch } = {}): PaymentProvider {
  validateConfig(config);
  const mode = modeOf(config.merchantId), origin = new URL(config.origin).origin;
  const gateway = new URL(config.gateway).origin;
  const merchantHash = hash(`${gateway}:${config.merchantId}`);
  const database = options.db ?? getDb, request = options.fetch ?? fetch;
  const base = `${gateway}/api/rest/version/${API_VERSION}/merchant/${encodeURIComponent(config.merchantId)}`;
  const checkoutUrl = (row: Row) => `${origin}/api/payments/mpgs/checkout?order=${row.id}&token=${row.token}`;
  async function api(path: string, method = "GET", body?: Json): Promise<Json> {
    let response: Response;
    try {
      response = await request(`${base}${path}`, { method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Basic ${Buffer.from(`merchant.${config.merchantId}:${config.password}`).toString("base64")}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new MpgsError(0); }
    let data: Json;
    try { const raw = await response.text(); if (raw.length > 2_000_000) throw new Error(); data = obj(JSON.parse(raw)); }
    catch { throw new MpgsError(response.status); }
    const error = obj(data.error);
    if (!response.ok || data.result === "ERROR" || Object.keys(error).length) {
      const absent = response.status === 404 || (response.status === 400 && error.cause === "INVALID_REQUEST" &&
        /^Unable to find order\b/i.test(String(error.explanation ?? "")));
      throw new MpgsError(response.status, absent);
    }
    return data;
  }
  async function saved(id: string): Promise<Row> {
    if (!isMpgsOrder(id)) throw new Error("Invalid MPGS order");
    const [row] = await (await database()).query<Row>("select * from mpgs_sessions where id=$1", [id]);
    if (!row || row.merchant_hash !== merchantHash || row.mode !== mode) throw new Error("MPGS order is not owned by this merchant");
    return row;
  }
  async function state(row: Row): Promise<SessionState> {
    const s: SessionState = { id: row.id, url: row.session_id ? checkoutUrl(row) : null,
      // MPGS timeouts are best effort (3-D Secure may still be running). An elapsed local timer
      // freezes retries as processing; it is never evidence that another charge is safe.
      status: new Date(row.expires_at).getTime() <= Date.now() ? "complete" : "open", paymentStatus: "unpaid",
      amountTotal: row.request.amountMinor, currency: row.request.currency, paymentIntentId: null,
      clientReferenceId: row.request.invoiceId, metadata: row.request.metadata, livemode: mode === "live" };
    if (s.status !== "open") s.url = null;
    let order: Json;
    try { order = await api(`/order/${row.id}`); }
    catch (e) { if (e instanceof MpgsError && e.absent) return s; throw e; }
    // A successful GET alone says nothing about capture. Match the authoritative merchant/order and
    // currency; only the exact captured amount can grant access. Authorization is insufficient.
    if (order.result !== "SUCCESS" || order.id !== row.id || order.merchant !== config.merchantId || order.currency !== row.request.currency)
      throw new Error("MPGS order identity mismatch");
    const captured = mpgsMinor(order.totalCapturedAmount), refunded = mpgsMinor(order.totalRefundedAmount);
    if (captured > 0 && (mpgsMinor(order.amount) !== row.request.amountMinor || captured !== row.request.amountMinor))
      throw new Error("MPGS captured amount mismatch");
    if (refunded > captured) throw new Error("MPGS refund amount mismatch");
    const status = String(order.status ?? "");
    s.refundedTotal = refunded;
    s.disputed = ["DISPUTED", "CHARGEBACK_PROCESSED"].includes(status);
    s.voided = status === "CANCELLED";
    if (captured === row.request.amountMinor && captured > 0) {
      s.status = "complete"; s.paymentStatus = "paid"; s.paymentIntentId = row.id; s.url = null;
    } else if (["AUTHORIZED", "PARTIALLY_CAPTURED"].includes(status)) {
      s.status = "complete"; s.url = null;
    } else if (status === "CANCELLED") { s.status = "expired"; s.url = null; }
    return s;
  }
  return {
    name: "mpgs", mode, checkoutHosts: [new URL(origin).host],
    async createCheckout(req) {
      if (req.currency !== config.currency || !Number.isSafeInteger(req.amountMinor) || req.amountMinor <= 0 || req.amountMinor > 99_999_999)
        throw new Error("Unsupported MPGS amount or currency");
      for (const value of [req.successUrl, req.cancelUrl]) {
        const u = new URL(value);
        if (u.origin !== origin || !/^\/(ru|en)\//.test(u.pathname) || u.username || u.password) throw new Error("Invalid MPGS return URL");
      }
      const id = `MVG-${hash(`${merchantHash}:${req.idempotencyKey}`).slice(0, 32)}`;
      const { customerEmail: _email, expiresAt: _expires, ...persisted } = req;
      const fingerprint = hash(JSON.stringify(persisted));
      const db = await database();
      const expiry = new Date(Math.min(req.expiresAt.getTime(), Date.now() + 30 * 60_000));
      if (!Number.isFinite(expiry.getTime()) || expiry.getTime() < Date.now() + 600_000) throw new Error("MPGS checkout expiry is too soon");
      await db.query(`insert into mpgs_sessions(id,merchant_hash,mode,request,fingerprint,token,expires_at)
        values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do nothing`,
        [id, merchantHash, mode, JSON.stringify(persisted), fingerprint, randomBytes(32).toString("hex"), expiry]);
      // Persist the intent before the external request. If its response is lost, fail closed instead
      // of opening a second session; the existing order remains available to server reconciliation.
      const row = await db.tx(async q => {
        const [r] = await q.query<Row>("select * from mpgs_sessions where id=$1 for update", [id]);
        if (r.fingerprint !== fingerprint || r.merchant_hash !== merchantHash) throw new Error("MPGS idempotency conflict");
        if (r.session_id) return r;
        if (r.creation_started) throw new Error("MPGS session needs reconciliation");
        await q.query("update mpgs_sessions set creation_started=true where id=$1", [id]);
        return r;
      });
      if (row.session_id) return { id, url: checkoutUrl(row), expiresAt: new Date(row.expires_at) };
      const result = await api("/session", "POST", { apiOperation: "INITIATE_CHECKOUT",
        order: { id, amount: decimal(req.amountMinor), currency: req.currency, description: req.description.slice(0, 127), reference: req.invoiceId },
        interaction: { operation: "PURCHASE", merchant: { name: config.merchantName, url: origin }, locale: req.locale,
          returnUrl: req.successUrl, cancelUrl: req.cancelUrl, timeoutUrl: req.cancelUrl, timeout: 1800 } });
      const session = obj(result.session);
      if (result.result !== "SUCCESS" || typeof session.id !== "string" || !/^SESSION[0-9A-Z]+$/.test(session.id) || session.updateStatus !== "SUCCESS")
        throw new Error("MPGS did not create a checkout session");
      await db.query("update mpgs_sessions set session_id=$2 where id=$1 and session_id is null", [id, session.id]);
      return { id, url: checkoutUrl(row), expiresAt: new Date(row.expires_at) };
    },
    async retrieveSession(id) { return state(await saved(id)); },
    async retrievePaymentIntent(id) {
      const s = await state(await saved(id));
      return { id, metadata: s.metadata, amount: s.amountTotal!, currency: s.currency!, livemode: s.livemode,
        status: s.disputed || s.voided || (s.refundedTotal ?? 0) > 0 ? "revoked" : s.paymentStatus === "paid" ? "succeeded" : "processing" };
    },
    // MPGS notifications are not Stripe-signed events. Reconciliation uses authenticated GETs,
    // browser returns and the protected scheduler, never an unverified notification body.
    verifyWebhook() { throw new WebhookSignatureError("MPGS uses server-side order reconciliation"); },
    async refund(id, amount, key) {
      const row = await saved(id), s = await state(row);
      if (s.paymentStatus !== "paid" || s.disputed || !Number.isSafeInteger(amount) || amount <= 0 || amount > row.request.amountMinor - (s.refundedTotal ?? 0))
        throw new Error("MPGS refund is not available");
      const refundId = `MVR-${hash(key).slice(0, 32)}`;
      const result = await api(`/order/${id}/transaction/${refundId}`, "PUT", { apiOperation: "REFUND", transaction: { amount: decimal(amount), currency: row.request.currency } });
      if (result.result !== "SUCCESS") throw new Error("MPGS refund was not confirmed");
      return { id: refundId };
    },
  };
}

/** Capability is scoped to this checkout only, unrelated to the private API credentials. */
export async function mpgsLaunch(db: Database, order: string, token: string) {
  if (!isMpgsOrder(order) || !/^[a-f0-9]{64}$/.test(token)) return null;
  const [row] = await db.query<Row>("select * from mpgs_sessions where id=$1 and token=$2", [order, token]);
  if (!row?.session_id || new Date(row.expires_at).getTime() <= Date.now()) return null;
  const config = mpgsConfig();
  if (!config || row.merchant_hash !== hash(`${new URL(config.gateway).origin}:${config.merchantId}`) || row.mode !== modeOf(config.merchantId)) return null;
  return { row, config };
}
