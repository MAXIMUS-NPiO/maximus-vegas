import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { activeAccount } from "./product-access.ts";
import { requireSection, notify, staffWith } from "./access.ts";
import { fail } from "./errors.ts";
import { audit } from "./audit.ts";
import { endSocialCalls } from "./social-calls.ts";
import { storeUpload } from "./media.ts";
import * as v from "./validate.ts";

const uuid = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
export type RoomScope = { scope: "global" | "team" | "clan"; id: string | null };
export function roomScope(scope: unknown, id?: unknown): RoomScope {
  if (scope === "global") return { scope, id: null };
  if ((scope !== "team" && scope !== "clan") || !uuid(id)) return fail("invalid_input");
  return { scope, id };
}
export async function communityRoom(q: Queryable, user: SessionUser, room: RoomScope, lock = false, allowRestricted = false) {
  if (!allowRestricted) await activeAccount(q, user);
  if (room.scope === "global") return { name: "", slug: "" };
  const table = room.scope === "team" ? "teams" : "clans";
  const [r] = await q.query<{ name: string; slug: string }>(`select name,slug from ${table} where id=$1 ${room.scope === "clan" ? "and status='active'" : ""} ${lock ? "for share" : ""}`, [room.id]);
  if (!r) fail("not_found");
  const [member] = await q.query(`select 1 from ${room.scope === "team" ? "team_members" : "clan_members"} where ${room.scope === "team" ? "team_id" : "clan_id"}=$1 and user_id=$2`, [room.id, user.id]);
  if (!member) fail("forbidden");
  return r;
}
const pairBlocked = async (q: Queryable, a: string, b: string) => Boolean((await q.query("select 1 from social_blocks where (user_id=$1 and subject_id=$2) or (user_id=$2 and subject_id=$1)", [a, b]))[0]);
async function pairLock(q: Queryable, user: SessionUser, other: string) {
  if (!uuid(other) || other === user.id) fail("invalid_input");
  await q.query("select id from users where id=any($1::uuid[]) order by id for update", [[user.id, other].sort()]);
  await activeAccount(q, user);
  const [target] = await q.query("select 1 from users where id=$1 and status='active' and adult_confirmed_at is not null", [other]);
  if (!target || await pairBlocked(q, user.id, other)) fail("not_found");
  await activeAccount(q, { ...user, id: other, restricted: false });
  if ((await q.query("select 1 from social_profiles where user_id=$1 and suspended", [other]))[0]) fail("not_found");
}
export async function requestFriend(db: Database, user: SessionUser, username: unknown) {
  const name = v.username(typeof username === "string" ? username.trim().replace(/^@/, "") : username);
  return db.tx(async q => {
    const [other] = await q.query<{ id: string }>("select id from users where username=$1 and status='active'", [name]);
    if (!other) fail("not_found");
    await pairLock(q, user, other.id);
    const [a, b] = [user.id, other.id].sort();
    const [old] = await q.query<{ id: string; status: string; recent: boolean }>("select id,status,updated_at>now()-interval '7 days' as recent from community_friend_requests where user_a=$1 and user_b=$2", [a, b]);
    if (old?.status === "pending" || old?.status === "accepted") return old.id;
    if (old?.recent) fail("request_limit");
    const [count] = await q.query<{ n: number }>("select count(*)::int as n from community_friend_requests where requested_by=$1 and updated_at>now()-interval '1 day'", [user.id]);
    if (count.n >= 20) fail("request_limit");
    const [r] = await q.query<{ id: string }>(`insert into community_friend_requests(user_a,user_b,requested_by) values($1,$2,$3)
      on conflict(user_a,user_b) do update set requested_by=$3,status='pending',updated_at=now() returning id`, [a, b, user.id]);
    await notify(q,[other.id],"community_friend_request",{community:"1",by:user.username});
    await audit(q, { actorId: user.id, action: "community.friend_requested", entity: "user", entityId: other.id });
    return r.id;
  });
}
export async function respondFriend(db: Database, user: SessionUser, id: string, accept: boolean) {
  if (!uuid(id)) fail("invalid_input");
  return db.tx(async q => {
    const [initial] = await q.query<{ user_a: string; user_b: string; requested_by: string }>("select user_a,user_b,requested_by from community_friend_requests where id=$1 and $2 in(user_a,user_b)", [id, user.id]);
    if (!initial || initial.requested_by === user.id) fail("forbidden");
    await pairLock(q, user, initial.requested_by);
    const [request] = await q.query<{ status: string }>("select status from community_friend_requests where id=$1 for update", [id]);
    if (request.status !== "pending") fail("request_state");
    await q.query("update community_friend_requests set status=$2,updated_at=now() where id=$1", [id, accept ? "accepted" : "declined"]);
    if (!accept) return null;
    const [match] = await q.query<{ id: string }>(`insert into social_matches(user_a,user_b,friendship_active) values($1,$2,true)
      on conflict(user_a,user_b) do update set status='active',friendship_active=true returning id`, [initial.user_a, initial.user_b]);
    await notify(q,[initial.requested_by],"community_friend_accepted",{socialMatchId:match.id,by:user.username});
    await audit(q, { actorId: user.id, action: "community.friend_accepted", entity: "social_match", entityId: match.id });
    return match.id;
  });
}
export async function cancelFriendRequest(db: Database, user: SessionUser, id: string) {
  if (!uuid(id)) fail("invalid_input");
  await db.tx(async q => {
    await q.query("select id from users where id=$1 for update", [user.id]);
    await q.query("update community_friend_requests set status='cancelled',updated_at=now() where id=$1 and requested_by=$2 and status='pending'", [id, user.id]);
  });
}
export async function communityPeople(q: Queryable, user: SessionUser) {
  const [friends, requests, blocks] = await Promise.all([
    q.query<{ id: string; other_id: string; username: string; display_name: string; avatar_media_id: string | null; unread: number }>(`select m.id,u.id as other_id,u.username,u.display_name,u.avatar_media_id,
      (select count(*)::int from social_messages s where s.match_id=m.id and s.sender_id<>$1 and s.created_at>coalesce(case when m.user_a=$1 then m.read_a else m.read_b end,'epoch')) as unread
      from social_matches m join users u on u.id=case when m.user_a=$1 then m.user_b else m.user_a end
      where $1 in(m.user_a,m.user_b) and m.status='active' and m.friendship_active and u.status='active'
      and not exists(select 1 from social_blocks b where (b.user_id=$1 and b.subject_id=u.id) or (b.user_id=u.id and b.subject_id=$1))
      order by u.display_name,m.id limit 100`, [user.id]),
    q.query<{ id: string; incoming: boolean; username: string; display_name: string }>(`select r.id,r.requested_by<>$1 as incoming,u.username,u.display_name
      from community_friend_requests r join users u on u.id=case when r.user_a=$1 then r.user_b else r.user_a end
      where $1 in(r.user_a,r.user_b) and r.status='pending' and u.status='active'
      and not exists(select 1 from social_blocks b where (b.user_id=$1 and b.subject_id=u.id) or (b.user_id=u.id and b.subject_id=$1)) order by r.created_at desc limit 100`, [user.id]),
    q.query<{ subject_id: string; display_name: string }>("select b.subject_id,u.display_name from social_blocks b join users u on u.id=b.subject_id where b.user_id=$1 order by u.display_name", [user.id]),
  ]);
  return { friends, requests, blocks };
}
export type CommunityMessage = { id: string; sender_id: string; username: string; display_name: string; avatar_media_id: string | null; body: string; created_at: Date; host_role: string | null };
export async function roomMessages(q: Queryable, user: SessionUser, room: RoomScope, before = 0) {
  await communityRoom(q, user, room);
  if (!Number.isSafeInteger(before) || before < 0) fail("invalid_input");
  return (await q.query<CommunityMessage>(`select m.id::text,m.sender_id,m.body,m.created_at,u.username,u.display_name,u.avatar_media_id,h.role as host_role
    from community_messages m join users u on u.id=m.sender_id
    left join community_hosts h on h.user_id=u.id and h.status='verified' and h.verified_until>now()
    where m.scope=$1 and m.scope_id is not distinct from $2::uuid and m.removed_at is null and u.status='active' and ($4::bigint=0 or m.id<$4)
    and not exists(select 1 from social_blocks b where (b.user_id=$3 and b.subject_id=m.sender_id) or (b.user_id=m.sender_id and b.subject_id=$3))
    order by m.id desc limit 50`, [room.scope, room.id, user.id, before])).reverse();
}
export async function sendRoomMessage(db: Database, user: SessionUser, room: RoomScope, input: unknown, client: string) {
  const body = v.clean(input, 1001); if (!body || body.length > 1000 || !uuid(client)) fail("invalid_input");
  return db.tx(async q => {
    await q.query("select id from users where id=$1 for update", [user.id]);
    await communityRoom(q, user, room, true);
    const [old] = await q.query<{ id: string; scope: string; scope_id: string | null; body: string }>("select id::text,scope,scope_id,body from community_messages where sender_id=$1 and client_id=$2", [user.id, client]);
    if (old) { if (old.scope !== room.scope || old.scope_id !== room.id || old.body !== body) fail("invalid_input"); return old.id; }
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from community_messages where sender_id=$1 and created_at>now()-interval '1 minute'", [user.id]);
    if (n.n >= 10) fail("request_limit");
    const [row] = await q.query<{ id: string }>("insert into community_messages(scope,scope_id,sender_id,body,client_id) values($1,$2,$3,$4,$5) returning id::text", [room.scope, room.id, user.id, body, client]);
    return row.id;
  });
}
export async function deleteRoomMessage(db: Database, user: SessionUser, id: string) {
  if (!/^\d+$/.test(id)) fail("invalid_input");
  await db.query("update community_messages set body='',removed_at=now() where id=$1 and sender_id=$2", [id, user.id]);
}
export async function reportRoomMessage(db: Database, user: SessionUser, id: string, reasonInput: unknown) {
  const reason = v.clean(reasonInput, 1200); if (!/^\d+$/.test(id) || reason.length < 10) fail("invalid_input");
  return db.tx(async q => {
    const [m] = await q.query<{ scope: RoomScope["scope"]; scope_id: string | null; sender_id: string; body: string }>("select scope,scope_id,sender_id,body from community_messages where id=$1 and removed_at is null", [id]);
    if (!m || m.sender_id === user.id) fail("not_found");
    await q.query("select id from users where id=any($1::uuid[]) order by id for update", [[user.id, m.sender_id].sort()]);
    await communityRoom(q, user, { scope: m.scope, id: m.scope_id }, true, true);
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from community_reports where reporter_id=$1 and created_at>now()-interval '1 day'", [user.id]);
    if (n.n >= 10) fail("report_limit");
    await q.query("insert into community_reports(message_id,reporter_id,subject_id,reason,excerpt) values($1,$2,$3,$4,$5) on conflict(message_id,reporter_id) do nothing", [id, user.id, m.sender_id, reason, m.body]);
    await notify(q,await staffWith(q,"conduct"),"community_report",{conductAdmin:"1"});
    await q.query("insert into social_blocks(user_id,subject_id) values($1,$2) on conflict do nothing", [user.id, m.sender_id]);
    await q.query("update community_friend_requests set status='cancelled',updated_at=now() where user_a=least($1::uuid,$2::uuid) and user_b=greatest($1::uuid,$2::uuid)", [user.id, m.sender_id]);
    const matches = await q.query<{ id: string }>("update social_matches set status='closed',friendship_active=false where $1 in(user_a,user_b) and $2 in(user_a,user_b) returning id", [user.id, m.sender_id]);
    for (const m of matches) await endSocialCalls(q, user.id, m.id);
  });
}
export async function reviewCommunityReport(db: Database, staff: SessionUser, id: string, decision: unknown, remove: boolean) {
  requireSection(staff, "conduct"); const note = v.clean(decision, 1000); if (!uuid(id) || note.length < 10) fail("invalid_input");
  await db.tx(async q => {
    const [r] = await q.query<{ reporter_id: string; subject_id: string; message_id: string; status: string }>("select * from community_reports where id=$1 for update", [id]);
    if (!r || r.status !== "open") fail("request_state");
    if ([r.reporter_id, r.subject_id].includes(staff.id)) fail("forbidden");
    if (remove) await q.query("update community_messages set body='',removed_at=now() where id=$1", [r.message_id]);
    await q.query("update community_reports set status='resolved',decision=$2,decided_by=$3,decided_at=now() where id=$1", [id, note, staff.id]);
    await audit(q, { actorId: staff.id, action: "community.report_resolved", entity: "community_report", entityId: id, data: { removed: remove } });
  });
}
export async function saveAvatar(db: Database, user: SessionUser, file: File | undefined, clear: boolean) {
  await db.tx(async q => {
    await q.query("select id from users where id=$1 for update", [user.id]); await activeAccount(q, user);
    if (!clear) {
      const [n] = await q.query<{ n: number }>("select count(*)::int as n from audit_log where actor_id=$1 and action='community.avatar_saved' and at>now()-interval '1 day'", [user.id]);
      if (n.n >= 20) fail("upload_limit");
    }
    const [old] = await q.query<{ avatar_media_id: string | null }>("select avatar_media_id from users where id=$1", [user.id]);
    const id = clear ? null : await storeUpload(q, user.id, "avatar", file);
    if (!clear && !id) fail("invalid_file");
    await q.query("update users set avatar_media_id=$2 where id=$1", [user.id, id]);
    await audit(q, { actorId: user.id, action: clear ? "community.avatar_removed" : "community.avatar_saved", entity: "user", entityId: user.id });
    if (old.avatar_media_id) await q.query("delete from media where id=$1 and kind='avatar' and owner_id=$2", [old.avatar_media_id, user.id]);
  });
}
export async function canSeeAvatar(q: Queryable, mediaId: string, viewer: SessionUser | null) {
  const [u] = await q.query<{ id: string; profile_public: boolean }>("select id,profile_public from users where avatar_media_id=$1 and status='active'", [mediaId]);
  if (!u) return false;
  if (viewer && await pairBlocked(q, viewer.id, u.id)) return false;
  if (u.profile_public || viewer?.id === u.id) return true;
  if (!viewer) return false;
  return Boolean((await q.query(`select 1 where
    exists(select 1 from social_matches where status='active' and $1 in(user_a,user_b) and $2 in(user_a,user_b))
    or exists(select 1 from team_members a join team_members b on b.team_id=a.team_id where a.user_id=$1 and b.user_id=$2)
    or exists(select 1 from clan_members a join clan_members b on b.clan_id=a.clan_id where a.user_id=$1 and b.user_id=$2)
    or exists(select 1 from community_messages where sender_id=$2 and scope='global' and removed_at is null)`, [viewer.id, u.id]))[0]);
}
export async function communityExport(q: Queryable, userId: string) {
  return {
    friendRequests: await q.query("select id,user_a,user_b,requested_by,status,created_at from community_friend_requests where $1 in(user_a,user_b)", [userId]),
    roomMessages: await q.query("select id,scope,scope_id,body,created_at,removed_at from community_messages where sender_id=$1", [userId]),
    reports: await q.query("select message_id,reason,status,decision,created_at from community_reports where reporter_id=$1", [userId]),
    voiceSessions: await q.query("select room_id,state,created_at from community_voice_seats where user_id=$1", [userId]),
    hostProfile: await q.query("select role,bio,languages,jurisdiction,organisation,credential,credential_url,booking_url,status,review_note,verified_until from community_hosts where user_id=$1", [userId]),
  };
}
export async function eraseCommunity(q: Queryable, userId: string) {
  await q.query("update users set avatar_media_id=null where id=$1", [userId]);
  await q.query("delete from media where owner_id=$1 and kind='avatar'", [userId]);
  await q.query("delete from community_friend_requests where $1 in(user_a,user_b)", [userId]);
  await q.query("update social_matches set friendship_active=false where $1 in(user_a,user_b)", [userId]);
  await q.query("update community_messages set body='',removed_at=now() where sender_id=$1", [userId]);
  await q.query("update community_reports set reason='',excerpt='',decision='' where reporter_id=$1 or subject_id=$1", [userId]);
  await q.query("update community_voice_seats set state='leaving' where user_id=$1 and state<>'left'", [userId]);
  await q.query("delete from community_hosts where user_id=$1", [userId]);
}
