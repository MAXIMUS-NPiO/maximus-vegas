/**
 * Accounts: consents, email ownership, recovery, the email-first mode, the durable outbox and staff MFA.
 * Mail uses the in-memory TEST transport (MAIL_TRANSPORT=test) — no real email is sent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signIn, signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import {
  acceptCurrentTerms,
  activateAccount,
  latestConsents,
  needsTermsAcceptance,
  requestEmailVerification,
  requestPasswordReset,
  resetPassword,
  signUpEmailFirst,
  verifyEmail,
} from "../src/server/accounts.ts";
import { drainOutbox, testMailbox } from "../src/server/mail.ts";
import { base32Decode, confirmEnrolment, requireStaffMfa, startEnrolment, totp, verifySecondFactor, hotp } from "../src/server/mfa.ts";
import { LEGAL_VERSIONS } from "../src/lib/legal.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}
const tokenFrom = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? "";
const lastMailTo = (to: string, match?: RegExp) => [...testMailbox()].reverse().find((m) => m.to === to && (!match || match.test(m.text)));

test.before(async () => {
  process.env.MAIL_TRANSPORT = "test";
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
});
test.after(async () => {
  delete process.env.MAIL_TRANSPORT;
  delete process.env.SIGNUP_EMAIL_CONFIRMATION;
  await db.close();
});

test("sign-up records the accepted versions and a separate, unchecked marketing choice; email conflicts are generic", async () => {
  const s = await signUp(db, { email: "anna@example.com", username: "anna", displayName: "Anna", password: "correct horse battery", adult: "on", terms: "on" });
  const u = (await sessionUser(db, s.token))!;
  const c = await latestConsents(db, u.id);
  assert.equal(c.terms.version, LEGAL_VERSIONS.terms);
  assert.equal(c.privacy.version, LEGAL_VERSIONS.privacy);
  assert.equal(c.marketing.granted, false, "marketing is off unless chosen");
  assert.equal(await needsTermsAcceptance(db, u.id), false);
  await rejects(signUp(db, { email: "anna@example.com", username: "anna2", displayName: "Anna", password: "correct horse battery", adult: "on", terms: "on" }), "signup_unavailable");
  // An account that accepted the previous version is asked to accept the new one.
  await db.query("insert into consents (user_id, kind, version, granted, source) values ($1, 'terms', '2026-09-27', true, 'test')", [u.id]);
  assert.equal(await needsTermsAcceptance(db, u.id), true);
  await acceptCurrentTerms(db, u);
  assert.equal(await needsTermsAcceptance(db, u.id), false);
});

test("email verification: expiring, single-use, bound to the address; the outbox distinguishes queued from sent", async () => {
  const s = await signUp(db, { email: "boris@example.com", username: "boris", displayName: "Boris", password: "correct horse battery", adult: "on", terms: "on", lang: "en" });
  const u = (await sessionUser(db, s.token))!;
  assert.equal(u.emailVerified, false);
  const [queued] = await db.query<{ status: string }>("select status from email_outbox where to_email = 'boris@example.com'");
  assert.equal(queued.status, "pending", "saved before delivery");
  process.env.MAIL_TEST_FAIL = "1";
  const failed = await drainOutbox(db);
  assert.equal(failed.failed >= 1, true);
  const [f] = await db.query<{ status: string; attempts: number; next_attempt_at: Date }>("select status, attempts, next_attempt_at from email_outbox where to_email = 'boris@example.com'");
  assert.equal(f.status, "failed", "a delivery failure is never reported as sent");
  assert.ok(new Date(f.next_attempt_at).getTime() > Date.now(), "retry is scheduled with backoff");
  delete process.env.MAIL_TEST_FAIL;
  await db.query("update email_outbox set next_attempt_at = now() where to_email = 'boris@example.com'");
  await drainOutbox(db);
  const [sent] = await db.query<{ status: string }>("select status from email_outbox where to_email = 'boris@example.com'");
  assert.equal(sent.status, "sent");
  const token = tokenFrom(lastMailTo("boris@example.com", /verify-email/)!.text);
  assert.ok(token);
  await verifyEmail(db, token);
  await rejects(verifyEmail(db, token), "token_invalid");
  const again = (await sessionUser(db, s.token))!;
  assert.equal(again.emailVerified, true);
  // Expired tokens are refused.
  const s2 = await signUp(db, { email: "vera@example.com", username: "vera", displayName: "Vera", password: "correct horse battery", adult: "on", terms: "on" });
  const u2 = (await sessionUser(db, s2.token))!;
  await requestEmailVerification(db, u2, "en");
  await drainOutbox(db);
  const t2 = tokenFrom(lastMailTo("vera@example.com", /verify-email/)!.text);
  await db.query("update email_tokens set expires_at = now() - interval '1 minute' where user_id = $1", [u2.id]);
  await rejects(verifyEmail(db, t2), "token_invalid");
});

test("password reset: generic for unknown addresses, single use, ends every session", async () => {
  const before = testMailbox().length;
  await requestPasswordReset(db, "nobody@example.com", "en");
  await drainOutbox(db);
  assert.equal(testMailbox().length, before, "no email and no error for an unknown address");
  const s = await signUp(db, { email: "cara@example.com", username: "cara", displayName: "Cara", password: "correct horse battery", adult: "on", terms: "on" });
  await requestPasswordReset(db, "cara@example.com", "en");
  await drainOutbox(db);
  const token = tokenFrom(lastMailTo("cara@example.com", /reset-password/)!.text);
  const session = await resetPassword(db, token, "a brand new password", "test");
  assert.ok(session.token);
  assert.equal(await sessionUser(db, s.token), null, "old sessions ended");
  await rejects(resetPassword(db, token, "another new password", "test"), "token_invalid");
  await signIn(db, { login: "cara", password: "a brand new password" });
});

test("email-first mode: identical outcome for new and existing addresses; pending accounts activate by link", async () => {
  process.env.SIGNUP_EMAIL_CONFIRMATION = "required";
  await signUpEmailFirst(db, { email: "anna@example.com", username: "someoneelse", displayName: "Xx", password: "correct horse battery", adult: "on", terms: "on" });
  await signUpEmailFirst(db, { email: "dan@example.com", username: "dan", displayName: "Dan", password: "correct horse battery", adult: "on", terms: "on" });
  await drainOutbox(db);
  assert.match(lastMailTo("anna@example.com")!.subject, /Sign-up attempt|Попытка регистрации/);
  const [pending] = await db.query<{ status: string }>("select status from users where username = 'dan'");
  assert.equal(pending.status, "pending");
  await rejects(signIn(db, { login: "dan", password: "correct horse battery" }), "account_not_activated");
  const token = tokenFrom(lastMailTo("dan@example.com", /activate/)!.text);
  const s = await activateAccount(db, token, "test");
  const u = (await sessionUser(db, s.token))!;
  assert.equal(u.emailVerified, true);
  delete process.env.SIGNUP_EMAIL_CONFIRMATION;
});

test("staff MFA: enrolment, replay protection, single-use recovery codes and the control-centre gate", async () => {
  const s = await signUp(db, { email: "staff@example.com", username: "staffer", displayName: "Staff", password: "correct horse battery", adult: "on", terms: "on" });
  await db.query("insert into user_roles (user_id, role) values ((select id from users where username = 'staffer'), 'admin')");
  let u = (await sessionUser(db, s.token))!;
  await rejects(requireStaffMfa(db, u), "mfa_not_enrolled");
  const { secret, uri } = await startEnrolment(db, u);
  assert.match(uri, /^otpauth:\/\/totp\//);
  const key = base32Decode(secret);
  const codes = await confirmEnrolment(db, u, totp(key));
  assert.equal(codes.length, 10);
  u = (await sessionUser(db, s.token))!;
  await requireStaffMfa(db, u);
  // The code used for enrolment cannot be replayed; the next step's code works.
  await rejects(verifySecondFactor(db, u, totp(key)), "mfa_invalid");
  const next = hotp(key, Math.floor(Date.now() / 30000) + 1);
  await verifySecondFactor(db, u, next);
  await verifySecondFactor(db, u, codes[0]);
  await rejects(verifySecondFactor(db, u, codes[0]), "mfa_invalid");
  // A session that has not passed the second factor is refused.
  const other = await signIn(db, { login: "staffer", password: "correct horse battery" });
  const fresh = (await sessionUser(db, other.token))!;
  await rejects(requireStaffMfa(db, fresh), "mfa_required");
});
