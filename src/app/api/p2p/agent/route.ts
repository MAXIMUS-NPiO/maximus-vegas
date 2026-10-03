import { json, readJsonBody, jsonError } from "@/server/json-api.ts";
import { getDb } from "@/server/db.ts";
import * as p2p from "@/server/p2p.ts";
import { fail } from "@/server/errors.ts";
import { gate } from "@/server/system.ts";
export async function POST(request: Request) {
  try {
    const d = await readJsonBody(request), db = await getDb();
    const { host, user } = await p2p.authenticateHost(db, (request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
    await gate(db, "p2p.session", user);
    if (d.action === "host.beat") {
      await p2p.hostHeartbeat(db, user, host.id, d.online === true); await p2p.expireSessions(db);
      const sessions = await db.query<{ id: string; game: string; status: string }>("select id,game,status from p2p_sessions where host_id=$1 and status in('requested','connecting','active') order by created_at", [host.id]);
      return json({ sessions, configuration: p2p.iceConfiguration(user.id) });
    }
    const id = String(d.id ?? ""), session = await p2p.peerSession(db, user, id);
    if (session.host_id !== host.id) fail("forbidden");
    if (d.action === "accept") await p2p.answerSession(db, user, id, d.accept === true);
    else if (d.action === "signal") await p2p.addSignal(db, user, id, String(d.kind), d.payload, String(d.clientId));
    else if (d.action === "poll") return json(await p2p.pollSession(db, user, id, Number(d.cursor ?? 0), d.connected === true));
    else if (d.action === "finish") await p2p.finishSession(db, user, id, d.confirm === true, undefined, d.problem);
    else fail("invalid_input");
    return json({ ok: true });
  } catch (error) { return jsonError(error); }
}
