import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { openDatabase, migrate, type Database } from '../src/server/db.ts';
import { migrations } from '../src/server/schema.ts';
import { signUp, sessionUser } from '../src/server/auth.ts';
import { createOrg } from '../src/server/teams.ts';
import { createTournament, register, transition } from '../src/server/tournaments.ts';
import { submitScore, reviewScore } from '../src/server/leaderboard.ts';
import { verifyAuditChain } from '../src/server/audit.ts';
const code=(s:string)=>(e:unknown)=>Boolean(e&&typeof e==='object'&&'code' in e&&e.code===s);
async function fixture(db:Database){
 const users=[];
 for(const name of ['revowner','revplayer']){const s=await signUp(db,{email:`${name}@example.test`,username:name,displayName:name,password:'isolated review password',adult:true,terms:true});users.push((await sessionUser(db,s.token))!);}
 const [owner,player]=users,org=await createOrg(db,owner,{name:'Revision fixture',description:''});
 const t=await createTournament(db,owner,org.id,{name:'Revision fixture',game:'pubg',format:'leaderboard',participantType:'solo',teamSize:1,maxParticipants:2,startsAt:'2030-01-01T12:00',timeZone:'UTC',checkInRequired:'',region:'',description:'',rules:''});
 await transition(db,owner,t.id,'PUBLISHED');await transition(db,owner,t.id,'REGISTRATION_OPEN');for(const user of users)await register(db,user,t.id);await transition(db,owner,t.id,'REGISTRATION_CLOSED');await transition(db,owner,t.id,'IN_PROGRESS');return {owner,player,t};
}
test('stale approve and reject cannot decide an unseen corrected revision or grant XP',async()=>{
 const db=await openDatabase({embedded:true,dataDir:'memory://'});
 try{
 const {owner,player,t}=await fixture(db),input={matchRef:'revision-race',kills:3,evidenceUrl:'https://example.test/proof'},entry=await submitScore(db,player,t.id,input);
 await reviewScore(db,owner,entry.id,'reject','Needs correction',1);
 await submitScore(db,player,t.id,{...input,kills:4,replaces:entry.id,expectedRevision:1,correctionReason:'Corrected from original evidence'});
 for(const decision of ['approve','reject'])await assert.rejects(reviewScore(db,owner,entry.id,decision,'Stale review',1),code('stale_submission'));
 assert.equal((await db.query<{review:string}>('select review from score_entries where id=$1',[entry.id]))[0].review,'pending');
 assert.equal((await db.query("select 1 from xp_events where reason='leaderboard_entry' and ref=$1",[t.id])).length,0);
 await assert.rejects(reviewScore(db,owner,entry.id,'approve','',undefined),code('invalid_input'));
 await reviewScore(db,owner,entry.id,'approve','Current review',2);
 assert.equal((await db.query("select 1 from xp_events where reason='leaderboard_entry' and ref=$1",[t.id])).length,1);
 assert.equal((await verifyAuditChain(db)).valid,true);
 }finally{await db.close();}
});
test('upgrade preserves legacy blank references and allows audited rejection, genuine correction and finish',async()=>{
 const pg=new PGlite(),db:Database={kind:'embedded',query:async(sql,params)=>(await pg.query(sql,params)).rows as never,tx:fn=>pg.transaction(tx=>fn({query:async(sql,params)=>(await tx.query(sql,params)).rows as never})),close:()=>pg.close()};
 try{
 await db.query('create table schema_migrations(id int primary key,name text not null,applied_at timestamptz not null default now())');
 for(const m of migrations.filter(m=>m.id<=43)){for(const sql of m.statements)await db.query(sql);await db.query('insert into schema_migrations(id,name)values($1,$2)',[m.id,m.name]);}
 const legacyDb:Database={...db,query:async <T>(sql:string,params?:unknown[])=>/^update tournaments set eligible_game_limit/.test(sql)?[]:db.query<T>(sql,params),tx:fn=>db.tx(q=>fn({query:async <T>(sql:string,params?:unknown[])=>/^update tournaments set eligible_game_limit/.test(sql)?[]:q.query<T>(sql,params)}))};
 const {owner,player,t}=await fixture(legacyDb);
 const [reg]=await db.query<{id:string}>('select id from registrations where tournament_id=$1 and user_id=$2',[t.id,player.id]);
 const entries=[];
 for(const review of ['pending','accepted']){const [entry]=await db.query<{id:string}>("insert into score_entries(tournament_id,registration_id,submitted_by,source,kills,assists,deaths,headshots,damage,distance,match_ref,review)values($1,$2,$3,'participant',1,0,1,0,0,0,'',$4)returning id",[t.id,reg.id,player.id,review]);entries.push(entry.id);}
 await migrate(db);
 await assert.rejects(reviewScore(db,owner,entries[0],'approve','Old proof',1),code('invalid_input'));
 await assert.rejects(reviewScore(db,owner,entries[0],'reject','',1),code('invalid_input'));
 await reviewScore(db,owner,entries[0],'reject','Legacy reference missing',1);
 await assert.rejects(db.query("insert into score_entries(tournament_id,registration_id,submitted_by,source,kills,assists,deaths,headshots,damage,distance,match_ref,review)values($1,$2,$3,'participant',0,0,0,0,0,0,'','pending')",[t.id,reg.id,player.id]));
 await assert.rejects(submitScore(db,player,t.id,{matchRef:'',evidenceUrl:'https://example.test/proof'}),code('invalid_input'));
 await submitScore(db,player,t.id,{matchRef:'genuine-corrected-match',kills:2,evidenceUrl:'https://example.test/proof',replaces:entries[0],expectedRevision:1,correctionReason:'Original replay supplies actual match reference'});
 await reviewScore(db,owner,entries[0],'approve','Reviewed revision two',2);
 await reviewScore(db,owner,entries[1],'reject','Legacy accepted entry lacks a reference',1);
 assert.equal((await db.query<{match_ref:string}>('select match_ref from score_entries where id=$1',[entries[1]]))[0].match_ref,'');
 assert.equal((await db.query("select 1 from audit_log where action='score.rejected' and data->>'legacyReference'='true'",[])).length,2);
 await transition(db,owner,t.id,'COMPLETED');assert.equal((await verifyAuditChain(db)).valid,true);
 }finally{await db.close();}
});
