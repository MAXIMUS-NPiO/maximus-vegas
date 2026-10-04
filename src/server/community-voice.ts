import { randomUUID } from "node:crypto";
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { communityRoom, type RoomScope } from "./community.ts";
import { featureEnabled, maintenanceState, recordRun } from "./system.ts";
import { fail } from "./errors.ts";

export function voiceConfig() {
  const url = process.env.LIVEKIT_URL ?? ""; let valid = false;
  try { const u = new URL(url); valid = u.protocol === "wss:" && u.hostname.endsWith(".livekit.cloud") && !u.port && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash; } catch { /* not configured */ }
  return { ready: valid && !!process.env.LIVEKIT_API_KEY && !!process.env.LIVEKIT_API_SECRET, url, key: process.env.LIVEKIT_API_KEY ?? "", secret: process.env.LIVEKIT_API_SECRET ?? "" };
}
export interface VoiceProvider {
  create(name: string): Promise<void>; revoke(name: string, identity: string): Promise<void>;
  close(name: string): Promise<void>; token(name: string, identity: string): Promise<string>; healthy(): Promise<void>;
}
export function liveVoiceProvider(): VoiceProvider {
  const c = voiceConfig(); if (!c.ready) return fail("feature_disabled");
  const api = new RoomServiceClient(c.url.replace(/^wss:/,"https:"), c.key, c.secret, { requestTimeout: 5 });
  return {
    async create(name) { await api.createRoom({ name, maxParticipants: 8, emptyTimeout: 90, departureTimeout: 30 }); },
    async revoke(name, identity) { await api.removeParticipant(name, identity, { revokeTokenTs: BigInt(Math.floor(Date.now()/1000)+30) }); },
    async close(name) { if ((await api.listRooms([name])).length) await api.deleteRoom(name); },
    async token(name, identity) { const t = new AccessToken(c.key, c.secret, { identity, ttl: 60 }); t.addGrant({ room: name, roomJoin: true, canPublish: true, canSubscribe: true, canPublishSources: [TrackSource.MICROPHONE], canPublishData: false, canUpdateOwnMetadata: false }); return t.toJwt(); },
    async healthy() { await api.listRooms(["mv-community-health"]); },
  };
}
export async function voiceAvailable(q: Queryable) {
  const [run] = await q.query<{ last_at: Date; result: { healthy?: boolean } }>("select last_at,result from system_runs where name='community_voice'");
  return process.env.MV_COMMUNITY_VOICE_ENABLED === "1" && voiceConfig().ready && !!run && run.result.healthy === true && Date.now()-new Date(run.last_at).getTime()<150000 && await featureEnabled(q,"connections") && !(await maintenanceState(q)).on;
}
type VoiceRoom = { id: string; scope: RoomScope["scope"]; scope_id: string | null; state: string; expires_at: Date; created_at: Date; cleanup_until: Date | null };
const roomName = (id: string) => `mv-community-${id}`;
async function lockLobby(q: Queryable) {
  const [r] = await q.query<{ busy: boolean }>("select lease_until>now() as busy from community_voice_worker where id=true for update");
  if (r.busy) fail("request_state");
}
async function compatible(q: Queryable, userId: string, roomId: string) {
  if ((await q.query(`select 1 from community_voice_seats s join social_blocks b on (b.user_id=$1 and b.subject_id=s.user_id) or (b.subject_id=$1 and b.user_id=s.user_id)
    where s.room_id=$2 and s.state<>'left'`, [userId,roomId]))[0]) fail("request_state");
}
export async function joinVoice(db: Database, user: SessionUser, scope: RoomScope, device: string, provider?: VoiceProvider) {
  if (!/^[0-9a-f-]{36}$/i.test(device)) fail("invalid_input");
  if (!await voiceAvailable(db)) fail("feature_disabled");
  const p = provider ?? liveVoiceProvider();
  const seat = await db.tx(async q => {
    await lockLobby(q); await communityRoom(q,user,scope,true);
    if ((await q.query("select 1 from community_voice_seats where user_id=$1 and state<>'left'", [user.id]))[0]) fail("session_overlap");
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from community_voice_seats where user_id=$1 and created_at>now()-interval '1 hour'",[user.id]);
    if(n.n>=12) fail("request_limit");
    let [room] = await q.query<VoiceRoom>("select * from community_voice_rooms where scope=$1 and scope_id is not distinct from $2::uuid and state<>'closed'",[scope.scope,scope.id]);
    const fresh = !room;
    if (room && (room.state!=="active" || new Date(room.expires_at).getTime()<=Date.now())) fail("request_state");
    if (!room) {
      const [count] = await q.query<{ n: number }>("select count(*)::int as n from community_voice_rooms where state<>'closed'"); if(count.n>=4) fail("request_limit");
      [room] = await q.query<VoiceRoom>("insert into community_voice_rooms(id,scope,scope_id) values($1,$2,$3) returning *",[randomUUID(),scope.scope,scope.id]);
    }
    await compatible(q,user.id,room.id);
    const [count] = await q.query<{ n: number }>("select count(*)::int as n from community_voice_seats where room_id=$1 and state<>'left'",[room.id]); if(count.n>=8) fail("request_limit");
    const identity = randomUUID();
    await q.query("insert into community_voice_seats(id,room_id,user_id,device) values($1,$2,$3,$4)",[identity,room.id,user.id,device]);
    return { id: identity, room, fresh };
  });
  try {
    if(seat.fresh) await p.create(roomName(seat.room.id));
    // Token issuance follows a second eligibility check. Failed/ambiguous creates remain recorded for cleanup.
    const token = await db.tx(async q => {
      await lockLobby(q); if(!await voiceAvailable(q)) fail("feature_disabled"); await communityRoom(q,user,scope,true); await compatible(q,user.id,seat.room.id);
      const [r] = await q.query<VoiceRoom>("select * from community_voice_rooms where id=$1 for update",[seat.room.id]);
      if (!r || !["opening","active"].includes(r.state) || new Date(r.expires_at).getTime()<=Date.now()) fail("request_state");
      await q.query("update community_voice_rooms set state='active' where id=$1",[r.id]);
      return p.token(roomName(r.id),seat.id);
    });
    return { seat: seat.id, token, url: voiceConfig().url, expiresAt: seat.room.expires_at };
  } catch (e) {
    await db.query("update community_voice_rooms set state='closing',cleanup_until=coalesce(cleanup_until,now()+interval '90 seconds') where id=$1 and state<>'closed'",[seat.room.id]); throw e;
  }
}
export async function leaveVoice(db: Database, user: SessionUser, device: string, provider?: VoiceProvider) {
  const seats = await db.query<{ id: string; room_id: string }>("update community_voice_seats set state='leaving' where user_id=$1 and device=$2 and state<>'left' returning id,room_id",[user.id,device]);
  if(!seats.length) return;
  const p = provider ?? liveVoiceProvider();
  for(const s of seats) { await p.revoke(roomName(s.room_id),s.id); await db.query("update community_voice_seats set state='left' where id=$1",[s.id]); }
  await db.query("update community_voice_rooms r set state='closing',cleanup_until=coalesce(cleanup_until,now()+interval '90 seconds') where r.state='active' and not exists(select 1 from community_voice_seats s where s.room_id=r.id and s.state<>'left')");
}
export async function voiceStatus(db: Database, user: SessionUser, scope: RoomScope, device: string) {
  await communityRoom(db,user,scope);
  const [room] = await db.query<VoiceRoom>("select * from community_voice_rooms where scope=$1 and scope_id is not distinct from $2::uuid and state='active' and expires_at>now()",[scope.scope,scope.id]);
  if (!room) return { joined: false, members: [] };
  await compatible(db,user.id,room.id);
  const own = await db.query("update community_voice_seats set heartbeat_at=now() where room_id=$1 and user_id=$2 and device=$3 and state='joined' returning id",[room.id,user.id,device]);
  const members = await db.query<{ username: string; display_name: string; avatar_media_id: string | null }>("select u.username,u.display_name,u.avatar_media_id from community_voice_seats s join users u on u.id=s.user_id where s.room_id=$1 and s.state='joined' order by s.created_at",[room.id]);
  return { joined: !!own.length, members, expiresAt: room.expires_at };
}
export async function sweepCommunityVoice(db: Database, provider?: VoiceProvider) {
  const lease = await db.query("update community_voice_worker set lease_until=now()+interval '55 seconds' where id=true and lease_until<=now() returning id");
  if(!lease.length) return { busy: true };
  let healthy = false, closed = 0;
  try {
    if (!voiceConfig().ready && !provider) return { healthy: false, closed };
    const p = provider ?? liveVoiceProvider();
    const rows = await db.query<VoiceRoom>("select * from community_voice_rooms where state<>'closed' order by created_at limit 4");
    const disabled = process.env.MV_COMMUNITY_VOICE_ENABLED!=="1" || !await featureEnabled(db,"connections") || (await maintenanceState(db)).on;
    const outcomes = await Promise.allSettled(rows.map(async r => {
      if(r.state==="opening" && Date.now()-new Date(r.created_at).getTime()<90000) return;
      const seats = await db.query<{ id: string; user_id: string; state: string; stale: boolean }>("select id,user_id,state,heartbeat_at<now()-interval '90 seconds' as stale from community_voice_seats where room_id=$1 and state<>'left'",[r.id]);
      let close = disabled || r.state!=="active" || new Date(r.expires_at).getTime()<=Date.now() || !seats.length;
      for (const s of seats) {
        if(s.state!=="joined" || s.stale) { close=true; continue; }
        try { await communityRoom(db,{ id:s.user_id, restricted:false } as SessionUser,{scope:r.scope,id:r.scope_id}); await compatible(db,s.user_id,r.id); } catch { close=true; }
      }
      if (!close) return;
      await db.query("update community_voice_rooms set state='closing',cleanup_until=coalesce(cleanup_until,now()+interval '90 seconds') where id=$1",[r.id]);
      await Promise.all(seats.map(s => p.revoke(roomName(r.id),s.id)));
      await p.close(roomName(r.id));
      await db.tx(async q => { await q.query("update community_voice_seats set state='left' where room_id=$1",[r.id]); await q.query("update community_voice_rooms set state='closed' where id=$1 and cleanup_until<=now()",[r.id]); });
      closed++;
    }));
    if(outcomes.some(r=>r.status==="rejected")) return { healthy:false,closed };
    await p.healthy(); healthy=true;
    return { healthy, closed };
  } finally { await recordRun(db,"community_voice",{healthy,closed}); await db.query("update community_voice_worker set lease_until=now() where id=true"); }
}
