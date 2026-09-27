import { getDb } from "@/server/db.ts";
import { SESSION_COOKIE, sessionUser } from "@/server/auth.ts";
import { parseCookies } from "@/server/http.ts";
import { canSeeEvidence } from "@/server/media.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
};

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const [row] = await db.query<{ kind: string; content_type: string; data: Uint8Array; sha256: string }>(
    "select kind, content_type, data, sha256 from media where id = $1",
    [id],
  );
  if (!row) return new Response("Not found", { status: 404 });
  if (row.kind === "evidence") {
    const user = await sessionUser(db, parseCookies(request.headers.get("cookie"))[SESSION_COOKIE]);
    if (!(await canSeeEvidence(db, id, user))) return new Response("Not found", { status: 404 });
    return new Response(Buffer.from(row.data), { headers: { ...HEADERS, "Content-Type": row.content_type, "Cache-Control": "private, no-store" } });
  }
  return new Response(Buffer.from(row.data), {
    headers: { ...HEADERS, "Content-Type": row.content_type, "Cache-Control": "public, max-age=31536000, immutable", ETag: `"${row.sha256}"` },
  });
}
