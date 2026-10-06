import test from 'node:test';import assert from 'node:assert/strict';
import {openDatabase,type Database,type Queryable} from '../src/server/db.ts';
import {signUp,sessionUser} from '../src/server/auth.ts';import {createOrg} from '../src/server/teams.ts';
import {createTournament,register,transition} from '../src/server/tournaments.ts';import {submitScore,reviewScore} from '../src/server/leaderboard.ts';
// Coordinate two real PostgreSQL transactions to reproduce the review/retry lock cycle.
test('concurrent score retry and reviewer decision finish without a deadlock',{skip:!process.env.PG_TEST_URL,timeout:30_000},async()=>{
 const db=await openDatabase({url:process.env.PG_TEST_URL});
 try{
 const run=Date.now().toString(36);const users=[];for(const name of ['lockowner','lockplayer']){const username=name+run;const s=await signUp(db,{email:`${username}@example.test`,username,displayName:name,password:'isolated locking fixture',adult:true,terms:true});users.push((await sessionUser(db,s.token))!);}const [owner,player]=users;
 const org=await createOrg(db,owner,{name:`Lock fixture ${run}`,description:''});const t=await createTournament(db,owner,org.id,{name:'Lock fixture',game:'pubg',format:'leaderboard',participantType:'solo',teamSize:1,maxParticipants:2,startsAt:'2030-01-01T12:00',timeZone:'UTC',checkInRequired:'',region:'',description:'',rules:''});
 await transition(db,owner,t.id,'PUBLISHED');await transition(db,owner,t.id,'REGISTRATION_OPEN');for(const u of users)await register(db,u,t.id);await transition(db,owner,t.id,'REGISTRATION_CLOSED');await transition(db,owner,t.id,'IN_PROGRESS');
 const input={matchRef:`lock-${run}`,kills:3,evidenceUrl:'https://example.test/locking-fixture'};const entry=await submitScore(db,player,t.id,input);
 let beginRetry!:()=>void,releaseReview!:()=>void;const readEntry=new Promise<void>(r=>beginRetry=r),retryOwnsTournament=new Promise<void>(r=>releaseReview=r);let first=true;
 const wrap=(kind:'review'|'retry'):Database=>({...db,tx:fn=>db.tx(q=>fn({query:async <T>(sql:string,params?:unknown[])=>{
  const rows=await q.query<T>(sql,params);
  if(kind==='review'&&first&&/select.*from score_entries/s.test(sql)){first=false;beginRetry();await retryOwnsTournament;}
  if(kind==='retry'&&/from tournaments.*for update/s.test(sql))releaseReview();return rows;
 }} as Queryable))});
 const review=reviewScore(wrap('review'),owner,entry.id,'approve','Reviewed locking fixture',1);await readEntry;
 const results=await Promise.allSettled([review,submitScore(wrap('retry'),player,t.id,input)]);
 for(const result of results)assert.equal(result.status,'fulfilled',result.status==='rejected'?String(result.reason):'');
 assert.equal((await db.query<{review:string}>('select review from score_entries where id=$1',[entry.id]))[0].review,'approved');
 }finally{await db.close();}
});

 test('review waits for a correction and refuses both stale decisions',{skip:!process.env.PG_TEST_URL,timeout:30_000},async()=>{
 const db=await openDatabase({url:process.env.PG_TEST_URL});try{
 const run=Date.now().toString(36);const users=[];for(const name of ['lockowner','lockplayer']){const username=name+run;const s=await signUp(db,{email:`${username}@example.test`,username,displayName:name,password:'isolated locking fixture',adult:true,terms:true});users.push((await sessionUser(db,s.token))!);}const [owner,player]=users;
 const org=await createOrg(db,owner,{name:`Lock fixture ${run}`,description:''});const t=await createTournament(db,owner,org.id,{name:'Lock fixture',game:'pubg',format:'leaderboard',participantType:'solo',teamSize:1,maxParticipants:2,startsAt:'2030-01-01T12:00',timeZone:'UTC',checkInRequired:'',region:'',description:'',rules:''});
 await transition(db,owner,t.id,'PUBLISHED');await transition(db,owner,t.id,'REGISTRATION_OPEN');for(const u of users)await register(db,u,t.id);await transition(db,owner,t.id,'REGISTRATION_CLOSED');await transition(db,owner,t.id,'IN_PROGRESS');

 const input={matchRef:`stale-${run}`,kills:3,evidenceUrl:'https://example.test/locking-fixture'},entry=await submitScore(db,player,t.id,input);
 await reviewScore(db,owner,entry.id,'reject','Needs corrected replay',1);
 let signal!:()=>void,release!:()=>void;const seen=new Promise<void>(r=>signal=r),gate=new Promise<void>(r=>release=r);
 const paused:Database={...db,tx:fn=>db.tx(q=>fn({query:async <T>(sql:string,params?:unknown[])=>{const rows=await q.query<T>(sql,params);if(sql==='select tournament_id from score_entries where id=$1'){signal();await gate;}return rows;}}))};
 const attempt=reviewScore(paused,owner,entry.id,'approve','Stale proof',1);const rejected=assert.rejects(attempt,e=>Boolean(e&&typeof e==='object'&&'code'in e&&e.code==='stale_submission'));await seen;
 await submitScore(db,player,t.id,{...input,kills:4,replaces:entry.id,expectedRevision:1,correctionReason:'Corrected from original replay'});release();await rejected;
 await assert.rejects(reviewScore(db,owner,entry.id,'reject','Stale proof',1),e=>Boolean(e&&typeof e==='object'&&'code'in e&&e.code==='stale_submission'));
 await reviewScore(db,owner,entry.id,'approve','Reviewed current proof',2);
 }finally{await db.close();}});
