import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { username as parseUsername } from "./validate.ts";
import { fail } from "./errors.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { inviteToTeam } from "./teams.ts";

export type ReservedInvite = { id: string; username: string; team_id: string; invited_by: string; expires_at: Date; name: string; slug: string; inviter_username: string };
const validId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export async function reservationByToken(q: Queryable, token: unknown) {
 if (!validId(token)) return null;
 const [row] = await q.query<ReservedInvite>(`select r.*, t.name, t.slug, u.username as inviter_username from username_reservations r join teams t on t.id=r.team_id join users u on u.id=r.invited_by
 where r.id=$1 and r.status='pending' and r.expires_at>now()`, [token]);
 return row ?? null;
}
export async function reserveOrInvite(db: Database, user: SessionUser, teamId: string, input: unknown) {
 const username = parseUsername(typeof input === "string" ? input.trim().replace(/^@/, "") : input);
 const result = await db.tx(async q => {
  await q.query("select pg_advisory_xact_lock(hashtext($1))", ["username:"+username]);
  const [team] = await q.query<{id:string;owner_id:string;captain_id:string}>("select id,owner_id,captain_id from teams where id=$1 for no key update",[teamId]);
  if (!team || (team.owner_id!==user.id && team.captain_id!==user.id)) fail("not_team_leader");
  const [existing] = await q.query<{status:string}>("select status from users where username=$1",[username]);
  if(existing) { if(existing.status!=="active") fail("username_taken"); return "existing"; }
  await q.query("update username_reservations set status='expired' where username=$1 and status='pending' and expires_at<=now()",[username]);
  const [reserved]=await q.query<{team_id:string}>("select team_id from username_reservations where username=$1 and status='pending'",[username]);
  if(reserved) { if(reserved.team_id!==teamId) fail("username_taken"); return "reserved"; }
  const [count]=await q.query<{n:number}>("select count(*)::int as n from username_reservations where invited_by=$1 and status='pending' and expires_at>now()",[user.id]);
  if(count.n>=20) fail("too_many_attempts");
  await q.query("insert into username_reservations(id,username,team_id,invited_by) values($1,$2,$3,$4)",[randomUUID(),username,teamId,user.id]);
  await audit(q,{actorId:user.id,action:"team.username_reserved",entity:"team",entityId:teamId,data:{username}});
  return "reserved";
 });
 if(result==="existing") await inviteToTeam(db,user,teamId,username);
 return result;
}
export async function checkReservedName(q: Queryable, username: string, token: unknown) {
 await q.query("select pg_advisory_xact_lock(hashtext($1))",["username:"+username]);
 const [row]=await q.query<{id:string}>("select id from username_reservations where username=$1 and status='pending' and expires_at>now() for update",[username]);
 if(row && row.id!==token) fail("username_taken");
 if(token) {
  const reservation=await reservationByToken(q,token);
  if(!reservation || reservation.username!==username) fail("token_invalid");
  return reservation;
 }
 return null;
}
export async function claimReservedName(q: Queryable, reservation: ReservedInvite | null, userId: string) {
 if(!reservation) return;
 // An email invitation binds this bearer token to the address supplied before sending.
 // Registration alone does not prove mailbox ownership: its team invitation is claimed after verification.
 const [delivery]=await q.query<{id:string;recipient_email:string;recipient_user_id:string|null}>("select id,recipient_email,recipient_user_id from team_invitation_deliveries where reservation_id=$1 and status='pending' and expires_at>now() for update",[reservation.id]);
 if(delivery) {
  const [recipient]=await q.query<{email:string;username:string}>("select email,username from users where id=$1",[userId]);
  if(!recipient || recipient.email!==delivery.recipient_email || recipient.username!==reservation.username || (delivery.recipient_user_id && delivery.recipient_user_id!==userId)) fail("invitation_recipient_mismatch");
  await q.query("update username_reservations set status='claimed',claimed_by=$2 where id=$1",[reservation.id,userId]);
  await q.query("update team_invitation_deliveries set recipient_user_id=$2 where id=$1",[delivery.id,userId]);
  await q.query("update email_outbox set user_id=$2 where team_invitation_id=$1",[delivery.id,userId]);
  await audit(q,{actorId:userId,action:"team.reserved_name_claimed",entity:"team",entityId:reservation.team_id,data:{username:reservation.username}});
  return;
 }
 // A cancelled delivery cannot fall back to the historical unrestricted bearer-token flow.
 const [bound]=await q.query("select id from team_invitation_deliveries where reservation_id=$1",[reservation.id]);
 if(bound) fail("token_invalid");
 await q.query("update username_reservations set status='claimed', claimed_by=$2 where id=$1",[reservation.id,userId]);
 const [invite]=await q.query<{id:string}>("insert into team_invites(team_id,user_id,invited_by) values($1,$2,$3) returning id",[reservation.team_id,userId,reservation.invited_by]);
 await notify(q,[userId],"team_invite",{team:reservation.name,teamSlug:reservation.slug,inviteId:invite.id,by:reservation.inviter_username});
 await audit(q,{actorId:userId,action:"team.reserved_name_claimed",entity:"team",entityId:reservation.team_id,data:{username:reservation.username}});
}
export async function revokeReservation(db: Database,user:SessionUser,id:string) {
 await db.tx(async q=>{
 const [r]=await q.query<{team_id:string;username:string}>("select team_id,username from username_reservations where id=$1",[id]);
 if(!r) fail("not_found");
 await q.query("select pg_advisory_xact_lock(hashtext($1))",["username:"+r.username]);
 const [t]=await q.query<{owner_id:string;captain_id:string}>("select owner_id,captain_id from teams where id=$1 for no key update",[r.team_id]);
 if(!t || (t.owner_id!==user.id && t.captain_id!==user.id)) fail("not_team_leader");
 await q.query("update username_reservations set status='revoked' where id=$1 and status='pending'",[id]);
 });
}
