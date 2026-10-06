import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { createTournament, register, transition, cloneTournament } from "../src/server/tournaments.ts";
import { submitScore, reviewScore, leaderboardStandings } from "../src/server/leaderboard.ts";
import { standings, DEFAULT_WEIGHTS } from "../src/server/scoring.ts";

let db: Database, owner: SessionUser, player: SessionUser, other: SessionUser, org: string;
let n = 0;
test.before(async () => {
  db = await openDatabase({embedded:true, dataDir:"memory://"});
  const users = [];
  for (const name of ["auditowner", "auditplayer", "auditother"]) {
    const s = await signUp(db, {email:`${name}@example.test`, username:name, displayName:name, password:"isolated test password", adult:"on", terms:"on"});
    users.push((await sessionUser(db,s.token))!);
  }
  [owner,player,other]=users;org=(await createOrg(db,owner,{name:"Isolated audit",description:""})).id;
});
test.after(async()=>db.close());
async function event(limit=20) {
  const t=await createTournament(db,owner,org,{name:`Integrity ${++n}`,game:"pubg",format:"leaderboard",participantType:"solo",teamSize:1,maxParticipants:2,checkInRequired:"",region:"",startsAt:"2030-01-01T12:00",timeZone:"UTC",description:"",rules:"",bestOf:1,eligibleGameLimit:limit});
  await transition(db,owner,t.id,"PUBLISHED");await transition(db,owner,t.id,"REGISTRATION_OPEN");
  await register(db,player,t.id);await register(db,other,t.id);
  await transition(db,owner,t.id,"REGISTRATION_CLOSED");
  await transition(db,owner,t.id,"IN_PROGRESS");return t;
}
const score=(ref:string)=>({matchRef:ref,kills:10,deaths:1,evidenceUrl:"https://example.test/evidence"});
const code=(value:string)=>(error:unknown)=>Boolean(error&&typeof error==="object"&&"code" in error&&error.code===value);

test("H1 blank references cannot enter the log or standings",async()=>{
  const t=await event();for(let i=0;i<2;i++)await assert.rejects(submitScore(db,player,t.id,score("")),code("invalid_input"));
  assert.equal((await db.query<{n:number}>("select count(*)::int n from score_entries where tournament_id=$1",[t.id]))[0].n,0);
});
test("H1 self reports require evidence and always await review",async()=>{
  const t=await event();await assert.rejects(submitScore(db,player,t.id,{...score(`no-evidence-${n}`),evidenceUrl:""}),code("invalid_evidence"));
  const saved=await submitScore(db,player,t.id,score(`pending-${n}`));assert.equal(saved.review,"pending");
  const rows=await leaderboardStandings(db,{id:t.id,scoring:null,best_of:1});assert.ok(rows.every(r=>r.points===0));
});
test("H1/H2 exact retries are idempotent, altered and cross-event duplicates are refused",async()=>{
  const t=await event(), line=score(`canonical-${n}`);const a=await submitScore(db,player,t.id,line);
  const replay=await submitScore(db,player,t.id,line);assert.equal(replay.id,a.id);
  await assert.rejects(submitScore(db,player,t.id,{...line,kills:11}),code("duplicate_entry"));
  const second=await event();await assert.rejects(submitScore(db,player,second.id,line),code("duplicate_entry"));
});
test("H1 a rejected match is corrected in place with explicit revision and reason",async()=>{
  const t=await event(), line=score(`correction-${n}`);const a=await submitScore(db,player,t.id,line);
  await reviewScore(db,owner,a.id,"reject","Evidence needs correction");
  await assert.rejects(submitScore(db,player,t.id,{...line,kills:9}),code("duplicate_entry"));
  const corrected={...line,kills:9,replaces:a.id,expectedRevision:1,correctionReason:"Corrected from the replay"};
  const b=await submitScore(db,player,t.id,corrected);assert.equal(b.id,a.id);assert.equal(b.review,"pending");
  assert.equal((await submitScore(db,player,t.id,corrected)).id,a.id);
  const history=await db.query("select * from score_entry_revisions where entry_id=$1",[a.id]);assert.equal(history.length,1);
});
test("H2 eligible limit is per event and retry does not consume another game",async()=>{
  const t=await event(10);for(let i=0;i<10;i++)await submitScore(db,player,t.id,score(`limit-${n}-${i}`));
  await submitScore(db,player,t.id,score(`limit-${n}-9`));
  await assert.rejects(submitScore(db,player,t.id,score(`limit-${n}-10`)),code("too_many_entries"));
  const [stored]=await db.query<{eligible_game_limit:number}>("select eligible_game_limit from tournaments where id=$1",[t.id]);assert.equal(stored.eligible_game_limit,10);
});
test("H2 discarded games never change counted metrics or rank; tied inputs are order independent",()=>{
  const weights={...DEFAULT_WEIGHTS,kills:1,assists:0,headshots:0,damage:0,distance:0,place1:0,place2:0,place3:0};
  const line={kills:10,assists:0,deaths:1,headshots:0,damage:0,distance:0,placement:null,accepted:true,pending:false};
  const initial=[{...line,participantId:"a"},{...line,participantId:"b"}];
  const before=standings(["a","b"],initial,weights,1);
  const after=standings(["a","b"],[...initial,{...line,participantId:"b",kills:1,deaths:0}],weights,1);
  assert.deepEqual(after.map(({logged,...r})=>r),before.map(({logged,...r})=>r));
  const tied=[{...line,participantId:"a",assists:8},{...line,participantId:"a",deaths:2}];
  assert.deepEqual(standings(["a"],tied,weights,1),standings(["a"],tied.toReversed(),weights,1));
});
