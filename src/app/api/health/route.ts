import { NextResponse } from "next/server";
import { getDb, databaseUrl } from "@/server/db.ts";
import { ping } from "@/server/queries.ts";
import { mailConfigured } from "@/server/mail.ts";
import { paymentReadiness, publicOffer } from "@/server/billing.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = await getDb();
    const latencyMs = await ping(db);
    // Minimal public readiness: states only, never reasons, keys or infrastructure details.
    const pay = paymentReadiness(await publicOffer(db).catch(() => null));
    return NextResponse.json(
      {
        status: "ok",
        database: db.kind,
        latencyMs,
        email: mailConfigured() ? "connected" : "not_connected",
        payments: pay.ready ? pay.mode : "off",
        checkedAt: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        status: "degraded",
        database: databaseUrl() ? "unreachable" : "not_configured",
        error: (error as Error).name,
        checkedAt: new Date().toISOString(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
