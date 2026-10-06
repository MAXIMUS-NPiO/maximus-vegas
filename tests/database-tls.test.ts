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
