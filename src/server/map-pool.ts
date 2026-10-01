/** The event's map pool for the veto (MV-VETO-1): parsing what an organiser typed and reading what is stored. */
import { fail } from "./errors.ts";

export const MAX_POOL = 15;

/** The map pool an organiser typed: separated by commas, semicolons or new lines; 2–15 distinct names, or none. */
export function parseMapPool(input: unknown): string[] | null {
  const list = String(input ?? "")
    .split(/[,;\n\r]+/)
    .map((x) => x.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (!list.length) return null;
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const name of list) {
    if (name.length > 32) fail("invalid_input");
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(name);
  }
  if (pool.length < 2 || pool.length > MAX_POOL) fail("invalid_input");
  return pool;
}

/** Stored pool of a tournament row; anything malformed reads as no pool. */
export function mapPoolOf(t: { map_pool?: unknown }): string[] | null {
  const raw = typeof t.map_pool === "string" ? safeJson(t.map_pool) : t.map_pool;
  return Array.isArray(raw) && raw.length >= 2 && raw.every((x) => typeof x === "string") ? (raw as string[]) : null;
}
const safeJson = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
