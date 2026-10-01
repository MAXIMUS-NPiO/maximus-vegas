/**
 * Secrets the portal must read back later (webhook signing secrets) are sealed with AES-256-GCM. The key is
 * derived from MFA_SECRET_KEY with a purpose label, so each kind of secret has its own key. Without
 * MFA_SECRET_KEY the value is stored as-is and the integrations page says so.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { fail } from "./errors.ts";

export type SealScheme = "aes-256-gcm" | "plain";

function key(purpose: string): Buffer | null {
  const raw = process.env.MFA_SECRET_KEY?.trim();
  return raw && raw.length >= 32 ? createHash("sha256").update(`${purpose}\u0000${raw}`).digest() : null;
}

export const sealScheme = (purpose: string): SealScheme => (key(purpose) ? "aes-256-gcm" : "plain");

export function seal(purpose: string, secret: string): { value: string; scheme: SealScheme } {
  const k = key(purpose);
  if (!k) return { value: secret, scheme: "plain" };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { value: [iv, cipher.getAuthTag(), ct].map((b) => b.toString("base64")).join("."), scheme: "aes-256-gcm" };
}

export function unseal(purpose: string, value: string, scheme: string): string {
  if (scheme === "plain") return value;
  const k = key(purpose);
  if (!k) fail("server_error", "MFA_SECRET_KEY is required to read sealed secrets");
  const [iv, tag, ct] = value.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", k!, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
