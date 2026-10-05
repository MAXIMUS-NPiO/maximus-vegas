import { getDb } from "@/server/db.ts";
import { sessionUser, SESSION_COOKIE } from "@/server/auth.ts";
import { parseCookies } from "@/server/http.ts";
import { experienceExport } from "@/server/player-experience.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  try {
    const db = await getDb(), user = await sessionUser(db, parseCookies(request.headers.get("cookie"))[SESSION_COOKIE]);
    if (!user) return Response.json({ error: "unauthorized" }, { status: 401, headers });
    return Response.json(await experienceExport(db, user.id), { headers: { ...headers, "Content-Disposition": "attachment; filename=maximus-player-experience.json" } });
  } catch { return Response.json({ error: "server_error" }, { status: 503, headers }); }
}
