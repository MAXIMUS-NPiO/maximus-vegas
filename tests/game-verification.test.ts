import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type Database } from '../src/server/db.ts';
import { PubgAdapter, VerificationError } from '../src/server/game-verification.ts';
// These responses are isolated protocol fixtures, never live acceptance evidence.
const account='account.'+'a'.repeat(32), match='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const env={PUBG_API_KEY:'isolated-test-placeholder',PUBG_SHARD:'steam',PUBG_MATCH_MODE:'normal'};
let db:Database;
test.before(async()=>{db=await openDatabase({embedded:true,dataDir:'memory://'});});test.after(()=>db.close());
const response=()=>({data:{type:'match',id:match,attributes:{createdAt:'2026-10-01T12:00:00Z',duration:1200,shardId:'steam',isCustomMatch:false,gameMode:'solo-fpp',matchType:'official'}},included:[{type:'participant',attributes:{stats:{playerId:account,kills:3,assists:1,headshotKills:1,damageDealt:322.5,walkDistance:1000,rideDistance:500,swimDistance:10,winPlace:4,deathType:'byplayer'}}}]});
const code=(s:string)=>(e:unknown)=>e instanceof VerificationError&&e.code===s;
test('PUBG missing credentials and invalid IDs fail closed without network requests',async()=>{
 const api=new PubgAdapter(db,{},async()=>{throw Error('must not fetch');});
 await assert.rejects(api.match(match,account),code('not_configured'));
 await assert.rejects(new PubgAdapter(db,env).match('../x',account),code('invalid_identity'));
});
test('PUBG canonical IDs, server authentication, real fields and timestamps; no invented deaths',async()=>{
 let calls=0;const api=new PubgAdapter(db,env,async(url,init)=>{calls++;assert.equal(String(url),`https://api.pubg.com/shards/steam/matches/${match}`);assert.equal(new Headers(init?.headers).get('authorization'),'Bearer isolated-test-placeholder');return Response.json(response());});
 const a=await api.match(match.toUpperCase(),account);assert.equal(a.matchId,match);assert.equal(a.stats.kills,3);assert.equal(a.stats.damage,322.5);assert.equal(a.stats.distance,1510);assert.equal(a.stats.deaths,undefined);assert.equal(a.reportedAt,'2026-10-01T12:00:00.000Z');assert.equal(a.liveVerified,false);assert.equal(calls,1);
});
test('PUBG refuses wrong identity, mode, malformed bodies and HTTP authentication errors',async()=>{
 const payload=response();payload.data.attributes.isCustomMatch=true;
 await assert.rejects(new PubgAdapter(db,env,async()=>Response.json(payload)).match(match,account),code('mode_mismatch'));
 await assert.rejects(new PubgAdapter(db,env,async()=>Response.json(response())).match(match,'account.'+'b'.repeat(32)),code('account_not_in_match'));
 await assert.rejects(new PubgAdapter(db,env,async()=>Response.json({data:{}})).match(match,account),code('invalid_response'));
 await assert.rejects(new PubgAdapter(db,env,async()=>new Response('',{status:401})).match(match,account),code('provider_auth'));
});
test('PUBG 429 creates a durable cooldown shared by new adapter instances',async()=>{
 await db.query("delete from game_api_limits");let calls=0;
 const network:typeof fetch=async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'120'}});};
 await assert.rejects(new PubgAdapter(db,env,network).match(match,account),code('rate_limited'));
 await assert.rejects(new PubgAdapter(db,env,network).match(match,account),code('rate_limited'));assert.equal(calls,1);
});
test('Steam ownership is required and no CS2 authority is invented',async()=>{
 const {cs2Receipt}=await import('../src/server/game-verification.ts');
 await assert.rejects(cs2Receipt(db,'00000000-0000-0000-0000-000000000001',match),code('ownership_required'));
});
test('provider verification pipeline refuses unknown submissions before any network call',async()=>{
 const {verifyPendingScore}=await import('../src/server/game-verification.ts');
 await assert.rejects(verifyPendingScore(db,'00000000-0000-0000-0000-000000000001',1,'00000000-0000-0000-0000-000000000002'),code('stale_submission'));
});
