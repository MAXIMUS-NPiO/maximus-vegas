/**
 * Membership offers, admission, invoices, hosted payments and membership state.
 *
 * Independent states (never inferred from one another):
 *  - application: submitted → under_review / awaiting_info → approved / declined; withdrawn by the applicant;
 *  - invoice: open → paid → partially_refunded / refunded / disputed; void;
 *  - payment attempt: created → open → processing → succeeded / failed / expired / canceled;
 *  - membership: pending (invoice issued) → active (payment verified) → suspended / expired / ended.
 * A successful charge never approves an application; a browser return never marks an invoice paid; a
 * refund or dispute is never undone by a late or replayed success event.
 *
 * Collection stays disabled unless the offer is approved and complete AND the merchant configuration is
 * verified for the offer's legal recipient (see `paymentReadiness`).
 */
import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { isAdmin, isStaff, notify } from "./access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { enqueueMail, link, mailConfigured } from "./mail.ts";
import { requireStepUp } from "./mfa.ts";
import { siteOrigin } from "../lib/site.ts";
import { createStripeProvider, stripeModeOf } from "./payments/stripe.ts";
import { WebhookSignatureError, type PaymentProvider, type ProviderEvent, type SessionState } from "./payments/provider.ts";
import * as v from "./validate.ts";

export const RECIPIENT = "MAXIMUS VEGAS L.L.C-FZ";

// ---------- Money ----------

const EXPONENTS: Record<string, number> = { AED: 2, USD: 2, EUR: 2, GBP: 2, SAR: 2, QAR: 2, INR: 2, RUB: 2, KWD: 3, BHD: 3, OMR: 3, JOD: 3, JPY: 0, KRW: 0 };
export const CURRENCIES = Object.keys(EXPONENTS);
export const exponentOf = (currency: string) => EXPONENTS[currency] ?? 2;

export function toMinor(amount: unknown, currency: string): number {
  const text = String(amount ?? "").trim().replace(",", ".");
  const exp = exponentOf(currency);
  const m = /^(\d{1,9})(?:\.(\d+))?$/.exec(text);
  if (!m || (m[2]?.length ?? 0) > exp) fail("invalid_input");
  const minor = Number(m![1]) * 10 ** exp + Number((m![2] ?? "").padEnd(exp, "0") || 0);
  if (!Number.isSafeInteger(minor) || minor <= 0) fail("invalid_input");
  return minor;
}

export function formatMoney(minor: number | string | null, currency: string | null, lang: "ru" | "en"): string {
  if (minor === null || !currency) return "";
  const exp = exponentOf(currency);
  return new Intl.NumberFormat(lang === "ru" ? "ru-RU" : "en-US", { style: "currency", currency, minimumFractionDigits: exp, maximumFractionDigits: exp }).format(Number(minor) / 10 ** exp);
}

// ---------- Offers ----------

type Texts = { ru: string; en: string };
type Lists = { ru: string[]; en: string[] };

export type Offer = {
  id: string;
  code: string;
  version: number;
  kind: "membership" | "pass_premium";
  status: "proposed" | "active" | "retired";
  title: Texts;
  benefits: Lists;
  exclusions: Lists;
  audience: string;
  legal_recipient: string;
  price_minor: string | null;
  currency: string | null;
  exponent: number | null;
  tax_treatment: string | null;
  duration_days: number | null;
  admission: "review" | "self_service";
  terms_text: Texts | null;
  refund_text: Texts | null;
  approval_ref: string | null;
  approved_at: Date | null;
  created_at: Date;
};

/** Required commercial fields. A null field is NOT PROVIDED and keeps the offer unpayable. */
export function missingFields(o: Offer): string[] {
  const missing: string[] = [];
  if (o.price_minor === null) missing.push("price");
  if (!o.currency) missing.push("currency");
  if (o.exponent === null) missing.push("exponent");
  if (!o.tax_treatment) missing.push("tax_treatment");
  if (!o.duration_days) missing.push("duration");
  if (!o.terms_text?.ru || !o.terms_text?.en) missing.push("terms");
  if (!o.refund_text?.ru || !o.refund_text?.en) missing.push("refund_and_cancellation");
  if (!o.approval_ref) missing.push("approval_reference");
  return missing;
}

export async function offers(q: Queryable) {
  return q.query<Offer>("select * from offers order by code, version desc");
}

/** The offer shown to members for a code: the active version, else the latest proposed one. */
export async function publicOffer(q: Queryable, code = "vegas-membership"): Promise<Offer | null> {
  const [o] = await q.query<Offer>(
    `select * from offers where code = $1 and status in ('active','proposed')
      order by case status when 'active' then 0 else 1 end, version desc limit 1`,
    [code],
  );
  return o ?? null;
}

const lines = (value: unknown) =>
  v
    .clean(value, 2000)
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 12);

export type OfferInput = Record<string, unknown>;

export async function createOfferVersion(db: Database, user: SessionUser, input: OfferInput) {
  if (!isAdmin(user)) fail("forbidden");
  requireStepUp(user);
  const code = v.oneLine(input.code, 40).toLowerCase();
  if (!/^[a-z0-9-]{3,40}$/.test(code)) fail("invalid_input");
  const kind = input.kind === "pass_premium" ? "pass_premium" : "membership";
  const currency = v.oneLine(input.currency, 3).toUpperCase() || null;
  if (currency && !CURRENCIES.includes(currency)) fail("invalid_input");
  const priceText = v.oneLine(input.price, 20);
  const price = priceText && currency ? toMinor(priceText, currency) : null;
  const duration = String(input.durationDays ?? "").trim() ? v.intIn(input.durationDays, 1, 1100) : null;
  const text = (ru: unknown, en: unknown) => {
    const r = v.clean(ru, 8000);
    const e = v.clean(en, 8000);
    return r && e ? { ru: r, en: e } : null;
  };
  const title = { ru: v.oneLine(input.titleRu, 120), en: v.oneLine(input.titleEn, 120) };
  if (!title.ru || !title.en) fail("invalid_input");
  return db.tx(async (q) => {
    const [n] = await q.query<{ v: number }>("select coalesce(max(version), 0)::int + 1 as v from offers where code = $1", [code]);
    const [row] = await q.query<{ id: string }>(
      `insert into offers (code, version, kind, status, title, benefits, exclusions, legal_recipient, price_minor, currency, exponent,
         tax_treatment, duration_days, admission, terms_text, refund_text, created_by)
       values ($1,$2,$3,'proposed',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
      [
        code,
        n.v,
        kind,
        JSON.stringify(title),
        JSON.stringify({ ru: lines(input.benefitsRu), en: lines(input.benefitsEn) }),
        JSON.stringify({ ru: lines(input.exclusionsRu), en: lines(input.exclusionsEn) }),
        RECIPIENT,
        price,
        currency,
        currency ? exponentOf(currency) : null,
        v.clean(input.taxTreatment, 300) || null,
        duration,
        input.admission === "self_service" ? "self_service" : "review",
        JSON.stringify(text(input.termsRu, input.termsEn)),
        JSON.stringify(text(input.refundRu, input.refundEn)),
        user.id,
      ],
    );
    await audit(q, { actorId: user.id, action: "offer.version_created", entity: "offer", entityId: row.id, data: { code, version: n.v } });
    return row.id;
  });
}

/** Activates a complete offer version with a recorded approval reference; the previous active version retires. */
export async function approveOffer(db: Database, user: SessionUser, offerId: string, approvalRefInput: unknown) {
  if (!isAdmin(user)) fail("forbidden");
  requireStepUp(user);
  const approvalRef = v.oneLine(approvalRefInput, 200);
  if (approvalRef.length < 3) fail("invalid_input");
  await db.tx(async (q) => {
    const [o] = await q.query<Offer>("select * from offers where id = $1 for update", [offerId]);
    if (!o) fail("not_found");
    if (o.status !== "proposed") fail("not_editable");
    const missing = missingFields({ ...o, approval_ref: approvalRef });
    if (missing.length) fail("offer_incomplete");
    await q.query("update offers set status = 'retired' where code = $1 and status = 'active'", [o.code]);
    await q.query("update offers set status = 'active', approval_ref = $2, approved_by = $3, approved_at = now() where id = $1", [o.id, approvalRef, user.id]);
    await audit(q, { actorId: user.id, action: "offer.approved", entity: "offer", entityId: o.id, data: { code: o.code, version: o.version, approvalRef } });
  });
}

export async function retireOffer(db: Database, user: SessionUser, offerId: string) {
  if (!isAdmin(user)) fail("forbidden");
  requireStepUp(user);
  await db.tx(async (q) => {
    const rows = await q.query("update offers set status = 'retired' where id = $1 and status <> 'retired' returning id", [offerId]);
    if (!rows.length) fail("not_found");
    await audit(q, { actorId: user.id, action: "offer.retired", entity: "offer", entityId: offerId });
  });
}

// ---------- Payment readiness ----------

export type Readiness = { ready: boolean; reasons: string[]; mode: "test" | "live" | null; provider: string | null };

type Holder = { __mvPaymentProvider?: PaymentProvider | null };

/** Test hook: automated tests inject a mock provider. Never set in production code paths. */
export function setPaymentProviderForTests(p: PaymentProvider | null) {
  (globalThis as Holder).__mvPaymentProvider = p;
}

export function paymentProvider(): PaymentProvider | null {
  const injected = (globalThis as Holder).__mvPaymentProvider;
  if (injected !== undefined) return injected;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!key || !secret || !stripeModeOf(key)) return null;
  return createStripeProvider({ secretKey: key, webhookSecret: secret });
}

export function paymentReadiness(offer?: Offer | null): Readiness {
  const reasons: string[] = [];
  const injected = (globalThis as Holder).__mvPaymentProvider;
  const key = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  const keyMode = injected ? injected.mode : stripeModeOf(key);
  if (process.env.PAYMENTS_ENABLED !== "1") reasons.push("payments_disabled");
  if (!injected) {
    if (!key) reasons.push("provider_not_configured");
    else if (!keyMode) reasons.push("provider_key_unrecognised");
    if (!process.env.STRIPE_WEBHOOK_SECRET?.trim()?.startsWith("whsec_")) reasons.push("webhook_secret_missing");
  }
  const declared = process.env.PAYMENTS_MODE === "live" ? "live" : process.env.PAYMENTS_MODE === "test" ? "test" : null;
  if (!declared) reasons.push("mode_not_declared");
  else if (keyMode && declared !== keyMode) reasons.push("mode_mismatch");
  if (keyMode === "live" && process.env.PAYMENTS_LIVE_CONFIRMED !== "1") reasons.push("live_not_confirmed");
  if (process.env.MERCHANT_VERIFIED !== "1") reasons.push("merchant_not_verified");
  const merchant = process.env.MERCHANT_LEGAL_NAME?.trim();
  if (!merchant) reasons.push("merchant_name_missing");
  else if (offer && merchant !== offer.legal_recipient) reasons.push("recipient_mismatch");
  if (!siteOrigin() && !injected) reasons.push("site_origin_missing");
  if (offer) {
    if (offer.status !== "active") reasons.push("offer_not_active");
    if (missingFields(offer).length) reasons.push("offer_incomplete");
  }
  return { ready: reasons.length === 0, reasons, mode: keyMode ?? null, provider: injected ? injected.name : key ? "stripe" : null };
}

// ---------- Applications (admission) ----------

const year = () => new Date().getUTCFullYear();

export async function applyForMembership(db: Database, user: SessionUser, input: { offer?: unknown; objective?: unknown }, lang: "ru" | "en") {
  const objective = v.clean(input.objective, 1000);
  const result = await db.tx(async (q) => {
    const code = v.oneLine(input.offer, 40) || "vegas-membership";
    const offer = await publicOffer(q, code);
    if (!offer) fail("offer_unavailable");
    const [seq] = await q.query<{ n: string }>("select nextval('membership_ref_seq')::text as n");
    const reference = `MV-M-${year()}-${seq.n.padStart(5, "0")}`;
    const selfService = offer!.admission === "self_service" && offer!.status === "active" && !missingFields(offer!).length;
    let id: string;
    try {
      const [row] = await q.query<{ id: string }>(
        `insert into membership_applications (reference, user_id, offer_id, status, objective, decision_note, decided_at, lang)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [reference, user.id, offer!.id, selfService ? "approved" : "submitted", objective, selfService ? `self-service admission (${offer!.approval_ref})` : "", selfService ? new Date().toISOString() : null, lang],
      );
      id = row.id;
    } catch (error) {
      if (isUniqueViolation(error)) fail("application_exists");
      throw error;
    }
    await audit(q, { actorId: user.id, action: "membership.applied", entity: "membership_application", entityId: id, data: { reference, offer: `${offer!.code}@${offer!.version}`, selfService } });
    await enqueueMail(q, { to: user.email, template: "membership_application", lang, userId: user.id, data: { reference, url: link(`/${lang}/billing`) } });
    if (selfService) await issueInvoiceTx(q, id, null, lang);
    return { id, reference };
  });
  return result;
}

const TRANSITIONS: Record<string, string[]> = {
  submitted: ["under_review", "awaiting_info", "approved", "declined"],
  under_review: ["awaiting_info", "approved", "declined"],
  awaiting_info: ["under_review", "approved", "declined"],
};

/** Staff admission decision, recorded with who decided, when and why. */
export async function decideApplication(db: Database, user: SessionUser, applicationId: string, statusInput: unknown, noteInput: unknown, lang: "ru" | "en") {
  if (!isStaff(user)) fail("forbidden");
  const status = String(statusInput);
  const note = v.clean(noteInput, 1000);
  if (status === "approved" || status === "declined") {
    requireStepUp(user);
    if (note.length < 3) fail("invalid_input");
  }
  await db.tx(async (q) => {
    const [a] = await q.query<{ id: string; status: string; user_id: string; reference: string; lang: "ru" | "en" }>(
      "select id, status, user_id, reference, lang from membership_applications where id = $1 for update",
      [applicationId],
    );
    if (!a) fail("not_found");
    if (!(TRANSITIONS[a.status] ?? []).includes(status)) fail("invalid_transition");
    await q.query(
      "update membership_applications set status = $2, decision_note = $3, decided_by = $4, decided_at = now(), updated_at = now() where id = $1",
      [a.id, status, note, user.id],
    );
    await notify(q, [a.user_id], "membership_application_status", { reference: a.reference, status });
    const [u] = await q.query<{ email: string }>("select email from users where id = $1", [a.user_id]);
    // Mail goes out in the applicant's language, not the language of the staff member's interface.
    const mailLang = a.lang ?? lang;
    if (u) await enqueueMail(q, { to: u.email, template: "membership_decision", lang: mailLang, userId: a.user_id, data: { reference: a.reference, url: link(`/${mailLang}/billing`) } });
    await audit(q, { actorId: user.id, action: "membership.decision", entity: "membership_application", entityId: a.id, data: { from: a.status, to: status, note, roles: user.roles } });
  });
}

export async function withdrawApplication(db: Database, user: SessionUser, applicationId: string) {
  await db.tx(async (q) => {
    const rows = await q.query(
      "update membership_applications set status = 'withdrawn', updated_at = now() where id = $1 and user_id = $2 and status in ('submitted','under_review','awaiting_info') returning id",
      [applicationId, user.id],
    );
    if (!rows.length) fail("not_editable");
    await audit(q, { actorId: user.id, action: "membership.withdrawn", entity: "membership_application", entityId: applicationId });
  });
}

// ---------- Invoices ----------

export async function issueInvoice(db: Database, user: SessionUser, applicationId: string, lang: "ru" | "en") {
  if (!isAdmin(user)) fail("forbidden");
  requireStepUp(user);
  return db.tx((q) => issueInvoiceTx(q, applicationId, user.id, lang));
}

/** Idempotent per application: an open invoice is reused, never duplicated. */
async function issueInvoiceTx(q: Queryable, applicationId: string, issuedBy: string | null, lang: "ru" | "en") {
  const [a] = await q.query<{ id: string; status: string; user_id: string; offer_id: string; lang: "ru" | "en" }>(
    "select * from membership_applications where id = $1 for update",
    [applicationId],
  );
  if (!a) fail("not_found");
  if (a.status !== "approved") fail("application_not_approved");
  lang = a.lang ?? lang;
  const [open] = await q.query<{ id: string; number: string }>("select id, number from invoices where application_id = $1 and status = 'open'", [a.id]);
  if (open) return open;
  const [applied] = await q.query<Offer>("select * from offers where id = $1", [a.offer_id]);
  const [offer] = await q.query<Offer>("select * from offers where code = $1 and status = 'active'", [applied.code]);
  if (!offer) fail("offer_unavailable");
  if (missingFields(offer).length) fail("offer_incomplete");
  const [seq] = await q.query<{ n: string }>("select nextval('invoice_number_seq')::text as n");
  const number = `MV-INV-${year()}-${seq.n.padStart(5, "0")}`;
  const snapshot = {
    code: offer.code,
    version: offer.version,
    title: offer.title,
    benefits: offer.benefits,
    exclusions: offer.exclusions,
    duration_days: offer.duration_days,
    terms_text: offer.terms_text,
    refund_text: offer.refund_text,
    approval_ref: offer.approval_ref,
  };
  const termsVersion = `offer:${offer.code}@${offer.version}`;
  const [inv] = await q.query<{ id: string; number: string }>(
    `insert into invoices (number, user_id, application_id, offer_id, offer_snapshot, recipient, amount_minor, currency, exponent, tax_treatment, terms_version, issued_by, lang)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id, number`,
    [number, a.user_id, a.id, offer.id, JSON.stringify(snapshot), offer.legal_recipient, offer.price_minor, offer.currency, offer.exponent, offer.tax_treatment, termsVersion, issuedBy, lang],
  );
  await q.query(
    "insert into memberships (user_id, offer_id, application_id, invoice_id, status) values ($1, $2, $3, $4, 'pending')",
    [a.user_id, offer.id, a.id, inv.id],
  );
  await notify(q, [a.user_id], "invoice_issued", { number });
  const [u] = await q.query<{ email: string }>("select email from users where id = $1", [a.user_id]);
  if (u)
    await enqueueMail(q, {
      to: u.email,
      template: "invoice_issued",
      lang,
      userId: a.user_id,
      data: { number, amount: formatMoney(offer.price_minor, offer.currency, lang), recipient: offer.legal_recipient, url: link(`/${lang}/billing/invoices/${number}`) },
    });
  await audit(q, { actorId: issuedBy, action: "invoice.issued", entity: "invoice", entityId: inv.id, data: { number, amount: offer.price_minor, currency: offer.currency, offer: termsVersion } });
  return inv;
}

export async function voidInvoice(db: Database, user: SessionUser, invoiceId: string, reasonInput: unknown) {
  if (!isAdmin(user)) fail("forbidden");
  requireStepUp(user);
  const reason = v.oneLine(reasonInput, 300);
  if (reason.length < 3) fail("invalid_input");
  await db.tx(async (q) => {
    const [inv] = await q.query<{ id: string; status: string }>("select id, status from invoices where id = $1 for update", [invoiceId]);
    if (!inv || inv.status !== "open") fail("not_editable");
    const [active] = await q.query("select 1 from payment_attempts where invoice_id = $1 and status in ('open','processing')", [inv.id]);
    if (active) fail("checkout_in_progress");
    await q.query("update invoices set status = 'void', voided_at = now() where id = $1", [inv.id]);
    await q.query("update payment_attempts set status = 'canceled', updated_at = now() where invoice_id = $1 and status = 'created'", [inv.id]);
    await q.query("update memberships set status = 'ended', status_reason = 'invoice_void', updated_at = now() where invoice_id = $1 and status = 'pending'", [inv.id]);
    await audit(q, { actorId: user.id, action: "invoice.voided", entity: "invoice", entityId: inv.id, data: { reason } });
  });
}

// ---------- Checkout ----------

type InvoiceRow = {
  id: string;
  number: string;
  user_id: string;
  offer_id: string;
  application_id: string | null;
  offer_snapshot: { title: Texts; duration_days: number };
  recipient: string;
  amount_minor: string;
  currency: string;
  exponent: number;
  tax_treatment: string;
  terms_version: string;
  status: string;
  refunded_minor: string;
};

type AttemptRow = {
  id: string;
  invoice_id: string;
  user_id: string;
  provider: string;
  mode: "test" | "live";
  provider_session_id: string | null;
  provider_payment_id: string | null;
  status: string;
  amount_minor: string;
  currency: string;
  idem_key: string;
  expires_at: Date | null;
};

const CHECKOUT_MINUTES = 60;

/**
 * Starts (or resumes) hosted checkout for the participant's own open invoice. Amount, currency, recipient
 * and terms come only from the stored invoice; nothing from the browser is trusted except the invoice id
 * and the explicit terms acceptance. Returns the provider URL (host allow-listed).
 */
export async function startCheckout(db: Database, user: SessionUser, invoiceId: string, acceptInput: unknown, lang: "ru" | "en"): Promise<string> {
  if (!v.bool(acceptInput)) fail("terms_required");
  const [u] = await db.query<{ email_verified_at: Date | null; email: string; status: string }>("select email_verified_at, email, status from users where id = $1", [user.id]);
  if (!u?.email_verified_at) fail("email_not_verified");
  const provider = paymentProvider();
  const [inv] = await db.query<InvoiceRow>("select * from invoices where id = $1", [invoiceId]);
  if (!inv || inv.user_id !== user.id) fail("not_found");
  if (inv.status !== "open") fail("invoice_not_payable");
  const [offer] = await db.query<Offer>("select * from offers where id = $1", [inv.offer_id]);
  const readiness = paymentReadiness(offer);
  if (!readiness.ready || !provider) fail("payments_unavailable");
  const origin = siteOrigin() ?? "https://www.maximus.vegas";

  // Step 1 (committed before calling the provider): one active attempt per invoice.
  const attempt = await db.tx(async (q) => {
    const [locked] = await q.query<InvoiceRow>("select * from invoices where id = $1 for update", [inv.id]);
    if (locked.status !== "open") fail("invoice_not_payable");
    const [active] = await q.query<AttemptRow>(
      "select * from payment_attempts where invoice_id = $1 and status in ('created','open','processing') for update",
      [inv.id],
    );
    if (active) return { row: active, fresh: false };
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from payment_attempts where invoice_id = $1", [inv.id]);
    const id = randomUUID();
    const [row] = await q.query<AttemptRow>(
      `insert into payment_attempts (id, invoice_id, user_id, provider, mode, amount_minor, currency, idem_key, terms_version, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + ($10 || ' minutes')::interval) returning *`,
      [id, inv.id, user.id, provider!.name, provider!.mode, locked.amount_minor, locked.currency, `checkout:${inv.id}:${n.n + 1}`, locked.terms_version, String(CHECKOUT_MINUTES)],
    );
    await q.query("insert into consents (user_id, kind, version, granted, source) values ($1, 'membership_terms', $2, true, 'checkout')", [user.id, locked.terms_version]);
    await audit(q, { actorId: user.id, action: "payment.attempt_created", entity: "invoice", entityId: inv.id, data: { attemptId: id, amount: locked.amount_minor, currency: locked.currency, terms: locked.terms_version } });
    return { row, fresh: true };
  });

  if (attempt.row.status === "processing") fail("checkout_in_progress");
  if (!attempt.fresh && attempt.row.provider_session_id) {
    // Resume the same hosted session instead of creating a second one; the provider decides its state.
    const state = await provider!.retrieveSession(attempt.row.provider_session_id);
    const result = await applySessionState(db, attempt.row, state, "resume");
    if (result === "open" && state.url && provider!.checkoutHosts.includes(new URL(state.url).host)) return state.url;
    if (result === "succeeded") fail("invoice_not_payable");
    if (result === "processing") fail("checkout_in_progress");
    if (result === "open") {
      await setAttemptStatus(db, attempt.row.id, "canceled", ["open"]);
    }
    return startCheckout(db, user, invoiceId, acceptInput, lang);
  }

  // Step 2: create the hosted session with the attempt id as the provider idempotency key.
  let session;
  try {
    session = await provider!.createCheckout({
      attemptId: attempt.row.id,
      invoiceId: inv.id,
      invoiceNumber: inv.number,
      amountMinor: Number(attempt.row.amount_minor),
      currency: attempt.row.currency,
      description: `${inv.offer_snapshot.title[lang]} (${inv.offer_snapshot.duration_days} d)`,
      customerEmail: u!.email,
      successUrl: `${origin}/${lang}/billing/return?attempt=${attempt.row.id}`,
      cancelUrl: `${origin}/${lang}/billing/invoices/${inv.number}?canceled=1`,
      expiresAt: new Date(Date.now() + CHECKOUT_MINUTES * 60_000),
      locale: lang,
      idempotencyKey: attempt.row.idem_key,
      metadata: { invoice_id: inv.id, attempt_id: attempt.row.id, invoice_number: inv.number, terms: inv.terms_version },
    });
  } catch (error) {
    await db.query("update payment_attempts set status = 'failed', updated_at = now() where id = $1 and status = 'created'", [attempt.row.id]);
    console.error("[checkout] provider error:", (error as Error).message);
    fail("provider_error");
  }
  const host = new URL(session!.url).host;
  if (!provider!.checkoutHosts.includes(host)) {
    await db.query("update payment_attempts set status = 'failed', updated_at = now() where id = $1", [attempt.row.id]);
    fail("provider_error");
  }
  await db.query(
    "update payment_attempts set provider_session_id = $2, status = 'open', expires_at = coalesce($3, expires_at), updated_at = now() where id = $1 and status = 'created'",
    [attempt.row.id, session!.id, session!.expiresAt?.toISOString() ?? null],
  );
  return session!.url;
}

// ---------- Applying provider state ----------

type Source = "webhook" | "return" | "resume" | "sweep" | "admin";

/**
 * Applies the provider's authoritative session state to an attempt. Checks that the session belongs to
 * this attempt and invoice and that amount and currency match before anything is marked paid.
 */
export async function applySessionState(db: Database, attempt: AttemptRow, state: SessionState, source: Source, eventType?: string) {
  const mismatch =
    state.metadata.attempt_id !== attempt.id ||
    state.clientReferenceId !== attempt.invoice_id ||
    (state.amountTotal !== null && state.amountTotal !== Number(attempt.amount_minor)) ||
    (state.currency !== null && state.currency.toUpperCase() !== attempt.currency.toUpperCase()) ||
    state.livemode !== (attempt.mode === "live");
  if (mismatch) {
    await db.tx(async (q) => {
      await q.query("update payment_attempts set status = 'failed', updated_at = now() where id = $1 and status in ('created','open','processing')", [attempt.id]);
      await audit(q, { actorId: null, action: "payment.state_mismatch", entity: "invoice", entityId: attempt.invoice_id, data: { attemptId: attempt.id, source } });
    });
    return "mismatch" as const;
  }
  if (state.paymentStatus === "paid" && state.status === "complete") {
    await markSucceeded(db, attempt.id, state.paymentIntentId, source);
    return "succeeded" as const;
  }
  if (eventType === "checkout.session.async_payment_failed") {
    await setAttemptStatus(db, attempt.id, "failed", ["created", "open", "processing"]);
    return "failed" as const;
  }
  if (state.status === "complete") {
    await setAttemptStatus(db, attempt.id, "processing", ["created", "open"]);
    return "processing" as const;
  }
  if (state.status === "expired") {
    await setAttemptStatus(db, attempt.id, "expired", ["created", "open"]);
    return "expired" as const;
  }
  return "open" as const;
}

async function setAttemptStatus(db: Database, id: string, status: string, from: string[]) {
  await db.tx(async (q) => {
    const rows = await q.query("update payment_attempts set status = $2, updated_at = now() where id = $1 and status = any($3) returning invoice_id", [id, status, from]);
    if (rows.length) await audit(q, { actorId: null, action: `payment.${status}`, entity: "payment_attempt", entityId: id });
  });
}

async function markSucceeded(db: Database, attemptId: string, paymentIntentId: string | null, source: Source) {
  await db.tx(async (q) => {
    const [a] = await q.query<AttemptRow>("select * from payment_attempts where id = $1 for update", [attemptId]);
    const [inv] = await q.query<InvoiceRow & { offer_snapshot: { duration_days: number; title: Texts }; lang: "ru" | "en" }>("select * from invoices where id = $1 for update", [a.invoice_id]);
    if (a.status === "succeeded") return;
    await q.query("update payment_attempts set status = 'succeeded', provider_payment_id = coalesce($2, provider_payment_id), updated_at = now() where id = $1", [a.id, paymentIntentId]);
    await q.query(
      `insert into ledger_entries (invoice_id, payment_attempt_id, kind, amount_minor, currency, provider_ref) values ($1, $2, 'charge', $3, $4, $5)
       on conflict (kind, provider_ref) do nothing`,
      [inv.id, a.id, a.amount_minor, a.currency, paymentIntentId ?? `session:${a.provider_session_id}`],
    );
    if (inv.status !== "open") {
      // Paid after void, or a second success: recorded for reconciliation, never turned into benefits.
      await audit(q, { actorId: null, action: "payment.requires_review", entity: "invoice", entityId: inv.id, data: { attemptId: a.id, invoiceStatus: inv.status, source } });
      return;
    }
    await q.query("update invoices set status = 'paid', paid_at = now() where id = $1", [inv.id]);
    await audit(q, { actorId: null, action: "payment.succeeded", entity: "invoice", entityId: inv.id, data: { attemptId: a.id, source, amount: a.amount_minor, currency: a.currency } });
    await activateMembership(q, inv.id);
    await notify(q, [inv.user_id], "payment_received", { number: inv.number });
    const [u] = await q.query<{ email: string }>("select email from users where id = $1", [inv.user_id]);
    if (u)
      await enqueueMail(q, {
        to: u.email,
        template: "payment_received",
        lang: inv.lang,
        userId: inv.user_id,
        dedupeKey: `payment_received:${inv.id}`,
        data: { number: inv.number, amount: formatMoney(inv.amount_minor, inv.currency, inv.lang), url: link(`/${inv.lang}/billing/invoices/${inv.number}`) },
      });
  });
}

/**
 * Activation follows the membership policy: only for a paid invoice whose application is approved,
 * starting at the verified payment and running for the offer's term.
 */
async function activateMembership(q: Queryable, invoiceId: string) {
  const [m] = await q.query<{ id: string; status: string; user_id: string; application_id: string | null }>(
    "select * from memberships where invoice_id = $1 for update",
    [invoiceId],
  );
  if (!m || m.status !== "pending") return;
  const [inv] = await q.query<{ status: string; offer_snapshot: { duration_days: number }; lang: "ru" | "en" }>("select status, offer_snapshot, lang from invoices where id = $1", [invoiceId]);
  if (inv.status !== "paid") return;
  if (m.application_id) {
    const [a] = await q.query<{ status: string }>("select status from membership_applications where id = $1", [m.application_id]);
    if (a?.status !== "approved") return;
  }
  const [row] = await q.query<{ ends_at: Date }>(
    "update memberships set status = 'active', starts_at = now(), ends_at = now() + ($2 || ' days')::interval, updated_at = now() where id = $1 returning ends_at",
    [m.id, String(inv.offer_snapshot.duration_days)],
  );
  await audit(q, { actorId: null, action: "membership.activated", entity: "membership", entityId: m.id, data: { invoiceId, endsAt: row.ends_at } });
  const [u] = await q.query<{ email: string }>("select email from users where id = $1", [m.user_id]);
  if (u) await enqueueMail(q, { to: u.email, template: "membership_active", lang: inv.lang, userId: m.user_id, dedupeKey: `membership_active:${m.id}`, data: { until: new Date(row.ends_at).toISOString().slice(0, 10), url: link(`/${inv.lang}/billing`) } });
}

// ---------- Webhooks ----------

export type WebhookResult = { status: number; body: string };

/** Verifies, records and processes one provider event. Duplicates are acknowledged without re-processing. */
export async function handleProviderWebhook(db: Database, rawBody: string, signature: string | null): Promise<WebhookResult> {
  const provider = paymentProvider();
  if (!provider) return { status: 503, body: "payments not configured" };
  let event: ProviderEvent;
  try {
    event = provider.verifyWebhook(rawBody, signature);
  } catch (error) {
    if (error instanceof WebhookSignatureError) return { status: 400, body: "invalid signature" };
    throw error;
  }
  const inserted = await db.query(
    `insert into provider_events (id, provider, type, livemode, status, payload_sha256, provider_created_at) values ($1, $2, $3, $4, 'received', $5, $6)
     on conflict (id) do nothing returning id`,
    [event.id, provider.name, event.type, event.livemode, event.payloadSha256, event.created.toISOString()],
  );
  if (!inserted.length) {
    const [prev] = await db.query<{ status: string }>("select status from provider_events where id = $1", [event.id]);
    if (prev && prev.status !== "failed" && prev.status !== "received") return { status: 200, body: "duplicate" };
  }
  if (event.livemode !== (provider.mode === "live")) {
    await markEvent(db, event.id, "ignored", "mode_mismatch");
    return { status: 200, body: "ignored" };
  }
  try {
    const outcome = await dispatch(db, provider, event);
    await markEvent(db, event.id, outcome.status, outcome.note, outcome.invoiceId);
    return { status: 200, body: outcome.status };
  } catch (error) {
    await markEvent(db, event.id, "failed", String((error as Error).message).slice(0, 300));
    return { status: 500, body: "processing failed" };
  }
}

async function markEvent(db: Database, id: string, status: string, note = "", invoiceId: string | null = null) {
  await db.query("update provider_events set status = $2, error = $3, invoice_id = coalesce($4, invoice_id), processed_at = now() where id = $1", [id, status, note, invoiceId]);
}

type Outcome = { status: "processed" | "ignored"; note?: string; invoiceId?: string | null };

async function attemptBySession(db: Database, sessionId: string) {
  const [a] = await db.query<AttemptRow>("select * from payment_attempts where provider_session_id = $1", [sessionId]);
  return a ?? null;
}

async function attemptByPayment(db: Database, provider: PaymentProvider, paymentIntentId: string | null) {
  if (!paymentIntentId) return null;
  const [a] = await db.query<AttemptRow>("select * from payment_attempts where provider_payment_id = $1", [paymentIntentId]);
  if (a) return a;
  // Out of order: the charge event arrived before the success. Link through the provider's metadata.
  const pi = await provider.retrievePaymentIntent(paymentIntentId);
  if (!pi.metadata.attempt_id) return null;
  const [byMeta] = await db.query<AttemptRow>("select * from payment_attempts where id = $1", [pi.metadata.attempt_id]);
  if (!byMeta || byMeta.invoice_id !== pi.metadata.invoice_id) return null;
  if (byMeta.status !== "succeeded" && byMeta.provider_session_id) {
    const state = await provider.retrieveSession(byMeta.provider_session_id);
    await applySessionState(db, byMeta, state, "webhook");
  }
  const [fresh] = await db.query<AttemptRow>("select * from payment_attempts where id = $1", [byMeta.id]);
  return fresh;
}

const str = (x: unknown) => (typeof x === "string" ? x : x && typeof x === "object" && "id" in x ? String((x as { id: unknown }).id) : null);

async function dispatch(db: Database, provider: PaymentProvider, event: ProviderEvent): Promise<Outcome> {
  const o = event.object;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired": {
      const sessionId = str(o.id);
      const attempt = sessionId ? await attemptBySession(db, sessionId) : null;
      if (!attempt) return { status: "ignored", note: "unknown_session" };
      // Never act on the event body alone: re-read the authoritative session.
      const state = await provider.retrieveSession(sessionId!);
      const result = await applySessionState(db, attempt, state, "webhook", event.type);
      return { status: "processed", note: result, invoiceId: attempt.invoice_id };
    }
    case "charge.refunded": {
      const attempt = await attemptByPayment(db, provider, str(o.payment_intent));
      if (!attempt) return { status: "ignored", note: "unknown_payment" };
      await applyRefund(db, attempt, str(o.id)!, Number(o.amount_refunded ?? 0));
      return { status: "processed", invoiceId: attempt.invoice_id };
    }
    case "charge.dispute.created":
    case "charge.dispute.closed": {
      const attempt = await attemptByPayment(db, provider, str(o.payment_intent));
      if (!attempt) return { status: "ignored", note: "unknown_payment" };
      await applyDispute(db, attempt, str(o.id)!, Number(o.amount ?? 0), event.type === "charge.dispute.created" ? "created" : String(o.status ?? ""));
      return { status: "processed", invoiceId: attempt.invoice_id };
    }
    default:
      return { status: "ignored", note: "unhandled_type" };
  }
}

/** Refund totals only grow; applying the same or an older total again changes nothing. */
async function applyRefund(db: Database, attempt: AttemptRow, chargeId: string, refundedTotal: number) {
  await db.tx(async (q) => {
    const [inv] = await q.query<InvoiceRow>("select * from invoices where id = $1 for update", [attempt.invoice_id]);
    const already = Number(inv.refunded_minor);
    if (refundedTotal <= already) return;
    await q.query(
      `insert into ledger_entries (invoice_id, payment_attempt_id, kind, amount_minor, currency, provider_ref) values ($1, $2, 'refund', $3, $4, $5)
       on conflict (kind, provider_ref) do nothing`,
      [inv.id, attempt.id, -(refundedTotal - already), attempt.currency, `${chargeId}:${refundedTotal}`],
    );
    const full = refundedTotal >= Number(inv.amount_minor);
    await q.query("update invoices set refunded_minor = $2, status = case when status = 'disputed' then status else $3 end where id = $1", [
      inv.id,
      refundedTotal,
      full ? "refunded" : "partially_refunded",
    ]);
    if (full)
      await q.query(
        "update memberships set status = 'ended', status_reason = 'refunded', ends_at = least(coalesce(ends_at, now()), now()), updated_at = now() where invoice_id = $1 and status in ('pending','active','suspended')",
        [inv.id],
      );
    await audit(q, { actorId: null, action: full ? "payment.refunded" : "payment.partially_refunded", entity: "invoice", entityId: inv.id, data: { refundedTotal } });
  });
}

async function applyDispute(db: Database, attempt: AttemptRow, disputeId: string, amount: number, state: string) {
  await db.tx(async (q) => {
    const [inv] = await q.query<InvoiceRow>("select * from invoices where id = $1 for update", [attempt.invoice_id]);
    if (state === "created" || state === "needs_response" || state === "warning_needs_response") {
      const rows = await q.query(
        `insert into ledger_entries (invoice_id, payment_attempt_id, kind, amount_minor, currency, provider_ref) values ($1, $2, 'dispute', $3, $4, $5)
         on conflict (kind, provider_ref) do nothing returning id`,
        [inv.id, attempt.id, -amount, attempt.currency, disputeId],
      );
      if (!rows.length) return;
      const [reversed] = await q.query("select 1 from ledger_entries where kind = 'dispute_reversal' and provider_ref = $1", [disputeId]);
      if (reversed) return;
      await q.query("update invoices set status = 'disputed' where id = $1 and status in ('paid','partially_refunded')", [inv.id]);
      await q.query("update memberships set status = 'suspended', status_reason = 'payment_disputed', updated_at = now() where invoice_id = $1 and status = 'active'", [inv.id]);
      await audit(q, { actorId: null, action: "payment.disputed", entity: "invoice", entityId: inv.id, data: { disputeId } });
      return;
    }
    if (state === "won") {
      const rows = await q.query(
        `insert into ledger_entries (invoice_id, payment_attempt_id, kind, amount_minor, currency, provider_ref) values ($1, $2, 'dispute_reversal', $3, $4, $5)
         on conflict (kind, provider_ref) do nothing returning id`,
        [inv.id, attempt.id, amount, attempt.currency, disputeId],
      );
      if (!rows.length) return;
      await q.query(
        "update invoices set status = case when refunded_minor >= amount_minor then 'refunded' when refunded_minor > 0 then 'partially_refunded' else 'paid' end where id = $1 and status = 'disputed'",
        [inv.id],
      );
      await q.query(
        "update memberships set status = 'active', status_reason = '', updated_at = now() where invoice_id = $1 and status = 'suspended' and status_reason = 'payment_disputed' and ends_at > now()",
        [inv.id],
      );
      await audit(q, { actorId: null, action: "payment.dispute_won", entity: "invoice", entityId: inv.id, data: { disputeId } });
      return;
    }
    if (state === "lost") {
      await q.query("update invoices set status = 'disputed' where id = $1", [inv.id]);
      await q.query(
        "update memberships set status = 'ended', status_reason = 'dispute_lost', ends_at = least(coalesce(ends_at, now()), now()), updated_at = now() where invoice_id = $1 and status in ('active','suspended')",
        [inv.id],
      );
      await audit(q, { actorId: null, action: "payment.dispute_lost", entity: "invoice", entityId: inv.id, data: { disputeId } });
    }
  });
}

// ---------- Reconciliation and refunds ----------

/** Server-side verification used by the return page, the sweep and staff: never trusts the redirect. */
export async function reconcileAttempt(db: Database, attemptId: string, source: Source) {
  const provider = paymentProvider();
  const [a] = await db.query<AttemptRow>("select * from payment_attempts where id = $1", [attemptId]);
  if (!a || !provider || !a.provider_session_id) return a?.status ?? null;
  if (!["open", "processing"].includes(a.status)) return a.status;
  const state = await provider.retrieveSession(a.provider_session_id);
  await applySessionState(db, a, state, source);
  const [fresh] = await db.query<{ status: string }>("select status from payment_attempts where id = $1", [a.id]);
  return fresh.status;
}

export async function sweepPayments(db: Database) {
  const due = await db.query<{ id: string }>(
    "select id from payment_attempts where status in ('open','processing') and updated_at < now() - interval '10 minutes' order by updated_at asc limit 20",
  );
  for (const a of due) await reconcileAttempt(db, a.id, "sweep").catch((e) => console.error("[sweep]", (e as Error).message));
  await db.query("update memberships set status = 'expired', updated_at = now() where status = 'active' and ends_at < now()");
}

export async function refundInvoice(db: Database, user: SessionUser, invoiceId: string, amountInput: unknown) {
  if (!isAdmin(user)) fail("forbidden");
  requireStepUp(user);
  if (process.env.PAYMENTS_ALLOW_REFUNDS !== "1") fail("refunds_disabled");
  const provider = paymentProvider();
  if (!provider) fail("payments_unavailable");
  const [inv] = await db.query<InvoiceRow>("select * from invoices where id = $1", [invoiceId]);
  if (!inv || !["paid", "partially_refunded"].includes(inv.status)) fail("not_editable");
  const [a] = await db.query<AttemptRow>("select * from payment_attempts where invoice_id = $1 and status = 'succeeded' limit 1", [inv.id]);
  if (!a?.provider_payment_id) fail("not_editable");
  const remaining = Number(inv.amount_minor) - Number(inv.refunded_minor);
  const amount = String(amountInput ?? "").trim() ? toMinor(amountInput, inv.currency) : remaining;
  if (amount <= 0 || amount > remaining) fail("invalid_input");
  const refund = await provider!.refund(a!.provider_payment_id!, amount, `refund:${inv.id}:${inv.refunded_minor}:${amount}`);
  await db.tx(async (q) => {
    await audit(q, { actorId: user.id, action: "payment.refund_requested", entity: "invoice", entityId: inv.id, data: { amount, refundId: refund.id } });
  });
  // Balances change when the provider confirms the refund (charge.refunded webhook).
}

// ---------- Membership administration ----------

export async function setMembershipState(db: Database, user: SessionUser, membershipId: string, input: { status?: unknown; endsAt?: unknown; reason: unknown }) {
  if (!isAdmin(user)) fail("forbidden");
  requireStepUp(user);
  const reason = v.oneLine(input.reason, 300);
  if (reason.length < 3) fail("invalid_input");
  await db.tx(async (q) => {
    const [m] = await q.query<{ id: string; status: string; ends_at: Date | null }>("select * from memberships where id = $1 for update", [membershipId]);
    if (!m) fail("not_found");
    const status = input.status ? String(input.status) : m.status;
    if (!["active", "suspended", "ended"].includes(status)) fail("invalid_input");
    if (status === "active" && m.status === "pending") fail("invalid_transition");
    const endsAt = String(input.endsAt ?? "").trim() ? new Date(`${String(input.endsAt)}T23:59:59Z`) : null;
    if (endsAt && Number.isNaN(endsAt.getTime())) fail("invalid_date");
    await q.query("update memberships set status = $2, ends_at = coalesce($3, ends_at), status_reason = $4, updated_at = now() where id = $1", [
      m.id,
      status,
      endsAt?.toISOString() ?? null,
      reason,
    ]);
    await audit(q, { actorId: user.id, action: "membership.changed", entity: "membership", entityId: m.id, data: { from: m.status, to: status, endsAt, reason } });
  });
}

// ---------- Reads ----------

export async function billingFor(q: Queryable, userId: string) {
  const applications = await q.query<{ id: string; reference: string; status: string; objective: string; decision_note: string; created_at: Date; updated_at: Date; title: Texts }>(
    `select a.id, a.reference, a.status, a.objective, a.decision_note, a.created_at, a.updated_at, o.title
       from membership_applications a join offers o on o.id = a.offer_id where a.user_id = $1 order by a.created_at desc`,
    [userId],
  );
  const invoices = await q.query<InvoiceRow & { created_at: Date; paid_at: Date | null }>(
    "select * from invoices where user_id = $1 order by created_at desc",
    [userId],
  );
  const memberships = await q.query<{ id: string; status: string; starts_at: Date | null; ends_at: Date | null; status_reason: string; title: Texts }>(
    `select m.id, m.status, m.starts_at, m.ends_at, m.status_reason, o.title from memberships m join offers o on o.id = m.offer_id
      where m.user_id = $1 order by m.created_at desc`,
    [userId],
  );
  return { applications, invoices, memberships };
}

export async function invoiceByNumber(q: Queryable, number: string) {
  const [inv] = await q.query<InvoiceRow & { created_at: Date; paid_at: Date | null; offer_snapshot: Record<string, unknown> }>("select * from invoices where number = $1", [number]);
  if (!inv) return null;
  const attempts = await q.query<AttemptRow & { created_at: Date; updated_at: Date }>("select * from payment_attempts where invoice_id = $1 order by created_at desc", [inv.id]);
  const ledger = await q.query<{ kind: string; amount_minor: string; currency: string; provider_ref: string; created_at: Date }>(
    "select kind, amount_minor, currency, provider_ref, created_at from ledger_entries where invoice_id = $1 order by id",
    [inv.id],
  );
  return { invoice: inv, attempts, ledger };
}

export async function attemptForUser(q: Queryable, attemptId: string, userId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) return null;
  const [a] = await q.query<AttemptRow & { number: string }>(
    "select a.*, i.number from payment_attempts a join invoices i on i.id = a.invoice_id where a.id = $1 and a.user_id = $2",
    [attemptId, userId],
  );
  return a ?? null;
}

export async function adminBilling(q: Queryable) {
  const applications = await q.query<{ id: string; reference: string; status: string; objective: string; username: string; email: string; created_at: Date; code: string; version: number; decision_note: string }>(
    `select a.id, a.reference, a.status, a.objective, u.username, u.email, a.created_at, o.code, o.version, a.decision_note
       from membership_applications a join users u on u.id = a.user_id join offers o on o.id = a.offer_id
      order by case a.status when 'submitted' then 0 when 'under_review' then 1 when 'awaiting_info' then 2 when 'approved' then 3 else 4 end, a.created_at desc limit 200`,
  );
  const invoices = await q.query<{ id: string; number: string; status: string; amount_minor: string; currency: string; username: string; created_at: Date; paid_at: Date | null; refunded_minor: string }>(
    `select i.id, i.number, i.status, i.amount_minor, i.currency, u.username, i.created_at, i.paid_at, i.refunded_minor
       from invoices i join users u on u.id = i.user_id order by i.created_at desc limit 200`,
  );
  const events = await q.query<{ id: string; type: string; status: string; error: string; livemode: boolean; received_at: Date }>(
    "select id, type, status, error, livemode, received_at from provider_events order by received_at desc limit 100",
  );
  const memberships = await q.query<{ id: string; status: string; username: string; starts_at: Date | null; ends_at: Date | null; status_reason: string }>(
    `select m.id, m.status, u.username, m.starts_at, m.ends_at, m.status_reason from memberships m join users u on u.id = m.user_id
      order by m.created_at desc limit 200`,
  );
  return { applications, invoices, events, memberships };
}

export const mailReady = mailConfigured;
