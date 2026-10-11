import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/server/db.ts';
import { PubgAdapter, verifyPendingScore, VerificationError, type MatchReceipt } from '../src/server/game-verification.ts';
import { signUp, sessionUser, deleteAccount } from '../src/server/auth.ts';
import { createOrg } from '../src/server/teams.ts';
import { createTournament, register, transition } from '../src/server/tournaments.ts';
import { submitScore } from '../src/server/leaderboard.ts';
const code=(s:string)=>(e:unknown)=>e instanceof VerificationError&&e.code===s;
const account='account.'+'c'.repeat(32),match='cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
test('out-of-order 120-second and 1-second responses never shorten shared provider cooldown',async()=>{
 const db=await openDatabase({embedded:true,dataDir:'memory://'});try{
 let long!:()=>void,short!:()=>void,calls=0,started!:()=>void;const both=new Promise<void>(r=>started=r);
 const network:typeof fetch=async()=>{const n=++calls;if(calls===2)started();await new Promise<void>(r=>{if(n===1)long=r;else short=r;});return new Response('',{status:429,headers:{'retry-after':n===1?'120':'1'}});};
 const api=new PubgAdapter(db,{PUBG_API_KEY:'isolated-fixture',PUBG_SHARD:'steam',PUBG_MATCH_MODE:'normal'},network);
 const a=assert.rejects(api.match(match,account),code('rate_limited')),b=assert.rejects(api.match(match,account),code('rate_limited'));await both;long();await a;
 const before=(await db.query<{retry_at:Date}>("select retry_at from game_api_limits where provider='pubg'"))[0].retry_at;
 short();await b;assert.equal(+(await db.query<{retry_at:Date}>("select retry_at from game_api_limits where provider='pubg'"))[0].retry_at,+before);
 await assert.rejects(api.match(match,account),code('rate_limited'));assert.equal(calls,2);
 }finally{await db.close();}
});
test('account closure revokes provider binding and refuses an in-flight receipt and future requests',async()=>{
 const db=await openDatabase({embedded:true,dataDir:'memory://'});try{
 const password='isolated lifecycle password',users=[];
 for(const name of ['lifeowner','lifeplayer']){const s=await signUp(db,{email:`${name}@example.test`,username:name,displayName:name,password,adult:true,terms:true});users.push((await sessionUser(db,s.token))!);}
 const [owner,player]=users,org=await createOrg(db,owner,{name:'Lifecycle fixture',description:''});
 const t=await createTournament(db,owner,org.id,{name:'Lifecycle fixture',game:'pubg',format:'leaderboard',participantType:'solo',teamSize:1,maxParticipants:2,startsAt:'2030-01-01T12:00',timeZone:'UTC',checkInRequired:'',region:'',description:'',rules:''});
 await transition(db,owner,t.id,'PUBLISHED');await transition(db,owner,t.id,'REGISTRATION_OPEN');for(const u of users)await register(db,u,t.id);await transition(db,owner,t.id,'REGISTRATION_CLOSED');await transition(db,owner,t.id,'IN_PROGRESS');
 const entry=await submitScore(db,player,t.id,{matchRef:match,kills:1,evidenceUrl:'https://example.test/proof'});
 await db.query("insert into game_account_bindings(game,user_id,account_id,proof_reference,verified_by)values('pubg',$1,$2,'ISOLATED FIXTURE ONLY',$3)",[player.id,account,owner.id]);
 let started!:()=>void,release!:()=>void,calls=0;const seen=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
 const receipt:MatchReceipt={provider:'pubg',accountId:account,matchId:match,reportedAt:'2026-10-01T12:00:00Z',durationSeconds:10,gameMode:'solo',custom:false,stats:{kills:1},responseHash:'c'.repeat(64),liveVerified:false};
 const api={match:async()=>{calls++;started();await gate;return receipt;}} as unknown as PubgAdapter;
 const pending=assert.rejects(verifyPendingScore(db,entry.id,1,player.id,{pubg:api}),code('ownership_required'));await seen;
 await deleteAccount(db,player,password);release();await pending;
 assert.ok((await db.query<{revoked_at:Date}>('select revoked_at from game_account_bindings where user_id=$1',[player.id]))[0].revoked_at);
 assert.equal((await db.query('select 1 from score_verification_receipts where entry_id=$1',[entry.id])).length,0);
 await assert.rejects(verifyPendingScore(db,entry.id,1,player.id,{pubg:api}),code('stale_submission'));assert.equal(calls,1);
 }finally{await db.close();}
});
