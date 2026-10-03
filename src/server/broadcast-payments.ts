import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { paymentProvider, RECIPIENT } from "./billing.ts";
import type { CheckoutRequest, PaymentProvider, ProviderEvent, SessionState } from "./payments/provider.ts";
import { WebhookSignatureError } from "./payments/provider.ts";
import { broadcastAvailability, broadcastQuote, type BroadcastTariff } from "./broadcast-config.ts";
import { broadcastId, getBroadcast } from "./broadcasts.ts";
import { fail } from "./errors.ts";
import { audit } from "./audit.ts";
import { gate } from "./system.ts";
import { siteOrigin } from "../lib/site.ts";

type Order = {
  id: string; broadcast_id: string; user_id: string; state: "pending" | "paid" | "expired" | "revoked";
  amount_minor: number; currency: string; tariff: BroadcastTariff; mode: "test" | "live";
  session_id: string | null; payment_intent_id: string | null; checkout_expires_at: Date;
  checkout_request: Omit<CheckoutRequest, "expiresAt"> & { expiresAt: string };
};
const provider = () => paymentProvider() ?? fail("payments_unavailable");
const safeCheckout = (url: string, p: PaymentProvider) => {
  try { const u = new URL(url); if (u.protocol === "https:" && !u.username && !u.password && !u.port && p.checkoutHosts.includes(u.hostname)) return url; } catch { /* reject */ }
  return fail("provider_error");
};

/** Request UUID is client-generated once per purchase. All money, entitlements and terms are server-derived. */
export async function createBroadcastCheckout(db: Database, user: SessionUser, input: Record<string, unknown>, lang: "ru" | "en") {
  await gate(db, "broadcast.checkout", user);
  if (user.restricted) fail("account_restricted");
  const requestId = broadcastId(input.requestId);
  const availability = await broadcastAvailability(db);
  if (!availability.ready || !availability.tariff) fail("payments_unavailable");
  const t = availability.tariff ?? fail("payments_unavailable");
  if (input.terms !== true || input.rights !== true) fail("consent_required");
  if (input.version !== t.version) fail("offer_unavailable");
  const quote = broadcastQuote(input, t);
  if (input.expectedMinor !== quote.amountMinor) fail("offer_unavailable");
  const title = typeof input.title === "string" ? input.title.replace(/[\r\n\t]/g, " ").trim() : "";
  if (!title || title.length > 120) fail("invalid_input");
  const p = provider();
  const order = await db.tx(async q => {
    // Account locking serializes purchases and account closure across database connections.
    const [active] = await q.query("select 1 from users where id=$1 and status='active' for update", [user.id]);
    if (!active) fail("account_suspended");
    const [existing] = await q.query<Order>("select * from broadcast_orders where id=$1", [requestId]);
    if (existing) { if (existing.user_id !== user.id) fail("forbidden"); return existing; }
    const [open] = await q.query("select id from native_broadcasts where owner_id=$1 and state in ('unpaid','paid','starting','live','stopping') limit 1", [user.id]);
    if (open) fail("checkout_in_progress");
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 3600000);
    const origin = siteOrigin() ?? fail("payments_unavailable");
    const req: CheckoutRequest = { attemptId: requestId, invoiceId: requestId, invoiceNumber: `MV-STREAM-${requestId}`,
      amountMinor: quote.amountMinor, currency: quote.currency, description: `MAXIMUS VEGAS · ${quote.minutes} min · ${quote.retentionDays} days`,
      customerEmail: user.email, successUrl: `${origin}/${lang}/studio?payment=${requestId}`, cancelUrl: `${origin}/${lang}/studio`,
      expiresAt, locale: lang, idempotencyKey: `native-broadcast-${requestId}`,
      metadata: { product: "native_broadcast", orderId: requestId, broadcastId: id, userId: user.id, tariff: t.version } };
    await q.query(`insert into native_broadcasts(id,owner_id,title,mode,minutes,max_viewers,retention_days,room_name,archive_key)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, user.id, title, quote.mode, quote.minutes, quote.maxViewers, quote.retentionDays,
      `mv-broadcast-${id}`, `broadcasts/${id}/pov.mp4`]);
    const [row] = await q.query<Order>(`insert into broadcast_orders(id,broadcast_id,user_id,amount_minor,currency,tariff,mode,checkout_expires_at,checkout_request)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`, [requestId, id, user.id, quote.amountMinor, quote.currency, JSON.stringify(t), p.mode, expiresAt, JSON.stringify(req)]);
    await audit(q, { actorId: user.id, action: "broadcast.order", entity: "broadcast_order", entityId: requestId,
      data: { ...quote, recipient: RECIPIENT, approval: t.approvalRef, rights: true, terms: true } });
    return row;
  });
  const url = await resumeOrder(db, order, p);
  return { id: order.broadcast_id, orderId: order.id, url };
}

async function resumeOrder(db: Database, order: Order, p: PaymentProvider) {
  if (order.mode !== p.mode) fail("payments_unavailable");
  if (order.state !== "pending") return null;
  let sessionId = order.session_id;
  if (!sessionId) {
    // Persisted parameters are identical even after a lost response or a changed tariff/site origin.
    const req = { ...order.checkout_request, expiresAt: new Date(order.checkout_request.expiresAt) };
    let session;
    try { session = await p.createCheckout(req); }
    catch { return fail("provider_error"); }
    sessionId = session.id;
    await db.query("update broadcast_orders set session_id=$2 where id=$1 and session_id is null", [order.id, session.id]);
  }
  const state = await p.retrieveSession(sessionId);
  await reconcileBroadcastPayment(db, order.id, state, p);
  return state.status === "open" && state.url ? safeCheckout(state.url, p) : null;
}

export async function resumeBroadcastCheckout(db: Database, user: SessionUser, id: unknown) {
  if (user.restricted) fail("account_restricted");
  await gate(db, "broadcast.checkout", user);
  if (!(await broadcastAvailability(db)).ready) fail("payments_unavailable");
  const b = await getBroadcast(db, id);
  if (b.owner_id !== user.id) fail("forbidden");
  const [o] = await db.query<Order>("select * from broadcast_orders where broadcast_id=$1", [b.id]);
  if (!o) fail("not_found");
  return { url: await resumeOrder(db, o, provider()) };
}

/** Used only with a server retrieval. Never exported as an API accepting a client's payment object. */
export async function reconcileBroadcastPayment(db: Database, orderId: string, s: SessionState, p: PaymentProvider) {
  return db.tx(async q => {
    const [o] = await q.query<Order>("select * from broadcast_orders where id=$1 for update", [orderId]);
    if (!o || s.metadata.product !== "native_broadcast" || s.metadata.orderId !== o.id || s.metadata.userId !== o.user_id ||
      s.metadata.broadcastId !== o.broadcast_id || s.metadata.tariff !== o.tariff.version || s.clientReferenceId !== o.id ||
      (o.session_id && o.session_id !== s.id) || o.amount_minor !== s.amountTotal || o.currency !== s.currency ||
      s.livemode !== (o.mode === "live") || p.mode !== o.mode) return fail("provider_error");
    await q.query("update broadcast_orders set session_id=coalesce(session_id,$2),payment_intent_id=coalesce(payment_intent_id,$3) where id=$1", [o.id, s.id, s.paymentIntentId]);
    if (o.state === "revoked" || o.state === "paid") return o.state;
    if (s.status === "complete" && s.paymentStatus === "paid" && s.paymentIntentId) {
      const b = await getBroadcast(q, o.broadcast_id);
      if (b.state !== "unpaid") fail("session_state");
      await q.query("update broadcast_orders set state='paid',paid_at=now() where id=$1", [o.id]);
      await q.query("update native_broadcasts set state='paid',updated_at=now() where id=$1 and state='unpaid'", [o.broadcast_id]);
      await audit(q, { actorId: o.user_id, action: "broadcast.paid", entity: "broadcast_order", entityId: o.id, data: { amount: o.amount_minor, currency: o.currency } });
      return "paid";
    }
    if (s.status === "expired") {
      await q.query("update broadcast_orders set state='expired' where id=$1 and state='pending'", [o.id]);
      await q.query("update native_broadcasts set state='ended',failure='payment_expired',ended_at=now(),updated_at=now() where id=$1 and state='unpaid'", [o.broadcast_id]);
    }
    return o.state;
  });
}

export async function syncBroadcastPayments(db: Database, userId?: string) {
  const p = paymentProvider();
  if (!p) return;
  const orders = await db.query<Order>(`select * from broadcast_orders where state='pending' and mode=$1
    ${userId ? "and user_id=$2" : ""} order by created_at limit 10`, userId ? [p.mode, userId] : [p.mode]);
  for (const o of orders) {
    try { await resumeOrder(db, o, p); }
    catch {
      // An expired request with no known session cannot create a new charge. Keep it unresolved for
      // webhook/operator reconciliation: never silently abandon a possibly paid checkout.
    }
  }
}

async function revoke(q: Queryable, o: Order) {
  await q.query("update broadcast_orders set state='revoked' where id=$1", [o.id]);
  await q.query(`update native_broadcasts set state=case when state in ('starting','live','stopping') then 'stopping' else 'deleting' end,
    delete_requested_at=now(),cleanup_until=now()+interval '2 minutes',failure='payment_revoked',updated_at=now() where id=$1 and state<>'deleted'`, [o.broadcast_id]);
  await audit(q, { actorId: null, action: "broadcast.payment_revoked", entity: "broadcast_order", entityId: o.id });
}

/** Share the existing verified Stripe endpoint. Unrelated membership events fall through unchanged. */
export async function handleBroadcastPaymentWebhook(db: Database, raw: string, signature: string | null) {
  const p = paymentProvider();
  if (!p) return null;
  let event: ProviderEvent;
  try { event = p.verifyWebhook(raw, signature); }
  catch (e) { if (e instanceof WebhookSignatureError) return { status: 400, body: "invalid signature" }; throw e; }
  const obj = event.object;
  const metadata = obj.metadata as Record<string, string> | undefined;
  let orderId = metadata?.product === "native_broadcast" ? metadata.orderId : undefined;
  const pi = typeof obj.payment_intent === "string" ? obj.payment_intent : null;
  if (!orderId && pi) {
    const [o] = await db.query<Order>("select * from broadcast_orders where payment_intent_id=$1", [pi]);
    orderId = o?.id;
    if (!orderId && ["charge.refunded", "charge.dispute.created"].includes(event.type)) {
      const intent = await p.retrievePaymentIntent(pi);
      if (intent.metadata.product === "native_broadcast") orderId = intent.metadata.orderId;
    }
  }
  if (!orderId) return null;
  broadcastId(orderId);
  const [o] = await db.query<Order>("select * from broadcast_orders where id=$1", [orderId]);
  if (!o) return { status: 400, body: "unknown order" };
  if (event.livemode !== (o.mode === "live") || p.mode !== o.mode) return { status: 400, body: "mode mismatch" };
  const [seen] = await db.query<{ payload_hash: string }>("select payload_hash from broadcast_payment_events where id=$1", [event.id]);
  if (seen) return { status: seen.payload_hash === event.payloadSha256 ? 200 : 400, body: "duplicate" };
  if (event.type.startsWith("checkout.session.") && typeof obj.id === "string") {
    await reconcileBroadcastPayment(db, o.id, await p.retrieveSession(obj.id), p);
  } else if (["charge.refunded", "charge.dispute.created"].includes(event.type) && pi) {
    const intent = await p.retrievePaymentIntent(pi);
    if ((o.payment_intent_id && o.payment_intent_id !== pi) || intent.metadata.orderId !== o.id || intent.metadata.product !== "native_broadcast" || intent.metadata.userId !== o.user_id ||
      intent.amount !== o.amount_minor || intent.currency !== o.currency || intent.livemode !== event.livemode) return { status: 400, body: "payment mismatch" };
    await db.tx(async q => {
      const [locked] = await q.query<Order>("select * from broadcast_orders where id=$1 for update", [o.id]);
      if (locked.state !== "revoked") await revoke(q, locked);
    });
  }
  await db.query("insert into broadcast_payment_events(id,payload_hash) values($1,$2) on conflict(id) do nothing", [event.id, event.payloadSha256]);
  return { status: 200, body: "ok" };
}
