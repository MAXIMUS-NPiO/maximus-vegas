import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase,type Database } from "../src/server/db.ts";
import { signUp,sessionUser,type SessionUser } from "../src/server/auth.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { registerRentalNode,reviewRentalNode,createRentalTemplate,reviewRentalTemplate,rotateRentalKey,setRentalNodeEnabled,synchronizeRentalNode,allocateRental,rentalCommand,rentalBackupJob } from "../src/server/rentals.ts";
const url=process.env.RENTAL_PG_TEST_URL;
if(url&&(!["localhost","127.0.0.1"].includes(new URL(url).hostname)||!new URL(url).pathname.startsWith("/c25_")))throw Error("Rental concurrency requires a local c25_ database");
let db:Database;const fingerprint="b".repeat(64);
async function account(roles:SessionUser["roles"]=[]){const username=`pg${randomUUID().replaceAll("-","").slice(0,20)}`;const s=await signUp(db,{username,displayName:username,email:`${username}@example.com`,password:"isolated concurrent rental password",adult:"on",terms:"on"});return {...(await sessionUser(db,s.token))!,roles};}
async function node(capacity=1){const owner=await account(),staff=await account(["admin"]);const id=await registerRentalNode(db,owner,{name:"Concurrent node",region:"Local",address:"games.example.org",cpuMillis:1000*capacity,memoryMb:1024*capacity,storageMb:5120*capacity,portStart:28000,portEnd:27999+capacity,consent:true});await reviewRentalNode(db,staff,id,"approved","Local PostgreSQL concurrency fixture");const template=await createRentalTemplate(db,owner,id,{name:"Concurrent template",game:"cs2",localKey:"fixture-game",fingerprint,cpuMillis:1000,memoryMb:512,diskMb:1024,ports:[{name:"game",container:27015,protocol:"udp"}],evidence:"https://example.org/fixture"});await reviewRentalTemplate(db,staff,template,"approved","Local PostgreSQL concurrency fixture");const key=(await rotateRentalKey(db,owner,id))!;await setRentalNodeEnabled(db,owner,id,true);await synchronizeRentalNode(db,key,{ready:true,templates:[fingerprint],reports:[]});return {owner,id,template,key};}
test.before(async()=>{if(url)db=await openDatabase({url});});
test.after(async()=>{if(db){assert.equal((await verifyAuditChain(db)).valid,true);await db.close();}});
test("PostgreSQL serializes simultaneous rentals without overselling CPU or ports",{skip:!url},async()=>{
  const n=await node(2),players=await Promise.all(Array.from({length:6},()=>account()));
  const results=await Promise.allSettled(players.map(p=>allocateRental(db,p,n.template,30,true)));assert.equal(results.filter(x=>x.status==="fulfilled").length,2);
  const leases=await db.query<{id:string;ports:{host:number}[];cpu_millis:number}>("select id,ports,cpu_millis from rental_leases where node_id=$1 and released_at is null",[n.id]);assert.equal(new Set(leases.map(l=>l.ports[0].host)).size,2);assert.equal(leases.reduce((s,l)=>s+l.cpu_millis,0),2000);
});
test("PostgreSQL enforces one active rental for a player across different nodes",{skip:!url},async()=>{
  const a=await node(),b=await node(),player=await account();const results=await Promise.allSettled([allocateRental(db,player,a.template,30,true),allocateRental(db,player,b.template,30,true)]);assert.equal(results.filter(x=>x.status==="fulfilled").length,1);
});
test("PostgreSQL fences key rotation and serializes backup work against release",{skip:!url},async()=>{
  const n=await node(),player=await account(),id=await allocateRental(db,player,n.template,30,true);await rentalCommand(db,player,id,"stop");await synchronizeRentalNode(db,n.key,{ready:true,templates:[fingerprint],reports:[{id,revision:2,status:"stopped"}]});
  const jobs=await Promise.allSettled(Array.from({length:4},()=>rentalBackupJob(db,player,id,"backup")));assert.equal(jobs.filter(x=>x.status==="fulfilled").length,1);
  await Promise.all([synchronizeRentalNode(db,n.key,{ready:true,templates:[fingerprint],reports:[]}).catch(()=>null),rotateRentalKey(db,n.owner,n.id)]);
  await assert.rejects(synchronizeRentalNode(db,n.key,{ready:true,templates:[fingerprint],reports:[]}));
  const [lease]=await db.query<{desired:string;revision:number;released_at:Date|null}>("select desired,revision,released_at from rental_leases where id=$1",[id]);assert.equal(lease.desired,"released");assert.equal(lease.revision,3);assert.equal(lease.released_at,null);
  const [job]=await db.query<{status:string}>("select status from rental_jobs where lease_id=$1",[id]);assert.equal(job.status,"cancelled");
});
