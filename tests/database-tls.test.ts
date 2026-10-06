import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as database from "../src/server/db.ts";
test("H3 database source never disables certificate authentication",()=>{
  assert.doesNotMatch(readFileSync(new URL("../src/server/db.ts",import.meta.url),"utf8"),/rejectUnauthorized:\s*false/);
});
test("H3 verified TLS wins over URL SSL overrides; CA is configurable",()=>{
  const cfg=database.postgresConnectionOptions("postgresql://db.example.test/app?sslmode=require&sslrootcert=ignored",{DATABASE_TLS_CA:"approved-ca"});
  assert.deepEqual(cfg.ssl,{rejectUnauthorized:true,ca:"approved-ca"});
  assert.equal(new URL(cfg.connectionString).searchParams.has("sslmode"),false);
});
test("H3 only actual loopback hosts may disable TLS",()=>{
  assert.equal(database.postgresConnectionOptions("postgresql://127.0.0.1/test",{}).ssl,false);
  assert.throws(()=>database.postgresConnectionOptions("postgresql://localhost.example.test/app",{DATABASE_TLS_MODE:"disable"}));
  assert.throws(()=>database.postgresConnectionOptions("postgresql://db.example.test/app?sslmode=no-verify",{}));
  assert.equal(database.postgresConnectionOptions("postgresql://db.example.test/app?application_name=localhost",{}).ssl && true,true);
});
test('H3 the actual pg parser cannot override CA or disable SSL through URL ssl=0',async()=>{
 const {default:pg}=await import('pg');
 for(const suffix of ['ssl=0','ssl=true','sslnegotiation=direct&ssl=0']){
  const config=database.postgresConnectionOptions(`postgresql://db.example.test/app?${suffix}`,{DATABASE_TLS_CA:'approved-ca'});
  const client=new pg.Client(config);assert.deepEqual((client as unknown as {connectionParameters:{ssl:unknown}}).connectionParameters.ssl,{rejectUnauthorized:true,ca:'approved-ca'});
 }
});
