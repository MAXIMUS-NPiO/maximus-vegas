import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/server/db.ts";
import { sweepBroadcasts } from "@/server/broadcasts.ts";
import { syncBroadcastPayments } from "@/server/broadcast-payments.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Invoke every minute. Checkout is refused when this worker has no recent healthy heartbeat. */
export async function GET(request: Request) {
  const expected = Buffer.from(process.env.CRON_SECRET ?? "");
  const supplied = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  if (expected.length < 16 || supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const result = await sweepBroadcasts(db);
  // Closing expired rooms takes precedence over payment recovery.
  if (!("busy" in result)) await syncBroadcastPayments(db);
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
