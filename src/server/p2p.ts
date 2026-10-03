import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { activeAccount } from "./product-access.ts";
import { requireSection } from "./access.ts";
import { fail } from "./errors.ts";
import { audit } from "./audit.ts";
import { moveCoins } from "./progression.ts";
import * as v from "./validate.ts";
import { isGame } from "../lib/games.ts";

export type Host = { id: string; owner_id: string; name: string; region: string; cpu: string; gpu: string; ram_gb: number; games: string[]; status: string; review_note: string; online: boolean; heartbeat_at: Date | null };
export type PeerSession = { id: string; host_id: string; owner_id: string; client_id: string; game: string; status: string; created_at: Date; expires_at: Date; started_at: Date | null; host_seen: Date | null; client_seen: Date | null; host_confirmed: boolean; client_confirmed: boolean; connected_seconds: number; rewarded: boolean; name: string };
export const P2P_GAME = "maximus-arena";
const uuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const live = (s: string) => ["requested", "connecting", "active"].includes(s);
export async function registerHost(db: Database, user: SessionUser, input: Record<string, unknown>, games: string[]) {
  if (!v.bool(input.consent)) fail("consent_required");
  const selected = [...new Set(games)]; if (!selected.length || selected.length > 20 || selected.some(g => g !== P2P_GAME && !isGame(g))) fail("invalid_game");
  const name = v.displayName(input.name, 80), cpu = v.displayName(input.cpu, 100), gpu = v.displayName(input.gpu, 100), region = v.displayName(input.region, 60), ram = v.intIn(input.ram, 2, 2048);
  return db.tx(async q => {
    await activeAccount(q, user); await q.query("select id from users where id=$1 for update", [user.id]);
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from p2p_hosts where owner_id=$1", [user.id]); if (n.n >= 10) fail("request_limit");
    const [h] = await q.query<{ id: string }>("insert into p2p_hosts(owner_id,name,region,cpu,gpu,ram_gb,games) values($1,$2,$3,$4,$5,$6,$7) returning id", [user.id, name, region, cpu, gpu, ram, selected]);
    await audit(q, { actorId: user.id, action: "p2p.host_registered", entity: "p2p_host", entityId: h.id }); return h.id;
  });
}
export async function reviewHost(db: Database, staff: SessionUser, hostId: string, decision: string, note: string) {
  requireSection(staff, "system"); if (!["approved", "suspended"].includes(decision) || note.trim().length < 10) fail("invalid_input");
  await db.tx(async q => {
    const [h] = await q.query<Host>("select * from p2p_hosts where id=$1 for update", [hostId]); if (!h) fail("not_found");
    if (h.owner_id === staff.id) fail("cannot_modify_self");
    await q.query("update p2p_hosts set status=$2,review_note=$3,reviewed_by=$4,reviewed_at=now(),online=false,agent_key_hash=null where id=$1", [hostId, decision, v.clean(note, 1000), staff.id]);
    await q.query("update p2p_sessions set status='failed',ended_at=now() where host_id=$1 and status in('requested','connecting','active')", [hostId]);
    await audit(q, { actorId: staff.id, action: "p2p.host_reviewed", entity: "p2p_host", entityId: hostId, data: { decision } });
  });
}
async function ownedHost(q: Queryable, user: SessionUser, hostId: string, approved = true) {
  const [h] = await q.query<Host>("select * from p2p_hosts where id=$1 and owner_id=$2", [hostId, user.id]);
  if (!h) fail("not_found"); if (approved && h.status !== "approved") fail("feature_disabled"); return h;
}
export async function hostHeartbeat(db: Database, user: SessionUser, hostId: string, online: boolean) {
  await db.tx(async q => {
    await activeAccount(q, user); await ownedHost(q, user, hostId);
    await q.query("update p2p_hosts set online=$2,heartbeat_at=now() where id=$1", [hostId, online]);
    if (!online) await q.query("update p2p_sessions set status='failed',ended_at=now() where host_id=$1 and status in('requested','connecting','active')", [hostId]);
  });
}
export async function rotateHostKey(db: Database, user: SessionUser, hostId: string, revoke = false) {
  const token = `mvh_${randomBytes(32).toString("base64url")}`;
  await db.tx(async q => {
    await activeAccount(q, user); await ownedHost(q, user, hostId);
    await q.query("update p2p_hosts set agent_key_hash=$2,online=false where id=$1", [hostId, revoke ? null : createHash("sha256").update(token).digest("hex")]);
    await q.query("update p2p_sessions set status='failed',ended_at=now() where host_id=$1 and status in('requested','connecting','active')", [hostId]);
    await audit(q, { actorId: user.id, action: "p2p.host_key_rotated", entity: "p2p_host", entityId: hostId });
  });
  return revoke ? null : token;
}
export async function authenticateHost(q: Queryable, token: string) {
  if (!/^mvh_[a-z0-9_-]{43}$/i.test(token)) return fail("unauthorized");
  const [h] = await q.query<Host & { username: string; display_name: string; email: string }>("select h.*,u.username,u.display_name,u.email from p2p_hosts h join users u on u.id=h.owner_id where h.agent_key_hash=$1 and h.status='approved' and u.status='active'", [createHash("sha256").update(token).digest("hex")]);
  if (!h) return fail("unauthorized");
  const user: SessionUser = { id: h.owner_id, email: h.email, username: h.username, displayName: h.display_name, sessionId: "host-agent", roles: [] };
  return { host: h, user };
}
export async function expireSessions(q: Queryable) {
  await q.query(`update p2p_sessions set status='failed',ended_at=now() where status in('requested','connecting','active') and
    (expires_at<now() or (status='requested' and created_at<now()-interval '2 minutes') or (status='connecting' and created_at<now()-interval '5 minutes')
    or (status='active' and (host_seen<now()-interval '90 seconds' or client_seen<now()-interval '90 seconds')))`);
  await q.query("delete from p2p_signals where created_at<now()-interval '24 hours'");
}
export async function allocateHost(db: Database, user: SessionUser, game: string, region: string, consent: boolean) {
  if (!consent) fail("consent_required"); if (game !== P2P_GAME && !isGame(game)) fail("invalid_game");
  return db.tx(async q => {
    await activeAccount(q, user); await expireSessions(q);
    await q.query("select id from users where id=$1 for update", [user.id]);
    if ((await q.query("select 1 from p2p_sessions where client_id=$1 and status in('requested','connecting','active')", [user.id]))[0]) fail("request_exists");
    const [h] = await q.query<Host>(`select h.* from p2p_hosts h join users u on u.id=h.owner_id
      where h.status='approved' and h.online and h.heartbeat_at>now()-interval '45 seconds' and h.owner_id<>$1 and u.status='active'
      and $2=any(h.games) and ($3='' or lower(h.region)=lower($3))
      and not exists(select 1 from p2p_sessions s where s.host_id=h.id and s.status in('requested','connecting','active'))
      order by h.heartbeat_at desc,h.id limit 1 for update of h skip locked`, [user.id, game, v.oneLine(region, 60)]);
    if (!h) fail("offer_unavailable");
    const [s] = await q.query<{ id: string }>("insert into p2p_sessions(host_id,client_id,game,expires_at) values($1,$2,$3,now()+interval '1 hour') returning id", [h.id, user.id, game]);
    await audit(q, { actorId: user.id, action: "p2p.session_requested", entity: "p2p_session", entityId: s.id }); return s.id;
  });
}
export async function peerSession(q: Queryable, user: SessionUser, id: string, lock = false) {
  if (!uuid(id)) return fail("invalid_input");
  const [s] = await q.query<PeerSession>(`select s.*,h.owner_id,h.name from p2p_sessions s join p2p_hosts h on h.id=s.host_id where s.id=$1 and $2 in(s.client_id,h.owner_id) ${lock ? "for update of s" : ""}`, [id, user.id]);
  if (!s) return fail("not_found"); return { ...s, role: s.owner_id === user.id ? "host" as const : "client" as const };
}
export async function answerSession(db: Database, user: SessionUser, id: string, accept: boolean) {
  await db.tx(async q => {
    await activeAccount(q, user); await expireSessions(q); const s = await peerSession(q, user, id, true);
    if (s.role !== "host") fail("forbidden"); if (s.status !== "requested") fail("request_state");
    await ownedHost(q, user, s.host_id);
    await q.query("update p2p_sessions set status=$2,host_seen=now(),client_seen=now(),ended_at=case when $2='rejected' then now() else null end where id=$1", [id, accept ? "connecting" : "rejected"]);
  });
}
export function iceConfiguration(userId: string, now = Date.now()): RTCConfiguration {
  const iceServers: RTCIceServer[] = [], stun = (process.env.MV_STUN_URLS ?? "").split(",").map(s => s.trim()).filter(s => /^stuns?:[^\s]+$/.test(s));
  if (stun.length) iceServers.push({ urls: stun });
  const turn = (process.env.MV_TURN_URLS ?? "").split(",").map(s => s.trim()).filter(s => /^turns?:[^\s]+$/.test(s)), secret = process.env.MV_TURN_SECRET;
  if (turn.length && secret && secret.length >= 32) {
    const username = `${Math.floor(now / 1000) + 7200}:${userId}`;
    iceServers.push({ urls: turn, username, credential: createHmac("sha1", secret).update(username).digest("base64") });
  }
  return { iceServers, iceTransportPolicy: process.env.MV_RELAY_ONLY === "1" ? "relay" : "all" };
}
export async function addSignal(db: Database, user: SessionUser, sessionId: string, kind: string, payload: unknown, clientId: string) {
  if (!["offer", "answer", "ice"].includes(kind) || !uuid(clientId) || !payload || typeof payload !== "object" || Array.isArray(payload) || JSON.stringify(payload).length > 64000) fail("invalid_input");
  const value = payload as Record<string, unknown>;
  if (kind === "ice" ? typeof value.candidate !== "string" || value.candidate.length > 4000 : value.type !== kind || typeof value.sdp !== "string" || !value.sdp.startsWith("v=0")) fail("invalid_input");
  await db.tx(async q => {
    await activeAccount(q, user); const s = await peerSession(q, user, sessionId, true);
    if (!["connecting", "active"].includes(s.status) || new Date(s.expires_at).getTime() <= Date.now()) fail("request_state");
    if ((kind === "offer" && s.role !== "host") || (kind === "answer" && s.role !== "client")) fail("forbidden");
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from p2p_signals where session_id=$1 and sender=$2", [sessionId, s.role]);
    if (n.n >= 256) fail("request_limit");
    await q.query("insert into p2p_signals(session_id,sender,kind,payload,client_id) values($1,$2,$3,$4,$5) on conflict do nothing", [sessionId, s.role, kind, JSON.stringify(payload), clientId]);
  });
}
export async function pollSession(db: Database, user: SessionUser, id: string, cursor: number, connected: boolean) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) fail("invalid_input");
  return db.tx(async q => {
    await activeAccount(q, user); await expireSessions(q); let s = await peerSession(q, user, id, true);
    if (live(s.status)) {
      // Preserve fractional seconds between polls; rounding every heartbeat would inflate usage.
      const eligible = "status='active' and host_connected and client_connected and $2 and host_seen>now()-interval '20 seconds' and client_seen>now()-interval '20 seconds'";
      const elapsed = "least(20,greatest(0,floor(extract(epoch from now()-coalesce(metered_at,now())))::int))";
      await q.query(`update p2p_sessions set connected_seconds=connected_seconds+case when ${eligible} then ${elapsed} else 0 end,
        metered_at=case when ${eligible} then greatest(coalesce(metered_at,now()),now()-interval '20 seconds')+make_interval(secs=>${elapsed}) else now() end where id=$1`, [id, connected]);
      await q.query(`update p2p_sessions set ${s.role}_seen=now(),${s.role}_connected=$2 where id=$1`, [id, connected]);
      if (s.role === "host") await q.query("update p2p_hosts set heartbeat_at=now() where id=$1", [s.host_id]);
      await q.query(`update p2p_sessions set status=case when host_connected and client_connected and status='connecting' then 'active' else status end,
        started_at=case when host_connected and client_connected then coalesce(started_at,now()) else started_at end where id=$1`, [id]);
      s = await peerSession(q, user, id);
    }
    const signals = live(s.status) ? await q.query<{ id: string; kind: string; payload: Record<string, unknown> }>("select id,kind,payload from p2p_signals where session_id=$1 and sender<>$2 and id>$3 order by id limit 100", [id, s.role, cursor]) : [];
    return { session: s, signals };
  });
}
export async function finishSession(db: Database, user: SessionUser, id: string, confirm: boolean, feedback?: unknown, problem?: unknown) {
  await db.tx(async q => {
    const s = await peerSession(q, user, id, true);
    if (s.status === "rejected" || s.status === "failed") return;
    await q.query(`update p2p_sessions set status='ended',ended_at=coalesce(ended_at,now()),${s.role}_confirmed=$2,
      feedback=case when $3::int is not null then $3 else feedback end,problem=case when $4<>'' then $4 else problem end where id=$1`,
      [id, confirm, s.role === "client" && feedback ? v.intIn(feedback, 1, 5) : null, v.clean(problem, 1000)]);
    const row = await peerSession(q, user, id);
    if (row.host_confirmed && row.client_confirmed && row.connected_seconds >= 300 && !row.rewarded) {
      await q.query("select id from users where id=$1 for update", [row.owner_id]);
      // A bounded contribution credit, not payment or a claim of income. Both participants confirm delivery.
      const [n] = await q.query<{ n: number }>("select count(*)::int as n from p2p_sessions s join p2p_hosts h on h.id=s.host_id where h.owner_id=$1 and s.rewarded and s.ended_at>=date_trunc('day',now())", [row.owner_id]);
      const day = new Date().toISOString().slice(0, 10);
      if (n.n < 5) {
        const credited = await moveCoins(q, row.owner_id, 5, "host_contribution", id, `p2p:${row.owner_id}:${row.client_id}:${day}`);
        if (credited) await q.query("update p2p_sessions set rewarded=true where id=$1", [id]);
      }
    }
    await audit(q, { actorId: user.id, action: "p2p.session_ended", entity: "p2p_session", entityId: id, data: { confirmed: confirm } });
  });
}
export async function p2pOverview(q: Queryable, userId?: string) {
  await expireSessions(q);
  const available = await q.query<Pick<Host, "id" | "name" | "region" | "cpu" | "gpu" | "ram_gb" | "games">>(`select h.id,h.name,h.region,h.cpu,h.gpu,h.ram_gb,h.games from p2p_hosts h join users u on u.id=h.owner_id where h.status='approved' and h.online and h.heartbeat_at>now()-interval '45 seconds' and u.status='active'
    and not exists(select 1 from p2p_sessions s where s.host_id=h.id and s.status in('requested','connecting','active')) order by h.region,h.name limit 100`);
  const mine = userId ? await q.query<Host>("select id,owner_id,name,region,cpu,gpu,ram_gb,games,status,review_note,online,heartbeat_at from p2p_hosts where owner_id=$1 order by created_at", [userId]) : [];
  const sessions = userId ? await q.query<PeerSession>("select s.*,h.owner_id,h.name from p2p_sessions s join p2p_hosts h on h.id=s.host_id where $1 in(s.client_id,h.owner_id) order by s.created_at desc limit 40", [userId]) : [];
  return { available, mine, sessions };
}
export async function eraseP2p(q: Queryable, userId: string) {
  await q.query("delete from p2p_signals where session_id in(select s.id from p2p_sessions s join p2p_hosts h on h.id=s.host_id where $1 in(s.client_id,h.owner_id))", [userId]);
  await q.query("update p2p_sessions set status=case when status in('requested','connecting','active') then 'failed' else status end,problem='' where client_id=$1 or host_id in(select id from p2p_hosts where owner_id=$1)", [userId]);
  await q.query("update p2p_hosts set name='Deleted host',cpu='',gpu='',region='',status='suspended',online=false,agent_key_hash=null,review_note='' where owner_id=$1", [userId]);
}
