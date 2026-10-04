import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/server/db.ts";
import { syncExperience } from "@/server/player-experience.ts";
import { featureEnabled, maintenanceState, recordRun } from "@/server/system.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  const expected = Buffer.from(process.env.CRON_SECRET ?? ""), supplied = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  if (expected.length < 16 || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return new Response("Not found", { status: 404 });
  const headers = { "Cache-Control": "no-store" };
  try {
    const db = await getDb();
    if ((await maintenanceState(db)).on || !(await featureEnabled(db, "integrations"))) return Response.json({ paused: true }, { headers });
    const result = await syncExperience(db);
    await recordRun(db, "experience", result);
    return Response.json(result, { headers });
  } catch { return Response.json({ error: "sync_failed" }, { status: 503, headers }); }
}
