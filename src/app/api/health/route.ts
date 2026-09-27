import { NextResponse } from "next/server";
import { getDb, databaseUrl } from "@/server/db.ts";
import { ping } from "@/server/queries.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = await getDb();
    const latencyMs = await ping(db);
    return NextResponse.json(
      { status: "ok", database: db.kind, latencyMs, checkedAt: new Date().toISOString() },
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
