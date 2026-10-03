import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.ts";
import { signUp, sessionUser } from "../src/server/auth.ts";
import { createTeam, respondToInvite } from "../src/server/teams.ts";
import { reserveOrInvite, revokeReservation } from "../src/server/username-reservations.ts";
test("reserved invite protects a name, claims it once and requires team acceptance", async () => {
 const db=await openDatabase({embedded:true,dataDir:"memory://"});
 const input=(username:string)=>({username,email:username+"@example.com",displayName:username,password:"Test-password-12345",adult:"on",terms:"on"});
 try {
 const s=await signUp(db,input("captainreserve")); const captain=(await sessionUser(db,s.token))!;
 const t=await createTeam(db,captain,{name:"Reserved team",tag:"RSV",game:"cs2"});
 assert.equal(await reserveOrInvite(db,captain,t.id,"StormReserve"),"reserved");
 const [r]=await db.query<{id:string}>("select id from username_reservations where username='stormreserve'");
 assert.ok(r); assert.equal((await db.query("select id from users where username='stormreserve'")).length,0);
 await assert.rejects(signUp(db,input("stormreserve")), (e:any)=>e.code==="username_taken");
 await assert.rejects(signUp(db,{...input("wrongname"),reservation:r.id}), (e:any)=>e.code==="token_invalid");
 const joined=await signUp(db,{...input("stormreserve"),reservation:r.id});
 const player=(await sessionUser(db,joined.token))!;
 assert.equal((await db.query("select * from team_members where team_id=$1 and user_id=$2",[t.id,player.id])).length,0);
 const [invite]=await db.query<{id:string}>("select id from team_invites where team_id=$1 and user_id=$2",[t.id,player.id]);
 assert.ok(invite);await respondToInvite(db,player,invite.id,true);
 assert.equal((await db.query("select * from team_members where team_id=$1 and user_id=$2",[t.id,player.id])).length,1);
 await assert.rejects(signUp(db,{...input("reuse"),reservation:r.id}), (e:any)=>e.code==="token_invalid");
 await reserveOrInvite(db,captain,t.id,"cancelname");
 const [c]=await db.query<{id:string}>("select id from username_reservations where username='cancelname'");
 await assert.rejects(revokeReservation(db,player,c.id), (e:any)=>e.code==="not_team_leader");
 await revokeReservation(db,captain,c.id);await signUp(db,input("cancelname"));
 await reserveOrInvite(db,captain,t.id,"expiredname");
 await db.query("update username_reservations set expires_at=now()-interval '1 second' where username='expiredname'");
 await signUp(db,input("expiredname"));
 const e=await signUp(db,input("existinginvite")); const existing=(await sessionUser(db,e.token))!;
 assert.equal(await reserveOrInvite(db,captain,t.id,existing.username),"existing");
 assert.equal((await db.query("select id from username_reservations where username=$1",[existing.username])).length,0);
 } finally {await db.close();}
});
