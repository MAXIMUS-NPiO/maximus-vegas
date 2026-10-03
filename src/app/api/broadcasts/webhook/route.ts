import { getDb } from "@/server/db.ts";
import { verifyBroadcastWebhook } from "@/server/broadcast-provider.ts";
import { reconcileBroadcast } from "@/server/broadcasts.ts";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return new Response("Invalid body", { status: 400 });
  const chunks: Uint8Array[] = []; let bytes = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    bytes += value.length;
    if (bytes > 512000) { await reader.cancel(); return new Response("Too large", { status: 413 }); }
    chunks.push(value);
  }
  let event;
  try { event = await verifyBroadcastWebhook(Buffer.concat(chunks).toString("utf8"), request.headers.get("authorization")); }
  catch { return new Response("Invalid signature", { status: 401 }); }
  const room = event.room?.name ?? event.egressInfo?.roomName;
  if (room?.startsWith("mv-broadcast-")) {
    const db = await getDb();
    const [b] = await db.query<{ id: string }>("select id from native_broadcasts where room_name=$1", [room]);
    if (b) {
      try { await reconcileBroadcast(db, b.id); }
      catch { return new Response("Retry", { status: 503 }); }
    }
  }
  return new Response("OK", { headers: { "Cache-Control": "no-store" } });
}
