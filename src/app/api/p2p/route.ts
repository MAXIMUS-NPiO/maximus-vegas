import { json, jsonContext, jsonError } from "@/server/json-api.ts";
import * as p2p from "@/server/p2p.ts";
import { fail } from "@/server/errors.ts";
import { requireStaffMfa } from "@/server/mfa.ts";
export async function POST(request: Request) {
  try {
    const { db, user, data: d } = await jsonContext(request, "p2p.session");
    const id = String(d.id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) fail("invalid_input");
    if (d.action === "host.beat") { await p2p.hostHeartbeat(db, user, id, d.online === true); return json({ ok: true }); }
    if (d.action === "host.key") { await requireStaffMfa(db, user); return json({ token: await p2p.rotateHostKey(db, user, id, d.revoke === true) }); }
    if (d.action === "accept") { await p2p.answerSession(db, user, id, d.accept === true); return json({ ok: true }); }
    if (d.action === "signal") { await p2p.addSignal(db, user, id, String(d.kind), d.payload, String(d.clientId)); return json({ ok: true }); }
    if (d.action === "poll") return json(await p2p.pollSession(db, user, id, Number(d.cursor ?? 0), d.connected === true));
    if (d.action === "finish") { await p2p.finishSession(db, user, id, d.confirm === true, d.rating, d.problem); return json({ ok: true }); }
    return fail("invalid_input");
  } catch (error) { return jsonError(error); }
}
