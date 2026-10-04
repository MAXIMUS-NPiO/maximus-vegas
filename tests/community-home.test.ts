import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createTeam, respondToInvite, removeMember } from "../src/server/teams.ts";
import { createClan } from "../src/server/clans.ts";
import { myTeamDesk } from "../src/server/my-teams.ts";
import { reserveOrInvite } from "../src/server/username-reservations.ts";
import { requestFriend, respondFriend, communityPeople, roomScope, roomMessages, sendRoomMessage, deleteRoomMessage, reportRoomMessage, reviewCommunityReport, saveAvatar, canSeeAvatar, communityExport, eraseCommunity } from "../src/server/community.ts";
import { applyCommunityHost, reviewCommunityHost, communityHosts } from "../src/server/community-hosts.ts";
import { proposeClanRelationship, respondClanRelationship, clanRelationships } from "../src/server/clan-relationships.ts";
import { blockProfile, withdrawSocialProfile, sendSocialMessage, conversation } from "../src/server/social.ts";
import { socialCallAction } from "../src/server/social-calls.ts";
import { joinVoice, leaveVoice, voiceStatus, voiceAvailable, sweepCommunityVoice, liveVoiceProvider, type VoiceProvider } from "../src/server/community-voice.ts";
import { DomainError } from "../src/server/errors.ts";
import { gate, recordRun, setFlag } from "../src/server/system.ts";
let db: Database;
const globalRoom = roomScope("global");
const reject=(p:Promise<unknown>,code:string)=>assert.rejects(p,(e:unknown)=>e instanceof DomainError && e.code===code);
async function account(database=db) { const username=`c30_${randomUUID().slice(0,8)}`; const s=await signUp(database,{username,displayName:username,email:`${username}@example.test`,password:"isolated strong passphrase",adult:true,terms:true});return (await sessionUser(database,s.token))!; }
async function friend(a:SessionUser,b:SessionUser,database=db) {const r=await requestFriend(database,a,`@${b.username}`);return (await respondFriend(database,b,r,true))!;}
const providerState={created:[] as string[],revoked:[] as string[],closed:[] as string[],fail:false};
const provider:VoiceProvider={async create(n){providerState.created.push(n);},async revoke(n,id){if(providerState.fail)throw new Error("isolated remote failure");providerState.revoked.push(`${n}:${id}`);},async close(n){providerState.closed.push(n);},async token(n,id){return `${n}:${id}`;},async healthy(){}};
async function readyVoice(database=db) {process.env.LIVEKIT_URL="wss://isolated.livekit.cloud";process.env.LIVEKIT_API_KEY="isolated-key";process.env.LIVEKIT_API_SECRET="isolated-secret-for-tests-only";process.env.MV_COMMUNITY_VOICE_ENABLED="1";await recordRun(database,"community_voice",{healthy:true});}
async function clearVoice(){providerState.fail=false;await db.query("update community_voice_rooms set expires_at=now()-interval '1 second',cleanup_until=now()-interval '1 second'");await sweepCommunityVoice(db,provider);}
test.before(async()=>{db=await openDatabase({embedded:true,dataDir:"memory://"});});
test.after(async()=>{await db.close();});

test("Invitation desk retains old reservations and @username invites, with leader-only tokens",async()=>{
 const a=await account(),b=await account(),outsider=await account(),team=await createTeam(db,a,{name:"Invitation acceptance",tag:"TEAM",game:"cs2"});
 assert.equal(await reserveOrInvite(db,a,team.id,`@reserve_${randomUUID().slice(0,8)}`),"reserved");
 assert.equal(await reserveOrInvite(db,a,team.id,`@${b.username}`),"existing");
 let desk=await myTeamDesk(db,a);assert.equal(desk.reservations.length,1);assert.equal((await myTeamDesk(db,a,desk.reservations[0].username)).reservations.length,1);assert.equal((await myTeamDesk(db,a,"%_")).reservations.length,0);assert.equal(desk.outgoing[0].username,b.username);
 assert.deepEqual((await myTeamDesk(db,outsider)).reservations,[]);
 const incoming=(await myTeamDesk(db,b)).incoming;assert.equal(incoming.length,1);await respondToInvite(db,b,incoming[0].id,true);
 assert.equal((await myTeamDesk(db,b)).teams[0].leader,false);assert.equal((await myTeamDesk(db,b)).reservations.length,0);
 await db.query("update username_reservations set expires_at=now()-interval '1 day' where team_id=$1",[team.id]);
 desk=await myTeamDesk(db,a);assert.equal(desk.reservations[0].status,"expired");assert.equal(desk.outgoing[0].status,"accepted");
});
test("Friendship requires the recipient, works without dating consent and survives hiding discovery",async()=>{
 const a=await account(),b=await account(),other=await account(),r=await requestFriend(db,a,`@${b.username}`);
 await reject(respondFriend(db,a,r,true),"forbidden");await reject(respondFriend(db,other,r,true),"forbidden");
 assert.equal((await communityPeople(db,a)).friends.length,0);const match=(await respondFriend(db,b,r,true))!;
 assert.equal((await db.query("select 1 from social_profiles where user_id=any($1::uuid[])",[[a.id,b.id]])).length,0);
 await sendSocialMessage(db,a,match,"Ready for the game?",randomUUID());await withdrawSocialProfile(db,a);
 await sendSocialMessage(db,b,match,"Yes, let's play together",randomUUID());assert.equal((await conversation(db,a,match)).messages.length,2);
 process.env.MV_TURN_URLS="turn:127.0.0.1:3478";process.env.MV_TURN_SECRET="isolated-relay-secret-32-characters";
 const call=await socialCallAction(db,a,{action:"start",matchId:match,mode:"audio",device:randomUUID()});assert.equal(call.call?.state,"ringing");
 await blockProfile(db,b,a.id);assert.equal((await communityPeople(db,a)).friends.length,0);
 await reject(sendSocialMessage(db,a,match,"Blocked message",randomUUID()),"request_state");assert.equal((await db.query<{state:string}>("select state from social_calls where id=$1",[call.call!.id]))[0].state,"ended");
 await blockProfile(db,b,a.id,true);assert.equal((await communityPeople(db,a)).friends.length,0);await reject(requestFriend(db,a,b.username),"request_limit");
});
test("Private room membership is checked on each read and write, including member removal",async()=>{
 const a=await account(),b=await account(),team=await createTeam(db,a,{name:"Private room",tag:"PRIV",game:"cs2"}),scope=roomScope("team",team.id);
 await sendRoomMessage(db,a,scope,"Only the roster",randomUUID());await reject(roomMessages(db,b,scope),"forbidden");
 await db.query("insert into team_members(team_id,user_id) values($1,$2)",[team.id,b.id]);assert.equal((await roomMessages(db,b,scope)).length,1);
 await removeMember(db,a,team.id,b.id);await reject(sendRoomMessage(db,b,scope,"No longer on roster",randomUUID()),"forbidden");await reject(roomMessages(db,b,scope),"forbidden");
 assert.throws(()=>roomScope("team","bad"),DomainError);assert.throws(()=>roomScope("global OR true"),DomainError);
});
test("Room messages enforce payload-bound idempotence, length and per-user rate limits",async()=>{
 const a=await account(),key=randomUUID(),id=await sendRoomMessage(db,a,globalRoom,"Hello",key);
 assert.equal(await sendRoomMessage(db,a,globalRoom,"Hello",key),id);await reject(sendRoomMessage(db,a,globalRoom,"Changed",key),"invalid_input");
 await reject(sendRoomMessage(db,a,globalRoom,"x".repeat(1001),randomUUID()),"invalid_input");
 for(let i=0;i<9;i++)await sendRoomMessage(db,a,globalRoom,`message ${i}`,randomUUID());
 await reject(sendRoomMessage(db,a,globalRoom,"too many",randomUUID()),"request_limit");
 await reject(deleteRoomMessage(db,a,"9".repeat(200)),"invalid_input");
 const b=await account();await deleteRoomMessage(db,b,id);assert.ok((await roomMessages(db,b,globalRoom)).some(m=>m.id===id));await deleteRoomMessage(db,a,id);assert.ok(!(await roomMessages(db,b,globalRoom)).some(m=>m.id===id));
});
test("Reporting captures an excerpt, blocks contact and needs independent moderation; restricted members can report",async()=>{
 const a=await account(),b=await account(),staff={...await account(),roles:["moderation"]} as SessionUser;
 await db.query("insert into user_roles(user_id,role) values($1,'moderation')",[staff.id]);
 const match=await friend(a,b),id=await sendRoomMessage(db,a,globalRoom,"Message submitted for moderation",randomUUID());
 await reportRoomMessage(db,{...b,restricted:true},id,"Unwanted personal contact after refusal");
 await reportRoomMessage(db,b,id,"A repeated report must not duplicate notifications");
 assert.equal((await db.query("select 1 from notifications where user_id=$1 and kind='community_report'",[staff.id])).length,1);
 assert.ok(!(await roomMessages(db,b,globalRoom)).some(m=>m.id===id));assert.equal((await conversation(db,b,match)).match.status,"closed");
 const [r]=await db.query<{id:string;excerpt:string}>("select id,excerpt from community_reports where message_id=$1",[id]);assert.equal(r.excerpt,"Message submitted for moderation");
 await reject(reviewCommunityReport(db,{...b,roles:["moderation"]},r.id,"Self review is prohibited",true),"forbidden");await reject(reviewCommunityReport(db,a,r.id,"No staff privileges here",true),"forbidden");
 await reviewCommunityReport(db,staff,r.id,"Reviewed context and removed the message",true);assert.equal((await db.query<{body:string}>("select body from community_messages where id=$1",[id]))[0].body,"");
});
test("Avatar uploads are normalized, privacy-scoped, replaceable and erased with community data",async()=>{
 const a=await account(),b=await account();await db.query("update users set profile_public=false where id=$1",[a.id]);
 const bytes=await sharp({create:{width:20,height:30,channels:3,background:"#385970"}}).png().toBuffer();
 await saveAvatar(db,a,new File([new Uint8Array(bytes)],"avatar.png",{type:"image/png"}),false);
 const [u]=await db.query<{avatar_media_id:string}>("select avatar_media_id from users where id=$1",[a.id]);
 assert.equal(await canSeeAvatar(db,u.avatar_media_id,null),false);assert.equal(await canSeeAvatar(db,u.avatar_media_id,b),false);assert.equal(await canSeeAvatar(db,u.avatar_media_id,a),true);
 await friend(a,b);assert.equal(await canSeeAvatar(db,u.avatar_media_id,b),true);await blockProfile(db,b,a.id);assert.equal(await canSeeAvatar(db,u.avatar_media_id,b),false);
 await reject(saveAvatar(db,a,new File(["not an image"],"x.jpg"),false),"invalid_file");
 await sendRoomMessage(db,a,globalRoom,"My exported message",randomUUID());assert.equal((await communityExport(db,a.id)).roomMessages.length,1);
 await db.tx(q=>eraseCommunity(q,a.id));assert.equal((await db.query("select 1 from media where id=$1",[u.avatar_media_id])).length,0);assert.equal((await communityExport(db,a.id)).roomMessages[0].body,"");
});
test("Clan relationships need both leaderships and expired proposals can be renewed",async()=>{
 const a=await account(),b=await account(),outsider=await account();const ta=`A${randomUUID().slice(0,4)}`.toUpperCase(),tb=`B${randomUUID().slice(0,4)}`.toUpperCase();
 const ca=await createClan(db,a,{name:`Clan ${ta}`,tag:ta,description:""}),cb=await createClan(db,b,{name:`Clan ${tb}`,tag:tb,description:""});
 await reject(proposeClanRelationship(db,outsider,ca.id,tb,"allies"),"not_clan_leader");await proposeClanRelationship(db,a,ca.id,tb,"allies");
 assert.equal((await clanRelationships(db,ca.id,false)).length,0);const [r]=await clanRelationships(db,cb.id,true);assert.equal(r.incoming,true);
 await reject(respondClanRelationship(db,a,r.id,ca.id,"accept"),"request_state");await respondClanRelationship(db,b,r.id,cb.id,"accept");assert.equal((await clanRelationships(db,ca.id,false))[0].status,"active");
 await respondClanRelationship(db,a,r.id,ca.id,"end");assert.equal((await clanRelationships(db,cb.id,false)).length,0);
 await db.query("update clan_relationships set status='pending',expires_at=now()-interval '1 day' where id=$1",[r.id]);await proposeClanRelationship(db,a,ca.id,tb,"rivals");assert.equal((await clanRelationships(db,ca.id,true))[0].kind,"rivals");
});
test("Professional directory is empty until independent version-bound review and expires automatically",async()=>{
 const a=await account(),staff={...await account(),roles:["compliance"]} as SessionUser;
 const input={role:"psychologist",bio:"Qualified practitioner application for isolated tests",languages:"English",jurisdiction:"Test jurisdiction",organisation:"Test practice",credential:"Test credential",credentialUrl:"https://example.test/registry",bookingUrl:"https://example.test/booking",consent:true};
 await reject(applyCommunityHost(db,a,{...input,credential:""}),"invalid_input");await reject(applyCommunityHost(db,a,{...input,bookingUrl:"javascript:alert(1)"}),"invalid_url");await applyCommunityHost(db,a,input);assert.equal((await communityHosts(db)).some(p=>p.user_id===a.id),false);
 const review={status:"verified",version:"1",note:"Reviewed registry and practice authority in isolated test",verified:true,until:new Date(Date.now()+86400000).toISOString()};
 await reject(reviewCommunityHost(db,{...a,roles:["admin"]},a.id,review),"invalid_input");await reviewCommunityHost(db,staff,a.id,review);assert.equal((await communityHosts(db)).find(p=>p.user_id===a.id)?.role,"psychologist");
 await applyCommunityHost(db,a,{...input,bio:"Updated professional application, requiring a new review"});assert.equal((await communityHosts(db)).some(p=>p.user_id===a.id),false);await reject(reviewCommunityHost(db,staff,a.id,review),"request_state");
 await reviewCommunityHost(db,staff,a.id,{...review,version:2});await db.query("update community_hosts set verified_until=now()-interval '1 second' where user_id=$1",[a.id]);assert.equal((await communityHosts(db)).some(p=>p.user_id===a.id),false);
});
test("Voice tokens only publish microphone audio and require configured cloud plus a healthy worker",async()=>{
 delete process.env.MV_COMMUNITY_VOICE_ENABLED;assert.equal(await voiceAvailable(db),false);await readyVoice();
 const token=await liveVoiceProvider().token("isolated-room",randomUUID());const claims=JSON.parse(Buffer.from(token.split(".")[1],"base64url").toString());
 assert.deepEqual(claims.video.canPublishSources,["microphone"]);assert.equal(claims.video.room,"isolated-room");assert.equal(claims.video.canPublishData,false);assert.equal(claims.video.roomAdmin,undefined);assert.equal(claims.exp-claims.nbf,60);
 await db.query("update system_runs set last_at=now()-interval '3 minutes' where name='community_voice'");assert.equal(await voiceAvailable(db),false);await readyVoice();
});
test("Group voice enforces membership, seat ownership and eight participants; cleanup revokes access",async()=>{
 await readyVoice();const a=await account(),team=await createTeam(db,a,{name:"Voice team",tag:"VOICE",game:"cs2"}),scope=roomScope("team",team.id),device=randomUUID();
 const seat=await joinVoice(db,a,scope,device,provider);assert.ok(seat.token);assert.equal((await voiceStatus(db,a,scope,device)).joined,true);
 await reject(joinVoice(db,a,scope,randomUUID(),provider),"session_overlap");const outsider=await account();await reject(joinVoice(db,outsider,scope,randomUUID(),provider),"forbidden");
 for(let i=0;i<8;i++){const b=await account();await db.query("insert into team_members(team_id,user_id) values($1,$2)",[team.id,b.id]);if(i<7)await joinVoice(db,b,scope,randomUUID(),provider);else await reject(joinVoice(db,b,scope,randomUUID(),provider),"request_limit");}
 assert.equal((await voiceStatus(db,a,scope,device)).members.length,8);
 await leaveVoice(db,a,randomUUID(),provider);assert.equal((await voiceStatus(db,a,scope,device)).joined,true);
 await leaveVoice(db,a,device,provider);assert.ok(providerState.revoked.some(s=>s.endsWith(seat.seat)));assert.equal((await voiceStatus(db,a,scope,device)).joined,false);
 await clearVoice();assert.ok(providerState.closed.length>0);
});
test("Group voice closes on blocks, membership withdrawal and failed provider cleanup; failures disable new joins",async()=>{
 await readyVoice();const a=await account(),b=await account();await joinVoice(db,a,globalRoom,randomUUID(),provider);await joinVoice(db,b,globalRoom,randomUUID(),provider);await blockProfile(db,a,b.id);
 providerState.fail=true;assert.equal((await sweepCommunityVoice(db,provider)).healthy,false);assert.equal(await voiceAvailable(db),false);providerState.fail=false;await clearVoice();
 await readyVoice();const team=await createTeam(db,a,{name:"Removed from voice",tag:"REM",game:"cs2"});await db.query("insert into team_members(team_id,user_id) values($1,$2)",[team.id,b.id]);
 await joinVoice(db,b,roomScope("team",team.id),randomUUID(),provider);await removeMember(db,a,team.id,b.id);assert.ok((await sweepCommunityVoice(db,provider)).closed!>0);await clearVoice();
});
test("Voice accepts no new join after feature switch or heartbeat expiry; safety actions survive maintenance",async()=>{
 const a=await account();await readyVoice();await setFlag(db,{...a,roles:["admin"],mfaAt:new Date()},"maintenance",true,"Isolated acceptance");
 await gate(db,"community.report",a);await gate(db,"community.delete",a);await gate(db,"community.voice_leave",a);await reject(gate(db,"community.send",a),"maintenance");assert.equal(await voiceAvailable(db),false);
 await setFlag(db,{...a,roles:["admin"],mfaAt:new Date()},"maintenance",false,"Isolated acceptance ended");
});
test("real PostgreSQL: concurrent friends and room sends preserve one pair and one idempotent message",{skip:!process.env.PG_TEST_URL},async()=>{
 const pg=await openDatabase({url:process.env.PG_TEST_URL});try{
 const a=await account(pg),b=await account(pg);await Promise.all([requestFriend(pg,a,b.username),requestFriend(pg,b,a.username)]);
 const [r]=await pg.query<{id:string;requested_by:string}>("select id,requested_by from community_friend_requests where $1 in(user_a,user_b)",[a.id]);await respondFriend(pg,r.requested_by===a.id?b:a,r.id,true);
 assert.equal((await communityPeople(pg,a)).friends.length,1);const key=randomUUID();const ids=await Promise.all([sendRoomMessage(pg,a,globalRoom,"One delivery",key),sendRoomMessage(pg,a,globalRoom,"One delivery",key)]);assert.equal(ids[0],ids[1]);
 const match=(await communityPeople(pg,a)).friends[0].id;
 await Promise.allSettled([blockProfile(pg,a,b.id),sendSocialMessage(pg,b,match,"Racing message",randomUUID())]);assert.equal((await communityPeople(pg,a)).friends.length,0);
 }finally{await pg.close();}
});
