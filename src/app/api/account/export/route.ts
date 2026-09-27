import { exportAccount, SESSION_COOKIE, sessionUser } from "@/server/auth.ts";
import { getDb } from "@/server/db.ts";
import { parseCookies } from "@/server/http.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const db = await getDb();
  const user = await sessionUser(db, parseCookies(request.headers.get("cookie"))[SESSION_COOKIE]);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  const data = await exportAccount(db, user);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="maximus-vegas-${user.username}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
