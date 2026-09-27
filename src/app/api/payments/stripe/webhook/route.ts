import { getDb } from "@/server/db.ts";
import { handleProviderWebhook } from "@/server/billing.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Stripe webhook endpoint. The signature is verified by the Stripe SDK over the exact raw body; nothing
 * is parsed or trusted before that. Duplicates are acknowledged without re-processing.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > 512 * 1024) return new Response("payload too large", { status: 413 });
  try {
    const db = await getDb();
    const result = await handleProviderWebhook(db, raw, request.headers.get("stripe-signature"));
    return new Response(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[webhook]", (error as Error).message);
    return new Response("error", { status: 500 });
  }
}
