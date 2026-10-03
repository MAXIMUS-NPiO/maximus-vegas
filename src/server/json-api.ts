import { getDb } from "./db.ts";
import { sessionUser, SESSION_COOKIE } from "./auth.ts";
import { errorCode, parseCookies, sameOrigin } from "./http.ts";
import { fail } from "./errors.ts";
import { gate } from "./system.ts";
export const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
export async function readJsonText(request: Pick<Request, "body" | "headers">, maxBytes = 100_000) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) fail("invalid_input");
  if (Number(request.headers.get("content-length")) > maxBytes) fail("file_too_large");
  const reader = request.body?.getReader(); if (!reader) return fail("invalid_input");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); fail("file_too_large"); } chunks.push(value); }
  return Buffer.concat(chunks).toString("utf8");
}
export async function readJsonBody(request: Request, maxBytes = 100_000) {
  const text = await readJsonText(request, maxBytes);
  let data: Record<string, unknown>;
  try { data = JSON.parse(text); } catch { return fail("invalid_input"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("invalid_input");
  return data;
}
export async function jsonContext(request: Request, action: string, maxBytes = 100_000) {
  if (!sameOrigin(request)) fail("bad_origin");
  const data = await readJsonBody(request, maxBytes);
  const db = await getDb(), user = await sessionUser(db, parseCookies(request.headers.get("cookie"))[SESSION_COOKIE]);
  if (!user) return fail("unauthorized");
  await gate(db, action, user);
  return { db, user, data };
}
export function jsonError(error: unknown) {
  const code = errorCode(error);
  if (code === "server_error") console.error("[product-api]", error);
  return json({ error: code }, code === "unauthorized" ? 401 : code === "server_error" || code === "db_unavailable" ? 503 : 400);
}
