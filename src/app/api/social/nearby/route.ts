import {reportError} from "@/server/observability.ts";
import { jsonContext, json } from "@/server/json-api.ts";
import { saveNearby, disableNearby } from "@/server/social-nearby.ts";
import { errorCode } from "@/server/http.ts";
import { gate } from "@/server/system.ts";
import { fail } from "@/server/errors.ts";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const { db, user, data } = await jsonContext(request, "social.nearby_disable", 1024);
    if (data.action === "disable") return json(await disableNearby(db, user));
    if (data.action !== "enable") fail("invalid_input");
    await gate(db, "social.nearby_enable", user);
    return json(await saveNearby(db, user, data));
  } catch (error) {
    const code = errorCode(error);
    // Query diagnostics may contain a location. Never log request bodies or database errors here.
    if (code === "server_error") await reportError("social.nearby_failure",error);
    return json({ error: code }, code === "unauthorized" ? 401 : ["server_error", "db_unavailable"].includes(code) ? 503 : 400);
  }
}
