import { json, jsonContext } from "@/server/json-api.ts";
import { gate } from "@/server/system.ts";
import { errorCode } from "@/server/http.ts";
import { fail } from "@/server/errors.ts";
import { roomScope, roomMessages, sendRoomMessage, deleteRoomMessage, reportRoomMessage } from "@/server/community.ts";
import { blockProfile } from "@/server/social.ts";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const { db, user, data } = await jsonContext(request, "community.read", 12000);
    const action = String(data.action), room = roomScope(data.scope, data.id);
    if (!["read", "send", "delete", "report", "block"].includes(action)) fail("invalid_input");
    await gate(db, `community.${action}`, user);
    if (action === "send") await sendRoomMessage(db, user, room, data.body, String(data.clientId));
    if (action === "delete") await deleteRoomMessage(db, user, String(data.messageId));
    if (action === "report") await reportRoomMessage(db, user, String(data.messageId), data.reason);
    if (action === "block") await blockProfile(db, user, String(data.subject));
    if (user.restricted && ["delete", "report", "block"].includes(action)) return json({ messages: [] });
    return json({ messages: await roomMessages(db, user, room, Number(data.before ?? 0)) });
  } catch (error) {
    const code = errorCode(error); if (code === "server_error") console.error("[community] request failed");
    return json({ error: code }, code === "unauthorized" ? 401 : code === "forbidden" ? 403 : code === "server_error" || code === "db_unavailable" ? 503 : 400);
  }
}
