/**
 * Staff multi-factor authentication: TOTP (RFC 6238, SHA-1, 6 digits, 30-second steps, ±1 step window)
 * with replay protection and single-use recovery codes. The shared secret is encrypted with AES-256-GCM
 * when MFA_SECRET_KEY is configured; otherwise it is stored as-is and the security page says so.
 *
 * Every platform staff account (admin, support) must enrol before entering the control centre, and a
 * session must pass the second factor within the last 12 hours. Sensitive operations — role grants,
 * suspensions, offer approval, admission decisions, invoices and refunds — require a fresh check within
 * 15 minutes (step-up).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { sha256 } from "./auth.ts";
import { audit } from "./audit.ts";
import { isStaff } from "./access.ts";
import { fail } from "./errors.ts";

export const MFA_SESSION_HOURS = 12;
export const STEP_UP_MINUTES = 15;
const ISSUER = "MAXIMUS VEGAS";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

export const stepAt = (ms: number) => Math.floor(ms / 1000 / 30);
export const totp = (secret: Buffer, ms = Date.now()) => hotp(secret, stepAt(ms));

/** Returns the matching step, or null. Steps at or before `lastStep` are refused (no replay). */
export function verifyTotp(secret: Buffer, code: string, lastStep: number, ms = Date.now()): number | null {
  const digits = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const now = stepAt(ms);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    const expected = hotp(secret, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(digits))) return step;
  }
  return null;
}

function key(): Buffer | null {
  const raw = process.env.MFA_SECRET_KEY?.trim();
  return raw && raw.length >= 32 ? createHash("sha256").update(raw).digest() : null;
}

export const secretEncryption = () => (key() ? "aes-256-gcm" : "plain");

function seal(secret: string): { value: string; scheme: "aes-256-gcm" | "plain" } {
  const k = key();
  if (!k) return { value: secret, scheme: "plain" };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { value: [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join("."), scheme: "aes-256-gcm" };
}

function open(value: string, scheme: string): string {
  if (scheme === "plain") return value;
  const k = key();
  if (!k) fail("server_error", "MFA_SECRET_KEY is required to read encrypted factors");
  const [iv, tag, ct] = value.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", k!, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export async function mfaStatus(q: Queryable, userId: string) {
  const [f] = await q.query<{ confirmed_at: Date | null; scheme: string }>("select confirmed_at, scheme from mfa_factors where user_id = $1", [userId]);
  const [codes] = await q.query<{ n: number }>("select count(*)::int as n from mfa_recovery_codes where user_id = $1 and used_at is null", [userId]);
  return { enrolled: Boolean(f?.confirmed_at), pending: Boolean(f && !f.confirmed_at), scheme: f?.scheme ?? null, recoveryLeft: codes?.n ?? 0 };
}

/** Starts (or restarts) enrolment. Returns the secret for the authenticator app. */
export async function startEnrolment(db: Database, user: SessionUser) {
  const status = await mfaStatus(db, user.id);
  if (status.enrolled) fail("mfa_already_enrolled");
  const secret = base32Encode(randomBytes(20));
  const sealed = seal(secret);
  await db.query(
    `insert into mfa_factors (user_id, secret, scheme) values ($1, $2, $3)
     on conflict (user_id) do update set secret = excluded.secret, scheme = excluded.scheme, confirmed_at = null, last_step = 0, created_at = now()`,
    [user.id, sealed.value, sealed.scheme],
  );
  return { secret, uri: otpauthUri(user.username, secret) };
}

export const otpauthUri = (account: string, secret: string) =>
  `otpauth://totp/${encodeURIComponent(`${ISSUER}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;

export async function pendingSecret(q: Queryable, userId: string): Promise<string | null> {
  const [f] = await q.query<{ secret: string; scheme: string; confirmed_at: Date | null }>("select secret, scheme, confirmed_at from mfa_factors where user_id = $1", [userId]);
  if (!f || f.confirmed_at) return null;
  return open(f.secret, f.scheme);
}

function recoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const c = base32Encode(randomBytes(7)).slice(0, 10);
    return `${c.slice(0, 5)}-${c.slice(5)}`;
  });
}
const normaliseRecovery = (code: string) => code.toUpperCase().replace(/[^A-Z2-7]/g, "");

async function limited(q: Queryable, userId: string) {
  const [row] = await q.query<{ n: number }>(
    "select count(*)::int as n from auth_attempts where key = $1 and ok = false and at > now() - interval '15 minutes'",
    [`mfa:${userId}`],
  );
  return (row?.n ?? 0) >= 6;
}

/** Confirms enrolment with a first code; returns the one-time recovery codes (shown once). */
export async function confirmEnrolment(db: Database, user: SessionUser, code: unknown): Promise<string[]> {
  if (await limited(db, user.id)) fail("too_many_attempts");
  const secret = await pendingSecret(db, user.id);
  if (!secret) fail("mfa_not_enrolled");
  const step = verifyTotp(base32Decode(secret!), String(code ?? ""), 0);
  if (step === null) {
    await db.query("insert into auth_attempts (key, ok) values ($1, false)", [`mfa:${user.id}`]);
    fail("mfa_invalid");
  }
  const codes = recoveryCodes();
  await db.tx(async (q) => {
    await q.query("update mfa_factors set confirmed_at = now(), last_step = $2 where user_id = $1 and confirmed_at is null", [user.id, step]);
    await q.query("delete from mfa_recovery_codes where user_id = $1", [user.id]);
    for (const c of codes) await q.query("insert into mfa_recovery_codes (user_id, code_hash) values ($1, $2)", [user.id, sha256(normaliseRecovery(c))]);
    await q.query("update sessions set mfa_at = now() where id = $1", [user.sessionId]);
    await audit(q, { actorId: user.id, action: "mfa.enrolled", entity: "user", entityId: user.id });
  });
  return codes;
}

/** Verifies a TOTP code or a recovery code and marks this session as verified. */
export async function verifySecondFactor(db: Database, user: SessionUser, codeInput: unknown) {
  const code = String(codeInput ?? "").trim();
  if (await limited(db, user.id)) fail("too_many_attempts");
  const ok = await db.tx(async (q) => {
    const [f] = await q.query<{ secret: string; scheme: string; confirmed_at: Date | null; last_step: string | number }>(
      "select * from mfa_factors where user_id = $1 for update",
      [user.id],
    );
    if (!f?.confirmed_at) fail("mfa_not_enrolled");
    const step = verifyTotp(base32Decode(open(f!.secret, f!.scheme)), code, Number(f!.last_step));
    let method = "totp";
    if (step !== null) await q.query("update mfa_factors set last_step = $2 where user_id = $1", [user.id, step]);
    else {
      const used = await q.query(
        "update mfa_recovery_codes set used_at = now() where user_id = $1 and code_hash = $2 and used_at is null returning code_hash",
        [user.id, sha256(normaliseRecovery(code))],
      );
      if (!used.length) {
        // Recorded (committed) before refusing, so failed attempts count towards the limit.
        await q.query("insert into auth_attempts (key, ok) values ($1, false)", [`mfa:${user.id}`]);
        return false;
      }
      method = "recovery_code";
    }
    await q.query("update sessions set mfa_at = now() where id = $1", [user.sessionId]);
    await audit(q, { actorId: user.id, action: "mfa.verified", entity: "user", entityId: user.id, data: { method } });
    return true;
  });
  if (!ok) fail("mfa_invalid");
}

/** Gate for the control centre: staff must be enrolled and verified in this session. */
export async function requireStaffMfa(q: Queryable, user: SessionUser | null) {
  if (!user || !isStaff(user)) return;
  const status = await mfaStatus(q, user.id);
  if (!status.enrolled) fail("mfa_not_enrolled");
  if (!user.mfaAt || Date.now() - user.mfaAt.getTime() > MFA_SESSION_HOURS * 3600_000) fail("mfa_required");
}

export function requireStepUp(user: SessionUser) {
  if (!user.mfaAt || Date.now() - user.mfaAt.getTime() > STEP_UP_MINUTES * 60_000) fail("step_up_required");
}

/** An administrator resets a colleague's lost factor (after their own step-up); the colleague re-enrols. */
export async function resetFactor(db: Database, admin: SessionUser, targetId: string) {
  if (!admin.roles.includes("admin")) fail("forbidden");
  requireStepUp(admin);
  if (targetId === admin.id) fail("cannot_modify_self");
  await db.tx(async (q) => {
    await q.query("delete from mfa_factors where user_id = $1", [targetId]);
    await q.query("delete from mfa_recovery_codes where user_id = $1", [targetId]);
    await q.query("update sessions set mfa_at = null where user_id = $1", [targetId]);
    await audit(q, { actorId: admin.id, action: "mfa.reset", entity: "user", entityId: targetId });
  });
}

export async function staffMfaOverview(q: Queryable) {
  return q.query<{ id: string; username: string; roles: string[]; enrolled: boolean }>(
    `select u.id, u.username, array_agg(r.role order by r.role) as roles,
            exists (select 1 from mfa_factors f where f.user_id = u.id and f.confirmed_at is not null) as enrolled
       from user_roles r join users u on u.id = r.user_id where u.status = 'active'
      group by u.id, u.username order by u.username`,
  );
}

export async function qrSvg(text: string): Promise<string> {
  const { renderSVG } = await import("uqr");
  return renderSVG(text, { ecc: "M", border: 2, pixelSize: 6 });
}
