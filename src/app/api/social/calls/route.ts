import {reportError} from "@/server/observability.ts";
import { jsonContext, json } from "@/server/json-api.ts";
import { socialCallAction } from "@/server/social-calls.ts";
import { errorCode } from "@/server/http.ts";
import { gate } from "@/server/system.ts";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    // End/decline remain reachable during maintenance; other operations have their own gate.
    const { db, user, data } = await jsonContext(request, "social.call_end", 80_000);
    const action = String(data.action);
    if (!["end", "decline"].includes(action)) await gate(db, action === "start" ? "social.call_start" : action === "accept" ? "social.call_accept" : "social.call_poll", user);
    return json(await socialCallAction(db, user, data));
  } catch (error) {
    // Database diagnostics can contain signal payloads; keep them out of application logs.
    const code = errorCode(error);
    if (code === "server_error") await reportError("social.call_failure",error);
    return json({ error: code }, code === "unauthorized" ? 401 : ["server_error", "db_unavailable"].includes(code) ? 503 : 400);
  }
}
