import { SESSION_COOKIE, SESSION_DAYS, sessionUser, type SessionUser } from "./auth.ts";
import { getDb, DatabaseUnavailable, type Database } from "./db.ts";
import { DomainError, ERROR_CODES, type ErrorCode } from "./errors.ts";

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const secure = () => process.env.NODE_ENV === "production" && process.env.MV_INSECURE_COOKIES !== "1";

export function sessionCookie(token: string, expires: Date) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}; Expires=${expires.toUTCString()}${secure() ? "; Secure" : ""}`;
}
export const clearSessionCookie = () =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure() ? "; Secure" : ""}`;

/** Same-origin check against the real incoming host (Next.js may rewrite request.url internally). */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  return origin === `${proto}://${host}`;
}

export function safeReturn(value: unknown, fallback: string): string {
  const v = typeof value === "string" ? value : "";
  if (/^\/(ru|en)(\/[^\s]*)?$/.test(v) && !v.startsWith("//") && !v.includes("\\")) return v;
  return fallback;
}

export function withParam(path: string, key: "ok" | "e", code: string) {
  const [base, hash] = path.split("#");
  const url = new URL(base, "http://x");
  url.searchParams.delete("ok");
  url.searchParams.delete("e");
  url.searchParams.set(key, code);
  return `${url.pathname}${url.search}${hash ? `#${hash}` : ""}`;
}

export function redirect(path: string, cookie?: string | string[]) {
  const headers = new Headers({ Location: path, "Cache-Control": "no-store" });
  for (const c of Array.isArray(cookie) ? cookie : cookie ? [cookie] : []) headers.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers });
}

export function errorCode(error: unknown): ErrorCode {
  if (error instanceof DomainError) return error.code;
  if (error instanceof DatabaseUnavailable) return "db_unavailable";
  const code = (error as { code?: string })?.code;
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "57P01") return "db_unavailable";
  if (typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code)) return code as ErrorCode;
  return "server_error";
}

export type Ctx = {
  db: Database;
  user: SessionUser | null;
  form: Record<string, string>;
  multi: Record<string, string[]>;
  files: Record<string, File>;
  lang: "ru" | "en";
  back: string;
  request: Request;
  token: string | undefined;
};

/** Upper bound for any action body (uploads are limited per kind well below this). */
export const MAX_BODY_BYTES = 3 * 1024 * 1024;

export async function context(request: Request): Promise<Ctx> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) throw new DomainError("file_too_large");
  const data = await request.formData();
  const form: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  const files: Record<string, File> = {};
  for (const [k, value] of data.entries()) {
    if (typeof value !== "string") {
      if (value && (value as File).size > 0) files[k] = value as File;
      continue;
    }
    form[k] = value;
    (multi[k] ??= []).push(value);
  }
  const lang = form.lang === "en" ? "en" : "ru";
  const back = safeReturn(form.back, `/${lang}`);
  const db = await getDb();
  const token = parseCookies(request.headers.get("cookie"))[SESSION_COOKIE];
  const user = await sessionUser(db, token);
  return { db, user, form, multi, files, lang, back, request, token };
}

/**
 * Short-lived copy of what was typed into a registration form, so a validation error or a language
 * switch does not wipe it. HttpOnly, never in the URL, never the password; cleared on success.
 */
export const DRAFT_COOKIE = "mv_draft";
export function draftCookie(values: Record<string, string>) {
  const payload = Buffer.from(JSON.stringify(values)).toString("base64url");
  return `${DRAFT_COOKIE}=${payload}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900${secure() ? "; Secure" : ""}`;
}
export const clearDraftCookie = () => `${DRAFT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure() ? "; Secure" : ""}`;
export function readDraft(raw: string | undefined): Record<string, string> {
  if (!raw || raw.length > 4000) return {};
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, String(v).slice(0, 300)]));
  } catch {
    return {};
  }
}
