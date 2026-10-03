/** Isolated browser accounts. No production database or externally delivered messages. */
import { mkdir,writeFile } from "node:fs/promises";
import { randomUUID,createHash } from "node:crypto";
import { openDatabase } from "../src/server/db.ts";
import { signUp,sessionUser } from "../src/server/auth.ts";
import { startEnrolment,confirmEnrolment,base32Decode,totp } from "../src/server/mfa.ts";
import { canonical } from "../src/server/audit.ts";
const url=process.env.RENTAL_PG_TEST_URL;
if(!url||!["localhost","127.0.0.1"].includes(new URL(url).hostname)||!new URL(url).pathname.startsWith("/c25_"))throw Error("A local c25_ test database is required");
const db=await openDatabase({url}),suffix=randomUUID().slice(0,8),accounts:Record<string,unknown>={};
try{
  for(const name of ["owner","alice","bob","staff"]){
    const username=`c25_${name}_${suffix}`,s=await signUp(db,{username,email:`${username}@example.com`,displayName:`Test ${name}`,password:`isolated-${randomUUID()}`,adult:"on",terms:"on"});
    let user=(await sessionUser(db,s.token))!;
    if(name==="staff"){await db.query("insert into user_roles(user_id,role,granted_by) values($1,'admin',$1)",[user.id]);user=(await sessionUser(db,s.token))!;const enrol=await startEnrolment(db,user);await confirmEnrolment(db,user,totp(base32Decode(enrol.secret)));user=(await sessionUser(db,s.token))!;}
    accounts[name]={user,token:s.token};
  }
  const template={localKey:"browser-server",name:"Browser dedicated server",game:"cs2",image:`registry.example.org/game@sha256:${"a".repeat(64)}`,command:["/game/server","--data","/data"],cpuMillis:1000,memoryMb:512,diskMb:1024,ports:[{name:"game",container:27015,protocol:"udp"}],env:{},secretEnv:{}};
  const fingerprint=createHash("sha256").update(canonical(template)).digest("hex");
  await mkdir("artifacts",{recursive:true});await writeFile("artifacts/c25-fixture.json",JSON.stringify({accounts,template,fingerprint}),{mode:0o600});console.log("Local rental browser fixture ready; credentials remain private.");
}finally{await db.close();}
