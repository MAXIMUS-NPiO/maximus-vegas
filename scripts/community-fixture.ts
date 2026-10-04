/** Disposable acceptance data. No emails, real provider calls or production records. */
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { openDatabase } from "../src/server/db.ts";
import { signUp, sessionUser } from "../src/server/auth.ts";
import { createTeam } from "../src/server/teams.ts";
import { reserveOrInvite } from "../src/server/username-reservations.ts";
const dataDir=process.env.MV_DATA_DIR;if(!dataDir?.startsWith("/tmp/c30-"))throw new Error("Isolated /tmp/c30- data directory required");
const db=await openDatabase({embedded:true,dataDir});
try{
 await mkdir("artifacts",{recursive:true});const tag=randomUUID().slice(0,8);
 async function account(prefix:string,displayName:string){const username=`${prefix}_${tag}`,a=await signUp(db,{username,displayName,email:`${username}@example.test`,password:`test-${randomUUID()}`,adult:true,terms:true});await writeFile(`artifacts/c30-${prefix}-state.json`,JSON.stringify({cookies:[{name:"mv_session",value:a.token,domain:"127.0.0.1",path:"/",httpOnly:true,secure:false,sameSite:"Lax",expires:Math.floor(Date.now()/1000)+86400}],origins:[]}),{mode:0o600});return(await sessionUser(db,a.token))!;}
 const captain=await account("captain","Captain acceptance"),player=await account("player","Player acceptance"),team=await createTeam(db,captain,{name:"Community acceptance team",tag:"C30",game:"cs2"});
 await reserveOrInvite(db,captain,team.id,`prior_${tag}`);
 await writeFile("artifacts/c30-fixture.json",JSON.stringify({captain:captain.username,player:player.username,team,prior:`prior_${tag}`,next:`new_${tag}`}),{mode:0o600});
 await sharp({create:{width:40,height:40,channels:3,background:"#446688"}}).png().toFile("artifacts/c30-avatar.png");
 console.log("Isolated community acceptance accounts prepared.");
}finally{await db.close();}
