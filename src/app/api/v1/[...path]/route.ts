import { NextResponse } from "next/server";
import { getDb } from "@/server/db.ts";
import { authenticateKey, RATE_PER_MINUTE } from "@/server/partner.ts";
import { apiMatches, apiOrganization, apiStandings, apiTournament, apiTournaments } from "@/server/partner-api.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store", "X-RateLimit-Limit": String(RATE_PER_MINUTE) };
const error = (status: number, code: string, message: string, extra: Record<string, string> = {}) =>
  NextResponse.json({ error: { code, message } }, { status, headers: { ...headers, ...extra } });

/**
 * Read API v1 (documented at /ru/developers):
 *   GET /api/v1/organization
 *   GET /api/v1/tournaments
 *   GET /api/v1/tournaments/{slug}
 *   GET /api/v1/tournaments/{slug}/matches
 *   GET /api/v1/tournaments/{slug}/standings
 * Authorization: Bearer <key of the organising space>. A tournament of another space answers 404.
 */
export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  let db;
  try {
    db = await getDb();
  } catch {
    return error(503, "unavailable", "The data service is unavailable.");
  }
  const auth = await authenticateKey(db, request.headers.get("authorization"));
  if (!auth.ok)
    return auth.status === 429
      ? error(429, auth.code, "Too many requests for this key; retry after the indicated number of seconds.", { "Retry-After": String(auth.retryAfter ?? 60) })
      : error(401, auth.code, "A valid API key is required: Authorization: Bearer <key>.", { "WWW-Authenticate": "Bearer" });
  const orgId = auth.auth.orgId;
  const [head, slug, sub, ...rest] = path;
  let data: unknown = null;
  if (rest.length) data = null;
  else if (head === "organization" && !slug) data = await apiOrganization(db, orgId);
  else if (head === "tournaments" && !slug) data = await apiTournaments(db, orgId);
  else if (head === "tournaments" && slug && !sub) data = await apiTournament(db, orgId, slug);
  else if (head === "tournaments" && slug && sub === "matches") data = await apiMatches(db, orgId, slug);
  else if (head === "tournaments" && slug && sub === "standings") data = await apiStandings(db, orgId, slug);
  if (data === null) return error(404, "not_found", "No such resource for this key.");
  return NextResponse.json({ data }, { headers });
}

const notAllowed = () => error(405, "method_not_allowed", "The API is read-only.", { Allow: "GET" });
export { notAllowed as POST, notAllowed as PUT, notAllowed as PATCH, notAllowed as DELETE };
