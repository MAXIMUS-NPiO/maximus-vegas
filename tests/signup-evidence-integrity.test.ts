import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import sharp from "sharp";
import {openDatabase,type Database} from "../src/server/db.ts";
import * as auth from "../src/server/auth.ts";
import {storeUpload} from "../src/server/media.ts";
let db:Database;
test.before(async()=>{db=await openDatabase({embedded:true,dataDir:"memory://"});});
test.after(async()=>db.close());
test("H5 evidence has a decoded normalized derivative and a private hashed original",async()=>{
  await assert.rejects(storeUpload(db,null,"evidence",new File([new Uint8Array([137,80,78,71,13,10,26,10])],"header.png")));
  const bytes=await sharp({create:{width:32,height:24,channels:3,background:"#123456"}}).png().toBuffer();
  const id=await storeUpload(db,null,"evidence",new File([new Uint8Array(bytes)],"evidence.png"));
  const [row]=await db.query<Record<string,any>>("select * from media where id=$1",[id]);
  assert.equal(row.content_type,"image/webp");assert.equal((await sharp(row.data).metadata()).format,"webp");
  assert.deepEqual(Buffer.from(row.original_data),bytes);
  assert.equal(row.original_sha256,createHash("sha256").update(bytes).digest("hex"));
});
test("H6 parallel requests share one durable IP budget with no loopback bypass",async()=>{
  const ip="127.0.0.2", key=`signup-client:${auth.sha256(ip)}`;
  await db.query("insert into auth_attempts(key,ok) select $1,true from generate_series(1,$2::int)",[key,auth.SIGNUP_PER_HOUR-1]);
  const runs=await Promise.allSettled(Array.from({length:4},()=>auth.spendSignupBudget(db,ip)));
  assert.equal(runs.filter(r=>r.status==="fulfilled").length,1);
  const [n]=await db.query<{n:number}>("select count(*)::int n from auth_attempts where key=$1",[key]);assert.equal(n.n,auth.SIGNUP_PER_HOUR);
});
test("H6 device budget survives client IP changes",async()=>{
  const device="a".repeat(48), key=`signup-device:${auth.sha256(device)}`;
  await db.query("insert into auth_attempts(key,ok) select $1,true from generate_series(1,5)",[key]);
  await assert.rejects(auth.spendSignupBudget(db,"203.0.113.112",device),e=>typeof e==="object"&&e!==null&&"code" in e&&e.code==="signup_limited");
});
