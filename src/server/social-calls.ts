/** Mutual-match media control. Never stores media, permanent relay keys or SDP in audit/export. */
import { createHmac, randomBytes } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { fail } from "./errors.ts";
import { notify } from "./access.ts";

export const CALL_MINUTES = 30;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export type CallRow = { id: string; match_id: string; caller_id: string; callee_id: string; caller_client: string; callee_client: string | null; mode: "audio" | "video"; state: "ringing" | "accepted" | "ended"; reason: string; created_at: Date; accepted_at: Date | null; expires_at: Date; ended_at: Date | null; caller_seen: Date; callee_seen: Date };
function relaySettings() {
  const urls = (process.env.MV_TURN_URLS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const secret = process.env.MV_TURN_SECRET ?? "";
  const valid = (url: string) => {
    const match = /^turns?:([a-z0-9.-]+|\[[a-f0-9:]+\])(?::(\d{1,5}))?(?:\?transport=(udp|tcp))?$/i.exec(url);
    return Boolean(match && (!match[2] || Number(match[2]) >= 1 && Number(match[2]) <= 65535));
  };
  return urls.length > 0 && urls.length <= 4 && urls.every(valid) && secret.length >= 32 ? { urls, secret } : null;
}
export const socialCallsAvailable = () => Boolean(relaySettings());
export function callIceConfiguration(now = Date.now()) {
  const config = relaySettings() ?? fail("offer_unavailable");
  // Opaque per-response identity; credentials cannot disclose an account or match ID.
  const username = `${Math.floor(now / 1000) + (CALL_MINUTES + 2) * 60}:${randomBytes(12).toString("hex")}`;
  return { iceTransportPolicy: "relay" as const, iceServers: [{ urls: config.urls, username, credential: createHmac("sha1", config.secret).update(username).digest("base64") }] };
}
async function finish(q: Queryable, ids: string[], reason: string) {
  if (!ids.length) return;
  await q.query("update social_calls set state='ended',reason=$2,ended_at=now() where id=any($1::uuid[]) and state<>'ended'", [ids, reason]);
  await q.query("delete from social_call_signals where call_id=any($1::uuid[])", [ids]);
  await q.query("delete from social_call_members where call_id=any($1::uuid[])", [ids]);
}
/** Caller already holds the affected user lock(s), before any match/call lock. */
export async function endSocialCalls(q: Queryable, userId: string, matchId?: string, reason = "consent_closed") {
  const rows = await q.query<{ id: string }>("select id from social_calls where $1 in(caller_id,callee_id) and ($2::uuid is null or match_id=$2) and state<>'ended' order by id for update", [userId, matchId ?? null]);
  await finish(q, rows.map(r => r.id), reason);
}
async function eligible(q: Queryable, a: string, b: string) {
  const [r] = await q.query<{ n: number }>(`select count(*)::int as n from users u join social_profiles p on p.user_id=u.id
    where u.id=any($1::uuid[]) and u.status='active' and u.adult_confirmed_at is not null and p.visible and not p.suspended
    and not exists(select 1 from sanctions s where s.user_id=u.id and s.kind='suspension' and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now()))`, [[a, b]]);
  const blocked = (await q.query("select 1 from social_blocks where (user_id=$1 and subject_id=$2) or (user_id=$2 and subject_id=$1)", [a, b])).length;
  return r.n === 2 && !blocked;
}
function expired(c: CallRow, now: number) {
  return new Date(c.expires_at).getTime() <= now || (c.state === "accepted" && Math.min(new Date(c.caller_seen).getTime(), new Date(c.callee_seen).getTime()) < now - 30_000);
}
export type CallSignal = { id: string; kind: "offer" | "answer" | "ice"; payload: RTCSessionDescriptionInit | RTCIceCandidateInit };
export type CallView = { id: string; mode: "audio" | "video"; state: CallRow["state"]; reason: string; caller: boolean; owned: boolean; expiresAt: string };
export type CallResponse = { available: boolean; call: CallView | null; signals: CallSignal[]; ice?: ReturnType<typeof callIceConfiguration> };
function view(c: CallRow, userId: string, device: string): CallView {
  const caller = c.caller_id === userId;
  return { id: c.id, mode: c.mode, state: c.state, reason: c.reason, caller, owned: (caller ? c.caller_client : c.callee_client) === device, expiresAt: new Date(c.expires_at).toISOString() };
}
function signalPayload(kind: string, raw: unknown, mode: string) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("invalid_input");
  const p = raw as Record<string, unknown>;
  const relayCandidate = (s: string) => /^candidate:[\w+/.-]+ \d+ (?:udp|tcp) \d+ [\da-fA-F:.]+ \d+ typ relay(?: |$)/i.test(s) && !/[\r\n]/.test(s) && (!/ raddr /.test(s) || / raddr (?:0\.0\.0\.0|::) rport 0(?: |$)/.test(s));
  if (kind === "ice") {
    if (typeof p.candidate !== "string" || p.candidate.length > 4096 || !relayCandidate(p.candidate) || (p.sdpMid !== null && (typeof p.sdpMid !== "string" || p.sdpMid.length > 32)) || (p.sdpMLineIndex !== null && (!Number.isInteger(p.sdpMLineIndex) || Number(p.sdpMLineIndex) < 0 || Number(p.sdpMLineIndex) > 4))) fail("invalid_input");
    return { candidate: p.candidate, sdpMid: p.sdpMid, sdpMLineIndex: p.sdpMLineIndex };
  }
  if (p.type !== kind || typeof p.sdp !== "string" || p.sdp.length > 64000 || !p.sdp.startsWith("v=0\r\n") || !p.sdp.includes("a=fingerprint:sha-256 ") || !p.sdp.includes("m=audio ")) fail("invalid_input");
  const sdp = String(p.sdp);
  if (mode === "audio" && /^m=video /m.test(sdp)) fail("invalid_input");
  if (/^m=(?!audio |video )/m.test(sdp)) fail("invalid_input");
  for (const line of sdp.split(/\r?\n/)) if (line.startsWith("a=candidate:") && !relayCandidate(line.slice(2))) fail("invalid_input");
  return { type: kind, sdp };
}

/** Ordered user locks serialise starts across different matches and consent revocations. */
export async function socialCallAction(db: Database, user: SessionUser, input: Record<string, unknown>): Promise<CallResponse> {
  const action = String(input.action), matchId = uuid(input.matchId) ? input.matchId : fail("invalid_input"), device = uuid(input.device) ? input.device : fail("invalid_input");
  if (!uuid(matchId) || !uuid(device) || !["start", "poll", "accept", "decline", "end", "signal"].includes(action)) fail("invalid_input");
  if (action === "start" && !["audio", "video"].includes(String(input.mode))) fail("invalid_input");
  if (!["start", "poll"].includes(action) && !uuid(input.callId)) fail("invalid_input");
  if (input.callId !== undefined && !uuid(input.callId)) fail("invalid_input");
  const after = Number(input.after ?? 0); if (!Number.isSafeInteger(after) || after < 0) fail("invalid_input");
  return db.tx(async q => {
    const [initial] = await q.query<{ user_a: string; user_b: string }>("select user_a,user_b from social_matches where id=$1 and $2 in(user_a,user_b)", [matchId, user.id]);
    if (!initial) fail("not_found");
    const pair = [initial.user_a, initial.user_b].sort();
    await q.query("select id from users where id=any($1::uuid[]) order by id for update", [pair]);
    const [match] = await q.query<{ status: string }>("select status from social_matches where id=$1 for update", [matchId]);
    const [{ now }] = await q.query<{ now: Date }>("select now() as now");
    // Clear stale reservations of either participant, including calls in another match.
    const active = await q.query<CallRow>("select * from social_calls where state<>'ended' and (caller_id=any($1::uuid[]) or callee_id=any($1::uuid[])) order by id for update", [pair]);
    for (const row of active) if (expired(row, new Date(now).getTime())) await finish(q, [row.id], "expired");
    const allowed = match.status === "active" && !user.restricted && await eligible(q, pair[0], pair[1]);
    if (!allowed) await endSocialCalls(q, user.id, matchId);
    let [c] = await q.query<CallRow>(`select * from social_calls where match_id=$1 and ($2::uuid is null or id=$2) order by created_at desc,id desc limit 1`, [matchId, input.callId ?? null]);
    const available = socialCallsAvailable();
    if (action === "start") {
      if (!allowed || !available) return { available: available && allowed, call: c ? view(c, user.id, device) : null, signals: [] };
      const [old] = await q.query<CallRow>("select * from social_calls where caller_id=$1 and caller_client=$2", [user.id, device]);
      if (old) { if (old.match_id !== matchId || old.mode !== input.mode) fail("invalid_input"); c = old; }
      else {
        if ((await q.query("select 1 from social_call_members where user_id=any($1::uuid[])", [pair])).length) fail("session_overlap");
        const [count] = await q.query<{ n: number }>("select count(*)::int as n from social_calls where caller_id=$1 and created_at>now()-interval '1 hour'", [user.id]);
        if (count.n >= 20) fail("request_limit");
        [c] = await q.query<CallRow>("insert into social_calls(match_id,caller_id,callee_id,caller_client,mode) values($1,$2,$3,$4,$5) returning *", [matchId, user.id, pair.find(id => id !== user.id), device, input.mode]);
        for (const id of pair) await q.query("insert into social_call_members(user_id,call_id) values($1,$2)", [id, c.id]);
        await notify(q, [c.callee_id], "social_call", { socialMatchId: matchId });
      }
    }
    if (!c) { if (action !== "poll") fail("not_found"); return { available: available && allowed, call: null, signals: [] }; }
    if (!available && c.state !== "ended") { await finish(q, [c.id], "unavailable"); c.state = "ended"; c.reason = "unavailable"; }
    const caller = c.caller_id === user.id, owned = (caller ? c.caller_client : c.callee_client) === device;
    if (action === "decline" || action === "end") {
      if (action === "decline" && (caller || c.state !== "ringing" && c.state !== "ended")) fail("request_state");
      await finish(q, [c.id], action === "decline" ? "declined" : "ended");
    } else if (action === "accept") {
      if (caller) fail("forbidden");
      if (c.state === "ringing" && allowed && available) {
        [c] = await q.query<CallRow>("update social_calls set state='accepted',callee_client=$2,accepted_at=now(),caller_seen=now(),callee_seen=now(),expires_at=now()+interval '30 minutes' where id=$1 returning *", [c.id, device]);
      } else if (c.state === "accepted" && !owned) fail("session_overlap");
    } else if (action === "signal") {
      if (c.state !== "accepted" || !owned || !allowed) fail("request_state");
      const kind = String(input.kind), clientId = input.clientId;
      if (!uuid(clientId) || !["offer", "answer", "ice"].includes(kind)) fail("invalid_input");
      if (kind === "offer" && !caller || kind === "answer" && caller) fail("forbidden");
      const payload = signalPayload(kind, input.payload, c.mode);
      const [old] = await q.query<{ call_id: string; kind: string; payload: unknown }>("select call_id,kind,payload from social_call_signals where sender_id=$1 and client_id=$2", [user.id, clientId]);
      if (old) { if (old.call_id !== c.id || old.kind !== kind || JSON.stringify(old.payload) !== JSON.stringify(payload) && JSON.stringify(Object.entries(old.payload as object).sort()) !== JSON.stringify(Object.entries(payload).sort())) fail("invalid_input"); }
      else {
        const [n] = await q.query<{ n: number }>("select count(*)::int as n from social_call_signals where call_id=$1 and sender_id=$2", [c.id, user.id]);
        if (n.n >= 256) fail("request_limit");
        if (kind !== "ice" && (await q.query("select 1 from social_call_signals where call_id=$1 and kind=$2", [c.id, kind])).length) fail("request_state");
        await q.query("insert into social_call_signals(call_id,sender_id,kind,payload,client_id) values($1,$2,$3,$4,$5)", [c.id, user.id, kind, JSON.stringify(payload), clientId]);
      }
    }
    [c] = await q.query<CallRow>("select * from social_calls where id=$1", [c.id]);
    const result: CallResponse = { available: available && allowed, call: view(c, user.id, device), signals: [] };
    if (c.state === "accepted" && result.call!.owned && allowed) {
      if (action === "poll" || action === "accept" || action === "start") {
        await q.query(`update social_calls set ${caller ? "caller_seen" : "callee_seen"}=now() where id=$1`, [c.id]);
        result.signals = await q.query<CallSignal>("select s.id::text as id,s.kind,s.payload from social_call_signals s where s.call_id=$1 and s.sender_id<>$2 and s.id>$3 order by s.id limit 256", [c.id, user.id, after]);
        result.ice = callIceConfiguration();
      }
    }
    return result;
  });
}

/** A scheduled sweep removes signalling when nobody returns to the conversation. */
export async function expireSocialCalls(db: Database) {
  const rows = await db.query<{ id: string; caller_id: string; callee_id: string }>("select id,caller_id,callee_id from social_calls where state<>'ended' and (expires_at<=now() or (state='accepted' and least(caller_seen,callee_seen)<now()-interval '30 seconds')) order by id limit 100");
  for (const row of rows) await db.tx(async q => {
    await q.query("select id from users where id=any($1::uuid[]) order by id for update", [[row.caller_id, row.callee_id].sort()]);
    const [c] = await q.query<CallRow>("select * from social_calls where id=$1 for update", [row.id]);
    const [{ now }] = await q.query<{ now: Date }>("select now() as now");
    if (c.state !== "ended" && expired(c, new Date(now).getTime())) await finish(q, [c.id], "expired");
  });
  return rows.length;
}
