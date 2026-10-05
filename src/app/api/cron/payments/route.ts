import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/server/db.ts";
import { reconcileMpgsPayments } from "@/server/payments/mpgs-reconcile.ts";
import { recordRun } from "@/server/system.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim() ?? "";
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(given), b = Buffer.from(secret);
  if (b.length < 16 || a.length !== b.length || !timingSafeEqual(a, b)) return new Response("Not found", { status: 404 });
  const db = await getDb(), result = await reconcileMpgsPayments(db);
  await recordRun(db, "payments", result);
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
