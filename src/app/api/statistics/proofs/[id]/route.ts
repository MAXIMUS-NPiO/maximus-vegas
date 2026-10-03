import { getDb } from "@/server/db.ts";
import { SESSION_COOKIE, sessionUser } from "@/server/auth.ts";
import { parseCookies } from "@/server/http.ts";
import { json, jsonError } from "@/server/json-api.ts";
import { snapshotProof } from "@/server/statistics.ts";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const db = await getDb(), user = await sessionUser(db, parseCookies(request.headers.get("cookie"))[SESSION_COOKIE]);
    const { id } = await params, record = new URL(request.url).searchParams.get("record"), proof = await snapshotProof(db, id, user?.id, record === null ? undefined : Number(record));
    if (!proof) return json({ error: "not_found" }, 404);
    const response = json(proof); response.headers.set("Content-Disposition", `attachment; filename="maximus-proof-${id}.json"`); return response;
  } catch (error) { return jsonError(error); }
}
