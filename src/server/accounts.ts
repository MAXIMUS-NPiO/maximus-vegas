import { checkReservedName, claimReservedName } from "./username-reservations.ts";
/**
 * Email ownership, password recovery, consent records and the email-first sign-up mode.
 *
 * Tokens are random 256-bit values; only their SHA-256 is stored. Each is single-use, bound to one
 * purpose and to the email it was issued for, and expires (verification 48 h, activation 24 h, reset
 * 30 min). Email confirmation proves access to a mailbox — it is not identity verification or KYC.
 */
import { randomBytes } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { createSession, hashPassword, parseSignUp, recordSignupConsents, sha256, spendSignupBudget, type SignUpInput } from "./auth.ts";
import { audit } from "./audit.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { enqueueMail, link, mailConfigured } from "./mail.ts";
import { LEGAL_VERSIONS } from "../lib/legal.ts";
import * as v from "./validate.ts";

type Purpose = "verify_email" | "reset_password" | "activate";
const TTL_MINUTES: Record<Purpose, number> = { verify_email: 48 * 60, activate: 24 * 60, reset_password: 30 };

/** Email-first sign-up (enumeration-safe) is used only when delivery is configured and explicitly required. */
export const emailFirstMode = () => process.env.SIGNUP_EMAIL_CONFIRMATION === "required" && mailConfigured();

async function tooMany(q: Queryable, key: string, max: number, minutes: number) {
  const [row] = await q.query<{ n: number }>(
    "select count(*)::int as n from auth_attempts where key = $1 and at > now() - ($2 || ' minutes')::interval",
    [key, String(minutes)],
  );
  return (row?.n ?? 0) >= max;
}
const note = (q: Queryable, key: string) => q.query("insert into auth_attempts (key, ok) values ($1, true)", [key]);

async function issueToken(q: Queryable, userId: string, purpose: Purpose, email: string): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await q.query("update email_tokens set used_at = now() where user_id = $1 and purpose = $2 and used_at is null", [userId, purpose]);
  await q.query(
    "insert into email_tokens (id, user_id, purpose, email, expires_at) values ($1, $2, $3, $4, now() + ($5 || ' minutes')::interval)",
    [sha256(raw), userId, purpose, email, String(TTL_MINUTES[purpose])],
  );
  return raw;
}

async function consumeToken(q: Queryable, raw: unknown, purpose: Purpose): Promise<{ userId: string; email: string }> {
  const token = typeof raw === "string" ? raw.trim() : "";
  if (!token || token.length > 100) fail("token_invalid");
  const [row] = await q.query<{ user_id: string; email: string; purpose: string; used_at: Date | null; expired: boolean; current_email: string }>(
    `select t.user_id, t.email, t.purpose, t.used_at, t.expires_at < now() as expired, u.email as current_email
       from email_tokens t join users u on u.id = t.user_id where t.id = $1 for update of t`,
    [sha256(token)],
  );
  if (!row || row.purpose !== purpose || row.used_at || row.expired || row.email !== row.current_email) fail("token_invalid");
  await q.query("update email_tokens set used_at = now() where id = $1", [sha256(token)]);
  return { userId: row!.user_id, email: row!.email };
}

/** Queues a confirmation email right after an instant sign-up, when delivery is configured. */
export async function queueVerification(q: Queryable, userId: string, email: string, lang: "ru" | "en") {
  if (!mailConfigured()) return;
  const raw = await issueToken(q, userId, "verify_email", email);
  await enqueueMail(q, { to: email, template: "verify_email", lang, userId, data: { url: link(`/${lang}/verify-email?token=${raw}`) } });
}

export async function requestEmailVerification(db: Database, user: SessionUser, lang: "ru" | "en") {
  if (!mailConfigured()) fail("email_not_configured");
  await db.tx(async (q) => {
    const [u] = await q.query<{ email: string; email_verified_at: Date | null }>("select email, email_verified_at from users where id = $1", [user.id]);
    if (u.email_verified_at) return;
    const key = `verify:${user.id}`;
    if (await tooMany(q, key, 3, 60)) fail("too_many_attempts");
    await note(q, key);
    await queueVerification(q, user.id, u.email, lang);
  });
}

export async function verifyEmail(db: Database, raw: unknown) {
  return db.tx(async (q) => {
    const { userId } = await consumeToken(q, raw, "verify_email");
    await q.query("update users set email_verified_at = coalesce(email_verified_at, now()), updated_at = now() where id = $1", [userId]);
    await audit(q, { actorId: userId, action: "user.email_verified", entity: "user", entityId: userId });
    return userId;
  });
}

/**
 * Always completes without revealing whether the address has an account. Only an active account with a
 * matching email receives a link; requests are rate-limited per address.
 */
export async function requestPasswordReset(db: Database, emailInput: unknown, lang: "ru" | "en") {
  if (!mailConfigured()) fail("email_not_configured");
  const email = v.email(emailInput);
  await db.tx(async (q) => {
    const key = `reset:${sha256(email)}`;
    if (await tooMany(q, key, 3, 60)) return;
    await note(q, key);
    const [u] = await q.query<{ id: string }>("select id from users where email = $1 and status = 'active'", [email]);
    if (!u) return;
    const raw = await issueToken(q, u.id, "reset_password", email);
    await enqueueMail(q, { to: email, template: "reset_password", lang, userId: u.id, data: { url: link(`/${lang}/reset-password?token=${raw}`) } });
    await audit(q, { actorId: u.id, action: "user.password_reset_requested", entity: "user", entityId: u.id });
  });
}

export async function resetPassword(db: Database, raw: unknown, passwordInput: unknown, userAgent: string) {
  const password = v.password(passwordInput);
  const hash = await hashPassword(password);
  return db.tx(async (q) => {
    const { userId } = await consumeToken(q, raw, "reset_password");
    await q.query(
      "update users set password_hash = $2, email_verified_at = coalesce(email_verified_at, now()), updated_at = now() where id = $1 and status = 'active'",
      [userId, hash],
    );
    await q.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [userId]);
    await audit(q, { actorId: userId, action: "user.password_reset", entity: "user", entityId: userId });
    return createSession(q, userId, userAgent);
  });
}

/**
 * Email-first sign-up: the response is identical whether or not the address is registered. A new address
 * gets an activation link; an existing one gets a notice with a recovery link. Stale unconfirmed sign-ups
 * (older than 24 h) release their email and username.
 */
export async function signUpEmailFirst(db: Database, input: SignUpInput) {
  const data = parseSignUp(input);
  await spendSignupBudget(db, input.clientKey, input.deviceKey);
  const lang = input.lang ?? "ru";
  const passwordHash = await hashPassword(data.password);
  await db.tx(async (q) => {
    const key = `signup:${sha256(data.email)}`;
    if (await tooMany(q, key, 5, 60)) return;
    await note(q, key);
    await q.query(
      "delete from users where status = 'pending' and created_at < now() - interval '24 hours' and (email = $1 or username = $2)",
      [data.email, data.username],
    );
    const [existing] = await q.query<{ id: string; status: string }>("select id, status from users where email = $1", [data.email]);
    if (existing) {
      if (existing.status === "pending") {
        const raw = await issueToken(q, existing.id, "activate", data.email);
        await enqueueMail(q, { to: data.email, template: "activate_account", lang, userId: existing.id, data: { url: link(`/${lang}/activate?token=${raw}`) } });
      } else if (existing.status === "active") {
        const hour = new Date().toISOString().slice(0, 13);
        await enqueueMail(q, {
          to: data.email,
          template: "account_exists",
          lang,
          userId: existing.id,
          dedupeKey: `account_exists:${existing.id}:${hour}`,
          data: { url: link(`/${lang}/forgot-password`) },
        });
      }
      return;
    }
    const reservation = await checkReservedName(q, data.username, input.reservation);
    let userId: string;
    try {
      const [user] = await q.query<{ id: string }>(
        `insert into users (email, username, display_name, password_hash, adult_confirmed_at, status)
         values ($1, $2, $3, $4, now(), 'pending') returning id`,
        [data.email, data.username, data.displayName, passwordHash],
      );
      userId = user.id;
    } catch (error) {
      if (isUniqueViolation(error, "users_username_key")) fail("username_taken");
      throw error;
    }
    await claimReservedName(q, reservation, userId);
    await recordSignupConsents(q, userId, data.marketing);
    const raw = await issueToken(q, userId, "activate", data.email);
    await enqueueMail(q, { to: data.email, template: "activate_account", lang, userId, data: { url: link(`/${lang}/activate?token=${raw}`) } });
    await audit(q, { actorId: userId, action: "user.signup_pending", entity: "user", entityId: userId, data: { username: data.username } });
  });
}

export async function activateAccount(db: Database, raw: unknown, userAgent: string) {
  return db.tx(async (q) => {
    const { userId } = await consumeToken(q, raw, "activate");
    const rows = await q.query(
      "update users set status = 'active', email_verified_at = now(), updated_at = now() where id = $1 and status = 'pending' returning id",
      [userId],
    );
    if (!rows.length) fail("token_invalid");
    await audit(q, { actorId: userId, action: "user.activated", entity: "user", entityId: userId });
    return createSession(q, userId, userAgent);
  });
}

// ---------- Consents ----------

export async function latestConsents(q: Queryable, userId: string) {
  const rows = await q.query<{ kind: string; version: string; granted: boolean; created_at: Date }>(
    `select distinct on (kind) kind, version, granted, created_at from consents where user_id = $1 order by kind, id desc`,
    [userId],
  );
  return Object.fromEntries(rows.map((r) => [r.kind, r])) as Record<string, { version: string; granted: boolean; created_at: Date }>;
}

export async function needsTermsAcceptance(q: Queryable, userId: string): Promise<boolean> {
  const c = await latestConsents(q, userId);
  return c.terms?.version !== LEGAL_VERSIONS.terms || c.privacy?.version !== LEGAL_VERSIONS.privacy || !c.terms?.granted;
}

export async function acceptCurrentTerms(db: Database, user: SessionUser) {
  await db.tx(async (q) => {
    await q.query(
      "insert into consents (user_id, kind, version, granted, source) values ($1, 'terms', $2, true, 'update_prompt'), ($1, 'privacy', $3, true, 'update_prompt')",
      [user.id, LEGAL_VERSIONS.terms, LEGAL_VERSIONS.privacy],
    );
    await audit(q, { actorId: user.id, action: "user.terms_accepted", entity: "user", entityId: user.id, data: { ...LEGAL_VERSIONS } });
  });
}

export async function setMarketing(db: Database, user: SessionUser, optIn: boolean) {
  await db.tx(async (q) => {
    await q.query("insert into consents (user_id, kind, version, granted, source) values ($1, 'marketing', $2, $3, 'settings')", [
      user.id,
      LEGAL_VERSIONS.privacy,
      optIn,
    ]);
    await q.query("update users set marketing_opt_in_at = $2, updated_at = now() where id = $1", [user.id, optIn ? new Date().toISOString() : null]);
  });
}

export async function completeOnboarding(db: Database, user: SessionUser) {
  await db.query("update users set onboarded_at = coalesce(onboarded_at, now()) where id = $1", [user.id]);
}

export async function setCountry(db: Database, user: SessionUser, codeInput: unknown) {
  const { isCountry } = await import("../lib/countries.ts");
  const code = String(codeInput ?? "").trim().toUpperCase();
  if (code && !isCountry(code)) fail("invalid_country");
  await db.query("update users set country_code = $2, updated_at = now() where id = $1", [user.id, code || null]);
}
