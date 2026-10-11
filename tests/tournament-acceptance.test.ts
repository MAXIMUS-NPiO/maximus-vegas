import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/server/db.ts';
import { signUp,sessionUser,type SessionUser } from '../src/server/auth.ts';
import {createOrg} from '../src/server/teams.ts';
import {createTournament,register,transition} from '../src/server/tournaments.ts';
import {officialResult} from '../src/server/matches.ts';
import {submitScore,reviewScore,leaderboardStandings} from '../src/server/leaderboard.ts';
test('acceptance command is available for operators and CI',()=>{const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));assert.equal(pkg.scripts['acceptance:tournaments'],'node scripts/tournament-acceptance.mjs');});
test('isolated full bracket and twenty-game best-N tournament journeys',async()=>{
 const db=await openDatabase({embedded:true,dataDir:'memory://'});
 try{
 const users:SessionUser[]=[];
 for(let i=0;i<5;i++){const s=await signUp(db,{email:`journey${i}@example.test`,username:`journey${i}`,displayName:`Fixture player ${i}`,password:'isolated acceptance password',adult:'on',terms:'on'});users.push((await sessionUser(db,s.token))!);}
 const [owner,...players]=users;const org=await createOrg(db,owner,{name:'Isolated acceptance fixture',description:''});
 async function event(format:string){const t=await createTournament(db,owner,org.id,{name:`Fixture ${format}`,game:format==='leaderboard'?'pubg':'cs2',format,participantType:'solo',teamSize:1,maxParticipants:4,startsAt:'2030-01-01T12:00',timeZone:'UTC',checkInRequired:'',region:'',description:'',rules:'',bestOf:5,eligibleGameLimit:20});await transition(db,owner,t.id,'PUBLISHED');await transition(db,owner,t.id,'REGISTRATION_OPEN');for(const p of players)await register(db,p,t.id);await assert.rejects(register(db,players[0],t.id));await transition(db,owner,t.id,'REGISTRATION_CLOSED');await transition(db,owner,t.id,'IN_PROGRESS');return t;}
 const bracket=await event('single_elimination');let completed=0;
 while(true){const [m]=await db.query<{id:string}>("select id from matches where tournament_id=$1 and status='ready' order by round,position limit 1",[bracket.id]);if(!m)break;assert.ok(completed<4);await officialResult(db,owner,m.id,{scoreA:2,scoreB:0,evidenceUrl:'',note:'Isolated test referee result'});completed++;}
 assert.equal(completed,3);assert.equal((await db.query<{status:string}>('select status from tournaments where id=$1',[bracket.id]))[0].status,'COMPLETED');assert.equal((await db.query('select id from registrations where tournament_id=$1 and placement=1',[bracket.id])).length,1);
 const board=await event('leaderboard');const ids:string[]=[];
 for(let i=0;i<20;i++){const input={matchRef:`acceptance-${i}`,kills:i+1,deaths:1,evidenceUrl:'https://example.test/isolated-fixture'};const r=await submitScore(db,players[0],board.id,input);assert.equal(r.review,'pending');assert.equal((await submitScore(db,players[0],board.id,input)).id,r.id);ids.push(r.id);}
 assert.ok((await leaderboardStandings(db,{id:board.id,scoring:null,best_of:5})).every(r=>r.counted===0));
 await assert.rejects(submitScore(db,players[0],board.id,{matchRef:'acceptance-21',kills:999,evidenceUrl:'https://example.test/isolated-fixture'}),e=>Boolean(e&&typeof e==='object'&&'code' in e&&e.code==='too_many_entries'));
 await assert.rejects(transition(db,owner,board.id,'COMPLETED'));
 for(const id of ids)await reviewScore(db,owner,id,'approve','Reviewed isolated fixture',1);
 const top=(await leaderboardStandings(db,{id:board.id,scoring:null,best_of:5}))[0];assert.equal(top.counted,5);assert.equal(top.kills,90);assert.equal(top.deaths,5);
 await transition(db,owner,board.id,'COMPLETED');assert.equal((await db.query('select id from registrations where tournament_id=$1 and placement=1',[board.id])).length,1);
 }finally{await db.close();}
});
