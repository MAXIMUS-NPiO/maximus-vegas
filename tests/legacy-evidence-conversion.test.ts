import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { openDatabase } from '../src/server/db.ts';
import { signUp, sessionUser } from '../src/server/auth.ts';
import { convertLegacyEvidence, canSeeEvidence } from '../src/server/media.ts';
import { verifyAuditChain } from '../src/server/audit.ts';
test('explicit legacy conversion preserves private originals and hashes; malformed proof remains unchanged with audited refusal',async()=>{
 const db=await openDatabase({embedded:true,dataDir:'memory://'});try{
 const s=await signUp(db,{email:'mediaconverter@example.test',username:'mediaconverter',displayName:'Fixture operator',password:'isolated media password',adult:true,terms:true}),user=(await sessionUser(db,s.token))!;
 const actor={id:user.id,roles:['admin']};
 const good=await sharp({create:{width:32,height:24,channels:3,background:'red'}}).png().toBuffer(),bad=Buffer.from([137,80,78,71,13,10,26,10]);
 for(const original of [good,bad]){
 const hash=createHash('sha256').update(original).digest('hex');
 const [row]=await db.query<{id:string}>("insert into media(owner_id,kind,content_type,bytes,sha256,data)values($1,'evidence','image/png',$2,$3,$4)returning id",[user.id,original.length,hash,original]);
 await assert.rejects(convertLegacyEvidence(db,user,row.id,'Explicit legacy migration'),e=>Boolean(e&&typeof e==='object'&&'code'in e&&e.code==='forbidden'));
 const result=await convertLegacyEvidence(db,actor,row.id,'Explicit legacy migration');
 const [stored]=await db.query<{data:Uint8Array;original_data:Uint8Array|null;original_sha256:string;content_type:string}>('select data,original_data,original_sha256,content_type from media where id=$1',[row.id]);
 if(original===good){assert.equal(result.status,'normalized');assert.deepEqual(Buffer.from(stored.original_data!),good);assert.equal(stored.original_sha256,hash);assert.equal(stored.content_type,'image/webp');assert.equal((await sharp(stored.data).metadata()).format,'webp');assert.equal((await convertLegacyEvidence(db,actor,row.id,'Retry explicit conversion')).status,'already_normalized');}
 else{assert.equal(result.status,'invalid_legacy');assert.equal(stored.original_data,null);assert.deepEqual(Buffer.from(stored.data),bad);}
 assert.equal(await canSeeEvidence(db,row.id,null),false);assert.equal(await canSeeEvidence(db,row.id,user),false);assert.equal(await canSeeEvidence(db,row.id,actor),true);
 }
 assert.equal((await db.query("select 1 from audit_log where action in('media.legacy_converted','media.legacy_conversion_refused')")).length,2);
 assert.equal((await verifyAuditChain(db)).valid,true);
 }finally{await db.close();}
});
