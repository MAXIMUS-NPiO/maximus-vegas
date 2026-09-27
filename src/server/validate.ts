import { randomBytes } from "node:crypto";
import { fail } from "./errors.ts";

export const clean = (value: unknown, max: number): string => {
  if (typeof value !== "string") return "";
  return value.replace(/\u0000/g, "").trim().slice(0, max);
};

export const oneLine = (value: unknown, max: number): string =>
  clean(value, max).replace(/[\r\n\t]+/g, " ");

export function email(value: unknown): string {
  const v = oneLine(value, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) fail("invalid_email");
  return v;
}

export function username(value: unknown): string {
  const v = oneLine(value, 40).toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(v)) fail("invalid_username");
  return v;
}

export function displayName(value: unknown, max = 60): string {
  const v = oneLine(value, max);
  if (v.length < 2) fail("invalid_name");
  return v;
}

export function password(value: unknown): string {
  if (typeof value !== "string" || value.length < 10 || value.length > 200) fail("weak_password");
  return value as string;
}

export function intIn(value: unknown, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isInteger(n) || n < min || n > max) fail("invalid_input");
  return n;
}

export function optionalUrl(value: unknown): string {
  const v = oneLine(value, 500);
  if (!v) return "";
  try {
    const url = new URL(v);
    if (url.protocol !== "https:" && url.protocol !== "http:") fail("invalid_url");
    return url.toString();
  } catch {
    return fail("invalid_url");
  }
}

export function bool(value: unknown): boolean {
  return value === true || value === "on" || value === "true" || value === "1";
}

export function slugify(value: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  const base = value
    .toLowerCase()
    .split("")
    .map((ch) => map[ch] ?? ch)
    .join("")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "item";
}

export const shortId = (bytes = 3) => randomBytes(bytes).toString("hex");

/**
 * Converts a wall-clock "YYYY-MM-DDTHH:mm" in an IANA time zone to a UTC Date.
 */
export function zonedToUtc(local: unknown, timeZone: unknown): Date {
  const text = oneLine(local, 25);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text);
  if (!m) return fail("invalid_date");
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  let zone = oneLine(timeZone, 64) || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instant));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return asUtc - instant;
  };
  let guess = wall - offsetAt(wall);
  guess = wall - offsetAt(guess);
  const date = new Date(guess);
  if (Number.isNaN(date.getTime())) fail("invalid_date");
  return date;
}
