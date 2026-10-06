import {reportError} from "@/server/observability.ts";
import { json, jsonContext } from "@/server/json-api.ts";
import { errorCode } from "@/server/http.ts";
import { broadcastAvailability, broadcastQuote } from "@/server/broadcast-config.ts";
import { myBroadcasts, startBroadcast, stopBroadcast, archiveDownload, broadcastHeartbeat, broadcastToken, limitBroadcastAction } from "@/server/broadcasts.ts";
import { createBroadcastCheckout, resumeBroadcastCheckout, syncBroadcastPayments } from "@/server/broadcast-payments.ts";

export const runtime = "nodejs";
export const maxDuration = 60;
const actions = new Set(["status", "quote", "checkout", "resume", "start", "token", "watch", "heartbeat", "stop", "delete", "download"]);
export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (!actions.has(action)) return json({ error: "not_found" }, 404);
  try {
    const { db, user, data } = await jsonContext(request, ["start", "checkout", "resume", "watch", "token"].includes(action) ? `broadcast.${action}` : "broadcast.status", 16000);
    await limitBroadcastAction(db, user.id, action);
    switch (action) {
      case "status": {
        await syncBroadcastPayments(db, user.id);
        const [availability, broadcasts] = await Promise.all([broadcastAvailability(db), myBroadcasts(db, user.id)]);
        return json({ ...availability, broadcasts });
      }
      case "quote": {
        const a = await broadcastAvailability(db);
        return json({ ready: a.ready, quote: a.tariff ? broadcastQuote(data, a.tariff) : null });
      }
      case "checkout": return json(await createBroadcastCheckout(db, user, data, data.lang === "en" ? "en" : "ru"));
      case "resume": return json(await resumeBroadcastCheckout(db, user, data.id));
      case "start": return json(await startBroadcast(db, user, data.id));
      case "token": return json(await broadcastToken(db, user, data.id, true));
      case "watch": return json(await broadcastToken(db, user, data.id));
      case "heartbeat": return json(await broadcastHeartbeat(db, user, data.id));
      case "stop": return json(await stopBroadcast(db, user, data.id));
      case "delete": return json(await stopBroadcast(db, user, data.id, true));
      case "download": return json(await archiveDownload(db, user, data.id));
    }
  } catch (error) {
    const code = errorCode(error);
    if (code === "server_error") await reportError("broadcast.failure",error);
    return json({ error: code }, code === "unauthorized" ? 401 : code === "forbidden" ? 403 : ["server_error", "db_unavailable", "provider_error"].includes(code) ? 503 : 400);
  }
}
