/**
 * Billing flow tests against embedded PostgreSQL with a MOCK payment provider (no network, no real
 * charges). They prove the portal's state machine: admission, invoices, idempotent checkout, verified
 * webhooks, tampering, delayed payments, refunds, disputes and out-of-order events. They are not a
 * provider sandbox integration test; see tests/stripe.test.ts for the real Stripe SDK signature checks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { openDatabase, type Database } from "../src/server/db.ts";
import { deleteAccount, exportAccount, signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import {
  applyForMembership,
  approveOffer,
  attemptForUser,
  createOfferVersion,
  decideApplication,
  handleProviderWebhook,
  issueInvoice,
  paymentReadiness,
  publicOffer,
  reconcileAttempt,
  setPaymentProviderForTests,
  startCheckout,
  voidInvoice,
} from "../src/server/billing.ts";
import { hasActiveMembership } from "../src/server/progression.ts";
import { WebhookSignatureError, type PaymentProvider, type SessionState } from "../src/server/payments/provider.ts";
import { DomainError } from "../src/server/errors.ts";
import { verifyAuditChain } from "../src/server/audit.ts";

const SECRET = "mock_webhook_secret";

class MockProvider implements PaymentProvider {
  readonly name = "mock";
  readonly mode = "test" as const;
  readonly checkoutHosts = ["checkout.mock.test"];
  sessions = new Map<string, SessionState>();
  byKey = new Map<string, string>();
  intents = new Map<string, Record<string, string>>();
  created = 0;
  async createCheckout(req: Parameters<PaymentProvider["createCheckout"]>[0]) {
    const existing = this.byKey.get(req.idempotencyKey);
    if (existing) return { id: existing, url: `https://checkout.mock.test/${existing}`, expiresAt: req.expiresAt };
    const id = `cs_test_${++this.created}`;
    this.byKey.set(req.idempotencyKey, id);
    this.sessions.set(id, {
      id,
      url: `https://checkout.mock.test/${id}`,
      status: "open",
      paymentStatus: "unpaid",
      amountTotal: req.amountMinor,
      currency: req.currency,
      paymentIntentId: null,
      clientReferenceId: req.invoiceId,
      metadata: req.metadata,
      livemode: false,
    });
    return { id, url: `https://checkout.mock.test/${id}`, expiresAt: req.expiresAt };
  }
  async retrieveSession(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error("no such session");
    return { ...s, url: s.status === "open" ? s.url : null };
  }
  async retrievePaymentIntent(id: string) {
    return { id, metadata: this.intents.get(id) ?? {}, amount: 0, currency: "AED", status: "succeeded", livemode: false };
  }
  verifyWebhook(raw: string, signature: string | null) {
    const expected = createHmac("sha256", SECRET).update(raw).digest("hex");
    if (signature !== expected) throw new WebhookSignatureError();
    const e = JSON.parse(raw);
    return { id: e.id, type: e.type, livemode: e.livemode, created: new Date(), object: e.data.object, payloadSha256: "x" };
  }
  refunds: string[] = [];
  async refund(_pi: string, _amount: number, key: string) {
    this.refunds.push(key);
    return { id: `re_${this.refunds.length}` };
  }
  pay(id: string, delayed = false) {
    const s = this.sessions.get(id)!;
    const pi = `pi_${id}`;
    this.intents.set(pi, s.metadata);
    this.sessions.set(id, { ...s, status: "complete", paymentStatus: delayed ? "unpaid" : "paid", paymentIntentId: pi });
    return pi;
  }
  settle(id: string) {
    const s = this.sessions.get(id)!;
    this.sessions.set(id, { ...s, paymentStatus: "paid" });
  }
  expire(id: string) {
    const s = this.sessions.get(id)!;
    this.sessions.set(id, { ...s, status: "expired" });
  }
}

let db: Database;
let provider: MockProvider;
let admin: SessionUser;
let eventSeq = 0;

const fresh = (u: SessionUser): SessionUser => ({ ...u, mfaAt: new Date() });
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}

async function mk(name: string, verified = true): Promise<SessionUser> {
  const s = await signUp(db, { email: `${name}@example.com`, username: name, displayName: name, password: "correct horse battery", adult: "on", terms: "on" });
  if (verified) await db.query("update users set email_verified_at = now() where username = $1", [name]);
  return (await sessionUser(db, s.token))!;
}

function send(type: string, object: Record<string, unknown>, opts: { livemode?: boolean; id?: string; badSignature?: boolean } = {}) {
  const raw = JSON.stringify({ id: opts.id ?? `evt_${++eventSeq}`, type, livemode: opts.livemode ?? false, data: { object } });
  const sig = opts.badSignature ? "deadbeef" : createHmac("sha256", SECRET).update(raw).digest("hex");
  return handleProviderWebhook(db, raw, sig);
}

const ENV = {
  PAYMENTS_ENABLED: "1",
  PAYMENTS_MODE: "test",
  MERCHANT_VERIFIED: "1",
  MERCHANT_LEGAL_NAME: "MAXIMUS VEGAS L.L.C-FZ",
};

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  admin = await mk("billingadmin");
  await db.query("insert into user_roles (user_id, role) values ($1, 'admin')", [admin.id]);
  admin = fresh({ ...admin, roles: ["admin"] });
});
test.after(async () => {
  setPaymentProviderForTests(null);
  await db.close();
});

test("readiness: collection is disabled until the offer and the verified merchant configuration are valid", async () => {
  setPaymentProviderForTests(null);
  for (const k of Object.keys(ENV)) delete process.env[k];
  const seeded = await publicOffer(db);
  assert.equal(seeded?.status, "proposed");
  assert.equal(seeded?.price_minor, null, "no invented price is seeded");
  const r = paymentReadiness(seeded);
  assert.equal(r.ready, false);
  for (const reason of ["payments_disabled", "provider_not_configured", "merchant_not_verified", "offer_not_active", "offer_incomplete"]) assert.ok(r.reasons.includes(reason), reason);
  Object.assign(process.env, ENV, { MERCHANT_LEGAL_NAME: "MAXIMUS SPORTS" });
  provider = new MockProvider();
  setPaymentProviderForTests(provider);
  assert.ok(paymentReadiness(seeded).reasons.includes("recipient_mismatch"), "fees never route to another entity");
  process.env.MERCHANT_LEGAL_NAME = ENV.MERCHANT_LEGAL_NAME;
});

let offerId: string;

test("offers: versions are proposed first; approval needs every commercial field, a reference and a fresh second factor", async () => {
  const input = {
    code: "vegas-membership", kind: "membership", titleRu: "Членство", titleEn: "Membership",
    benefitsRu: "Премиальная линия", benefitsEn: "Premium track", exclusionsRu: "", exclusionsEn: "",
    price: "99.00", currency: "AED", taxTreatment: "Test tax treatment", durationDays: "30", admission: "review",
    termsRu: "Условия теста", termsEn: "Test terms", refundRu: "Возврат теста", refundEn: "Test refund",
  };
  await rejects(createOfferVersion(db, { ...admin, mfaAt: null }, input), "step_up_required");
  const incomplete = await createOfferVersion(db, admin, { ...input, price: "" });
  await rejects(approveOffer(db, admin, incomplete, "Board minute 1"), "offer_incomplete");
  offerId = await createOfferVersion(db, admin, input);
  await rejects(approveOffer(db, admin, offerId, ""), "invalid_input");
  await approveOffer(db, admin, offerId, "Owner approval (test)");
  const active = await publicOffer(db);
  assert.equal(active?.status, "active");
  assert.equal(Number(active?.price_minor), 9900);
  assert.equal(paymentReadiness(active).ready, true);
});

let member: SessionUser;
let invoiceId: string;
let invoiceNumber: string;

test("admission: registration and payment are separate; approval is recorded before any invoice", async () => {
  member = await mk("member1");
  const app = await applyForMembership(db, member, { objective: "Premium pass" }, "en");
  assert.match(app.reference, /^MV-M-\d{4}-\d{5}$/);
  await rejects(applyForMembership(db, member, {}, "en"), "application_exists");
  await rejects(issueInvoice(db, admin, app.id, "en"), "application_not_approved");
  const [open] = await db.query("select 1 from invoices where user_id = $1", [member.id]);
  assert.equal(open, undefined, "no invoice before approval");
  await rejects(decideApplication(db, { ...admin, mfaAt: null }, app.id, "approved", "ok", "en"), "step_up_required");
  await decideApplication(db, admin, app.id, "under_review", "", "en");
  await decideApplication(db, admin, app.id, "approved", "Meets the membership policy", "en");
  const inv = await issueInvoice(db, admin, app.id, "en");
  const again = await issueInvoice(db, admin, app.id, "en");
  assert.equal(inv.id, again.id, "issuing twice reuses the open invoice");
  invoiceId = inv.id;
  invoiceNumber = inv.number;
  const [m] = await db.query<{ status: string }>("select status from memberships where invoice_id = $1", [inv.id]);
  assert.equal(m.status, "pending", "an invoice alone never activates membership");
  assert.equal(await hasActiveMembership(db, member.id), false);
});

test("checkout: own invoice only, verified email, explicit terms; concurrent starts create one attempt", async () => {
  const stranger = await mk("stranger1");
  await rejects(startCheckout(db, stranger, invoiceId, "on", "en"), "not_found");
  const unverified = await mk("unverified1", false);
  await rejects(startCheckout(db, unverified, invoiceId, "on", "en"), "email_not_verified");
  await rejects(startCheckout(db, member, invoiceId, "", "en"), "terms_required");
  const urls = await Promise.all(Array.from({ length: 5 }, () => startCheckout(db, member, invoiceId, "on", "en").catch((e) => (e as DomainError).code)));
  const ok = urls.filter((u) => u.startsWith("https://"));
  assert.ok(ok.length >= 1);
  assert.equal(new Set(ok).size, 1, "all successful starts share one hosted session");
  const [n] = await db.query<{ n: number }>("select count(*)::int as n from payment_attempts where invoice_id = $1 and status in ('created','open','processing')", [invoiceId]);
  assert.equal(n.n, 1, "one active attempt");
  assert.equal(provider.created, 1, "one provider session");
  const [c] = await db.query<{ version: string }>("select version from consents where user_id = $1 and kind = 'membership_terms'", [member.id]);
  assert.match(c.version, /^offer:vegas-membership@\d+$/, "accepted offer version recorded");
});

test("return from checkout never marks an invoice paid; only verified provider state does", async () => {
  const [a] = await db.query<{ id: string; provider_session_id: string }>("select id, provider_session_id from payment_attempts where invoice_id = $1", [invoiceId]);
  assert.equal(await reconcileAttempt(db, a.id, "return"), "open");
  let [inv] = await db.query<{ status: string }>("select status from invoices where id = $1", [invoiceId]);
  assert.equal(inv.status, "open");
  assert.equal(await attemptForUser(db, a.id, (await mk("peeker1")).id), null, "another user cannot read the attempt");
  // Invalid signature is refused before anything is recorded.
  const bad = await send("checkout.session.completed", { id: a.provider_session_id }, { badSignature: true });
  assert.equal(bad.status, 400);
  const pi = provider.pay(a.provider_session_id);
  const r1 = await send("checkout.session.completed", { id: a.provider_session_id }, { id: "evt_paid_1" });
  assert.equal(r1.status, 200);
  const r2 = await send("checkout.session.completed", { id: a.provider_session_id }, { id: "evt_paid_1" });
  assert.equal(r2.body, "duplicate");
  [inv] = await db.query<{ status: string }>("select status from invoices where id = $1", [invoiceId]);
  assert.equal(inv.status, "paid");
  const ledger = await db.query("select * from ledger_entries where invoice_id = $1 and kind = 'charge'", [invoiceId]);
  assert.equal(ledger.length, 1, "one ledger entry despite duplicates");
  const [m] = await db.query<{ status: string; ends_at: Date }>("select status, ends_at from memberships where invoice_id = $1", [invoiceId]);
  assert.equal(m.status, "active");
  assert.ok(new Date(m.ends_at).getTime() > Date.now() + 29 * 86400_000);
  assert.equal(await hasActiveMembership(db, member.id), true);
  assert.ok(pi);
  await rejects(startCheckout(db, member, invoiceId, "on", "en"), "invoice_not_payable");
});

async function paidInvoiceFor(name: string) {
  const u = await mk(name);
  const app = await applyForMembership(db, u, {}, "en");
  await decideApplication(db, admin, app.id, "approved", "Policy met", "en");
  const inv = await issueInvoice(db, admin, app.id, "en");
  await startCheckout(db, u, inv.id, "on", "en");
  const [a] = await db.query<{ id: string; provider_session_id: string }>("select id, provider_session_id from payment_attempts where invoice_id = $1", [inv.id]);
  return { u, inv, a };
}

test("tampered amount or foreign session is never accepted", async () => {
  const { inv, a } = await paidInvoiceFor("tamper1");
  provider.pay(a.provider_session_id);
  const s = provider.sessions.get(a.provider_session_id)!;
  provider.sessions.set(a.provider_session_id, { ...s, amountTotal: 1 });
  await send("checkout.session.completed", { id: a.provider_session_id });
  const [row] = await db.query<{ status: string }>("select status from invoices where id = $1", [inv.id]);
  assert.equal(row.status, "open");
  const [att] = await db.query<{ status: string }>("select status from payment_attempts where id = $1", [a.id]);
  assert.equal(att.status, "failed");
  const unknown = await send("checkout.session.completed", { id: "cs_foreign" });
  assert.equal(unknown.body, "ignored");
  const mode = await send("checkout.session.completed", { id: a.provider_session_id }, { livemode: true });
  assert.equal(mode.body, "ignored", "a live-mode event is ignored by a test-mode configuration");
});

test("delayed payment: processing first, paid only on the async success; expiry allows a new attempt", async () => {
  const { inv, a } = await paidInvoiceFor("delayed1");
  provider.pay(a.provider_session_id, true);
  await send("checkout.session.completed", { id: a.provider_session_id });
  let [att] = await db.query<{ status: string }>("select status from payment_attempts where id = $1", [a.id]);
  assert.equal(att.status, "processing");
  let [row] = await db.query<{ status: string }>("select status from invoices where id = $1", [inv.id]);
  assert.equal(row.status, "open", "checkout completed is not proof of settled payment");
  provider.settle(a.provider_session_id);
  await send("checkout.session.async_payment_succeeded", { id: a.provider_session_id });
  [row] = await db.query<{ status: string }>("select status from invoices where id = $1", [inv.id]);
  assert.equal(row.status, "paid");

  const second = await paidInvoiceFor("expiry1");
  provider.expire(second.a.provider_session_id);
  await send("checkout.session.expired", { id: second.a.provider_session_id });
  [att] = await db.query<{ status: string }>("select status from payment_attempts where id = $1", [second.a.id]);
  assert.equal(att.status, "expired");
  const url = await startCheckout(db, second.u, second.inv.id, "on", "en");
  assert.notEqual(url, `https://checkout.mock.test/${second.a.provider_session_id}`, "a new session after expiry");
});

test("refunds and disputes: partial keeps membership, full ends it; a late success never restores it", async () => {
  const { inv, a } = await paidInvoiceFor("refund1");
  const pi = provider.pay(a.provider_session_id);
  await send("checkout.session.completed", { id: a.provider_session_id });
  await send("charge.refunded", { id: "ch_1", payment_intent: pi, amount_refunded: 4000 });
  let [row] = await db.query<{ status: string; refunded_minor: string }>("select status, refunded_minor from invoices where id = $1", [inv.id]);
  assert.equal(row.status, "partially_refunded");
  let [m] = await db.query<{ status: string }>("select status from memberships where invoice_id = $1", [inv.id]);
  assert.equal(m.status, "active");
  await send("charge.refunded", { id: "ch_1", payment_intent: pi, amount_refunded: 9900 });
  await send("charge.refunded", { id: "ch_1", payment_intent: pi, amount_refunded: 4000 }); // older total replayed
  [row] = await db.query<{ status: string; refunded_minor: string }>("select status, refunded_minor from invoices where id = $1", [inv.id]);
  assert.equal(row.status, "refunded");
  assert.equal(Number(row.refunded_minor), 9900);
  [m] = await db.query<{ status: string }>("select status from memberships where invoice_id = $1", [inv.id]);
  assert.equal(m.status, "ended");
  await send("checkout.session.completed", { id: a.provider_session_id }, { id: "evt_late_success" });
  [m] = await db.query<{ status: string }>("select status from memberships where invoice_id = $1", [inv.id]);
  assert.equal(m.status, "ended", "a replayed success never restores a refunded membership");
  const refunds = await db.query<{ amount_minor: string }>("select amount_minor from ledger_entries where invoice_id = $1 and kind = 'refund' order by id", [inv.id]);
  assert.deepEqual(refunds.map((r) => Number(r.amount_minor)), [-4000, -5900]);

  const d = await paidInvoiceFor("dispute1");
  const pi2 = provider.pay(d.a.provider_session_id);
  await send("checkout.session.completed", { id: d.a.provider_session_id });
  await send("charge.dispute.created", { id: "dp_1", payment_intent: pi2, amount: 9900, status: "needs_response" });
  [m] = await db.query<{ status: string }>("select status from memberships where invoice_id = $1", [d.inv.id]);
  assert.equal(m.status, "suspended");
  await send("charge.dispute.closed", { id: "dp_1", payment_intent: pi2, amount: 9900, status: "won" });
  [m] = await db.query<{ status: string }>("select status from memberships where invoice_id = $1", [d.inv.id]);
  assert.equal(m.status, "active");
  await send("charge.dispute.created", { id: "dp_2", payment_intent: pi2, amount: 9900, status: "needs_response" });
  await send("charge.dispute.closed", { id: "dp_2", payment_intent: pi2, amount: 9900, status: "lost" });
  [m] = await db.query<{ status: string }>("select status from memberships where invoice_id = $1", [d.inv.id]);
  assert.equal(m.status, "ended");
});

test("out-of-order events: a refund arriving before the success still ends in the refunded state", async () => {
  const { inv, a } = await paidInvoiceFor("order1");
  const pi = provider.pay(a.provider_session_id);
  await send("charge.refunded", { id: "ch_o", payment_intent: pi, amount_refunded: 9900 });
  await send("checkout.session.completed", { id: a.provider_session_id });
  const [row] = await db.query<{ status: string }>("select status from invoices where id = $1", [inv.id]);
  assert.equal(row.status, "refunded");
  const [m] = await db.query<{ status: string }>("select status from memberships where invoice_id = $1", [inv.id]);
  assert.equal(m.status, "ended");
});

test("a payment on a voided invoice is recorded for review but never becomes membership", async () => {
  const u = await mk("void1");
  const app = await applyForMembership(db, u, {}, "en");
  await decideApplication(db, admin, app.id, "approved", "Policy met", "en");
  const inv = await issueInvoice(db, admin, app.id, "en");
  await startCheckout(db, u, inv.id, "on", "en");
  await rejects(voidInvoice(db, admin, inv.id, "Issued in error"), "checkout_in_progress");
  const [a] = await db.query<{ provider_session_id: string; id: string }>("select id, provider_session_id from payment_attempts where invoice_id = $1", [inv.id]);
  provider.expire(a.provider_session_id);
  await reconcileAttempt(db, a.id, "admin");
  await voidInvoice(db, admin, inv.id, "Issued in error");
  const [m] = await db.query<{ status: string }>("select status from memberships where invoice_id = $1", [inv.id]);
  assert.equal(m.status, "ended");
  await rejects(startCheckout(db, u, inv.id, "on", "en"), "invoice_not_payable");
  assert.equal((await verifyAuditChain(db)).valid, true, "every billing decision is in an intact audit chain");
});

test("applicant language: decision and invoice emails follow the applicant, not the staff interface", async () => {
  const u = await mk("rulang1");
  const app = await applyForMembership(db, u, {}, "ru");
  await decideApplication(db, admin, app.id, "approved", "Policy met", "en");
  const inv = await issueInvoice(db, admin, app.id, "en");
  const mails = await db.query<{ template: string; lang: string }>("select template, lang from email_outbox where user_id = $1 order by created_at", [u.id]);
  assert.deepEqual(
    mails.map((m) => `${m.template}:${m.lang}`),
    ["membership_application:ru", "membership_decision:ru", "invoice_issued:ru"],
  );
  const [row] = await db.query<{ lang: string }>("select lang from invoices where id = $1", [inv.id]);
  assert.equal(row.lang, "ru");
});

test("account deletion waits for an in-flight payment, then closes billing records and removes credentials", async () => {
  const u = await mk("leaver1");
  const app = await applyForMembership(db, u, { objective: "Premium" }, "en");
  await decideApplication(db, admin, app.id, "approved", "Policy met", "en");
  const inv = await issueInvoice(db, admin, app.id, "en");
  await startCheckout(db, u, inv.id, "on", "en");
  await db.query("insert into mfa_recovery_codes (user_id, code_hash) values ($1, 'x')", [u.id]);
  await db.query("insert into quick_queue (user_id, game, expires_at) values ($1, 'cs2', now() + interval '30 minutes')", [u.id]);

  const exported = await exportAccount(db, u);
  for (const key of ["consents", "invoices", "paymentAttempts", "memberships", "membershipApplications", "wallet", "challenges", "emails"])
    assert.ok(key in exported, `export includes ${key}`);
  assert.equal(JSON.stringify(exported).includes("password_hash"), false, "no credential material in the export");

  await rejects(deleteAccount(db, u, "correct horse battery"), "checkout_in_progress");
  const [a] = await db.query<{ id: string; provider_session_id: string }>("select id, provider_session_id from payment_attempts where invoice_id = $1", [inv.id]);
  provider.expire(a.provider_session_id);
  await reconcileAttempt(db, a.id, "admin");
  await deleteAccount(db, u, "correct horse battery");

  const [invRow] = await db.query<{ status: string }>("select status from invoices where id = $1", [inv.id]);
  assert.equal(invRow.status, "void", "an unpaid invoice is voided");
  const [m] = await db.query<{ status: string; status_reason: string }>("select status, status_reason from memberships where invoice_id = $1", [inv.id]);
  assert.deepEqual([m.status, m.status_reason], ["ended", "account_deleted"]);
  for (const table of ["email_outbox", "mfa_recovery_codes", "quick_queue", "email_tokens"]) {
    const rows = await db.query(`select 1 from ${table} where user_id = $1`, [u.id]);
    assert.equal(rows.length, 0, `${table} cleared`);
  }
  const [user] = await db.query<{ status: string; email: string; country_code: string | null }>("select status, email, country_code from users where id = $1", [u.id]);
  assert.equal(user.status, "deleted");
  assert.match(user.email, /@invalid\.local$/);
  const [ledger] = await db.query<{ n: number }>("select count(*)::int as n from invoices where user_id = $1", [u.id]);
  assert.equal(ledger.n, 1, "financial records are kept, linked to the anonymised account");
});
