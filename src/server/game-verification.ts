/** Server-only integration preparation. NOT live-verified; receipts never approve scores. */
import {createHash} from 'node:crypto';
import type {Database} from './db.ts';
export class VerificationError extends Error {
  readonly code:string;
  constructor(code:string){super(code);this.name='VerificationError';this.code=code;}
}
const reject=(code:string):never=>{throw new VerificationError(code);};
const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:reject('invalid_response');
const numeric=(value:unknown,max=1e8)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max?value:reject('invalid_response');
const integer=(value:unknown,max=130)=>Number.isInteger(numeric(value,max))?Number(value):reject('invalid_response');
export function canonicalMatchId(value:string){const id=value.trim().toLowerCase();return /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)?id:reject('invalid_identity');}
export type MatchReceipt={provider:'pubg'|'cs2-authority';accountId:string;matchId:string;reportedAt:string;durationSeconds:number;gameMode:string;custom:boolean;stats:Partial<Record<'kills'|'assists'|'deaths'|'headshots'|'damage'|'distance'|'placement',number>>;responseHash:string;liveVerified:false};
type Env=Partial<NodeJS.ProcessEnv>;
export class PubgAdapter {
  private db:Database;private env:Env;private request:typeof fetch;
  constructor(db:Database,env:Env=process.env,request:typeof fetch=fetch){this.db=db;this.env=env;this.request=request;}
  private config(){
    const {PUBG_API_KEY:key,PUBG_SHARD:shard,PUBG_MATCH_MODE:mode}=this.env;
    if(!key||!shard||!['steam','kakao','psn','xbox','console'].includes(shard)||!['normal','custom'].includes(mode??''))reject('not_configured');
    return {key:key!,shard:shard!,custom:mode==='custom'};
  }
  private async budget(){
    const configured=Number(this.env.PUBG_REQUESTS_PER_MINUTE??10);
    const limit=Number.isInteger(configured)&&configured>=1&&configured<=10?configured:10;
    await this.db.tx(async q=>{
      await q.query("insert into game_api_limits(provider) values('pubg') on conflict do nothing");
      const [r]=await q.query<{requests:number;window_at:Date;retry_at:Date|null}>("select * from game_api_limits where provider='pubg' for update");
      const now=Date.now();if(r.retry_at&&+new Date(r.retry_at)>now)reject('rate_limited');
      const fresh=now-+new Date(r.window_at)>=60_000;
      if(!fresh&&r.requests>=limit)reject('rate_limited');
      await q.query("update game_api_limits set requests=$1,window_at=$2 where provider='pubg'",[fresh?1:r.requests+1,fresh?new Date(now):r.window_at]);
    });
  }
  private async get(path:string){
    const config=this.config();await this.budget();let response:Response;
    try{response=await this.request(`https://api.pubg.com/shards/${config.shard}/${path}`,{headers:{Authorization:`Bearer ${config.key}`,Accept:'application/vnd.api+json'},signal:AbortSignal.timeout(5000),redirect:'error',cache:'no-store'});}catch{reject('provider_unavailable');}
    if(response!.status===429){
      const raw=response!.headers.get('retry-after');const seconds=raw&&/^\d+$/.test(raw)?Number(raw):raw?(Date.parse(raw)-Date.now())/1000:60;
      const reset=Number(response!.headers.get('x-ratelimit-reset'))*1000;
      const until=Math.max(Date.now()+Math.max(1,Math.min(Number.isFinite(seconds)?seconds:60,3600))*1000,Math.min(Number.isFinite(reset)?reset:0,Date.now()+3600_000));
      await this.db.query("update game_api_limits set retry_at=greatest(retry_at,$1::timestamptz) where provider='pubg'",[new Date(until)]);reject('rate_limited');
    }
    if([401,403].includes(response!.status))reject('provider_auth');if(response!.status===404)reject('match_unavailable');if(!response!.ok)reject('provider_unavailable');
    // Bound the decoded stream, not merely a potentially absent Content-Length header.
    const reader=response!.body?.getReader();if(!reader)reject('invalid_response');let size=0;const chunks:Uint8Array[]=[];
    try{while(true){const chunk=await reader!.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>2_000_000){await reader!.cancel();reject('response_too_large');}chunks.push(chunk.value);}}catch(e){if(e instanceof VerificationError)throw e;reject('provider_unavailable');}
    const text=Buffer.concat(chunks).toString('utf8');let json:unknown;try{json=JSON.parse(text);}catch{reject('invalid_response');}
    return {json:record(json),hash:createHash('sha256').update(text).digest('hex')};
  }
  async account(accountId:string){
    this.config();if(!/^account\.[a-f0-9]{32}$/.test(accountId))reject('invalid_identity');
    const {json}=await this.get(`players/${accountId}`);const data=record(json.data);
    if(data.type!=='player'||data.id!==accountId)reject('invalid_response');
    // Lookup is not proof of ownership; do not create a binding from this response.
    return {accountId,liveVerified:false as const};
  }
  async match(matchInput:string,accountId:string):Promise<MatchReceipt>{
    const config=this.config(),matchId=canonicalMatchId(matchInput);if(!/^account\.[a-f0-9]{32}$/.test(accountId))reject('invalid_identity');
    const {json,hash}=await this.get(`matches/${matchId}`),data=record(json.data),attributes=record(data.attributes);
    if(data.type!=='match'||data.id!==matchId||attributes.shardId!==config.shard||typeof attributes.isCustomMatch!=='boolean'||typeof attributes.gameMode!=='string')reject('invalid_response');
    if(attributes.isCustomMatch!==config.custom||(this.env.PUBG_GAME_MODE&&attributes.gameMode!==this.env.PUBG_GAME_MODE))reject('mode_mismatch');
    if(!config.custom&&attributes.matchType!=='official')reject('mode_mismatch');
    const timestamp=typeof attributes.createdAt==='string'?Date.parse(attributes.createdAt):NaN;if(!Number.isFinite(timestamp))reject('invalid_response');
    const included=Array.isArray(json.included)?json.included:reject('invalid_response');
    const participants=included.filter(x=>record(x).type==='participant').map(x=>record(record(record(x).attributes).stats)).filter(s=>s.playerId===accountId);
    if(participants.length!==1)reject('account_not_in_match');const s=participants[0];
    return {provider:'pubg',accountId,matchId,reportedAt:new Date(timestamp).toISOString(),durationSeconds:integer(attributes.duration,86400),gameMode:attributes.gameMode as string,custom:config.custom,
      stats:{kills:integer(s.kills),assists:integer(s.assists),headshots:integer(s.headshotKills),damage:numeric(s.damageDealt),distance:numeric(s.walkDistance)+numeric(s.rideDistance)+numeric(s.swimDistance),placement:integer(s.winPlace)},responseHash:hash,liveVerified:false};
  }
}
/** A trusted server-side authority must implement this. Steam identity/history is not a CS2 result authority. */
export interface Cs2ResultAuthority {match(matchId:string,verifiedSteamId:string):Promise<MatchReceipt>}
export async function cs2Receipt(db:Database,userId:string,matchId:string,authority?:Cs2ResultAuthority){
  const [identity]=await db.query<{steam_id:string}>("select i.steam_id from player_experience_identities i join users u on u.id=i.user_id and u.status='active' where i.user_id=$1",[userId]);
  if(!identity)reject('ownership_required');if(!authority)reject('authority_not_configured');
  const receipt=await authority!.match(matchId,identity.steam_id);
  if(receipt.provider!=='cs2-authority'||receipt.accountId!==identity.steam_id||receipt.matchId!==matchId)reject('identity_mismatch');return receipt;
}
/** Persist provider evidence against an immutable revision. Deliberately does not approve a score. */
export async function attachVerificationReceipt(db:Database,entryId:string,revision:number,userId:string,receipt:MatchReceipt){
  if(!/^[a-f0-9]{64}$/.test(receipt.responseHash)||!Number.isFinite(Date.parse(receipt.reportedAt)))reject('invalid_response');
  return db.tx(async q=>{
    // Share the account lock with deletion so an in-flight provider request cannot persist after closure.
    const [active]=await q.query("select id from users where id=$1 and status='active' for no key update",[userId]);
    if(!active)reject('ownership_required');
    const [entry]=await q.query<{revision:number;review:string;registration_id:string;match_ref:string;game:string}>(`select e.revision,e.review,e.registration_id,e.match_ref,t.game from score_entries e join tournaments t on t.id=e.tournament_id where e.id=$1 for update of e`,[entryId]);
    if(!entry||entry.revision!==revision||entry.review!=='pending')reject('stale_submission');
    const member=await q.query('select 1 from roster_entries where registration_id=$1 and user_id=$2',[entry.registration_id,userId]);if(!member.length)reject('identity_mismatch');
    const game=receipt.provider==='pubg'?'pubg':'cs2';if(entry.game!==game||entry.match_ref!==receipt.matchId)reject('identity_mismatch');
    const owned=game==='cs2'?await q.query('select 1 from player_experience_identities where user_id=$1 and steam_id=$2',[userId,receipt.accountId]):await q.query("select 1 from game_account_bindings where user_id=$1 and game='pubg' and account_id=$2 and revoked_at is null",[userId,receipt.accountId]);
    if(!owned.length)reject('ownership_required');
    const [old]=await q.query<{entry_id:string;revision:number}>('select entry_id,revision from score_verification_receipts where game=$1 and account_id=$2 and match_id=$3',[game,receipt.accountId,receipt.matchId]);
    if(old&&old.entry_id!==entryId)reject('duplicate_match');
    await q.query(`insert into score_verification_receipts(game,account_id,match_id,entry_id,revision,receipt) values($1,$2,$3,$4,$5,$6)
      on conflict(game,account_id,match_id) do update set revision=excluded.revision,receipt=excluded.receipt where score_verification_receipts.entry_id=excluded.entry_id returning entry_id`,[game,receipt.accountId,receipt.matchId,entryId,revision,JSON.stringify(receipt)]).then(rows=>{if(!rows.length)reject('duplicate_match');});
    return {review:'pending',liveVerified:false};
  });
}
/** Internal job/service entry point. The caller supplies only a saved entry/revision and its roster member.
 * No HTTP endpoint accepts provider receipts or ownership assertions from players. */
export async function verifyPendingScore(db:Database,entryId:string,revision:number,userId:string,options:{pubg?:PubgAdapter;cs2?:Cs2ResultAuthority}={}){
  const [entry]=await db.query<{revision:number;review:string;game:string;match_ref:string;members:number}>(`select e.revision,e.review,e.match_ref,t.game,(select count(*)::int from roster_entries r where r.registration_id=e.registration_id) members
    from score_entries e join tournaments t on t.id=e.tournament_id join users u on u.id=$2 and u.status='active' join roster_entries r on r.registration_id=e.registration_id and r.user_id=$2 where e.id=$1`,[entryId,userId]);
  if(!entry||entry.revision!==revision||entry.review!=='pending')reject('stale_submission');
  // Team aggregation cannot be inferred from an individual player's record.
  if(entry.members!==1)reject('team_rules_required');
  let receipt:MatchReceipt;
  if(entry.game==='pubg'){
    const [binding]=await db.query<{account_id:string}>("select account_id from game_account_bindings where game='pubg' and user_id=$1 and revoked_at is null",[userId]);
    if(!binding)reject('ownership_required');receipt=await(options.pubg??new PubgAdapter(db)).match(entry.match_ref,binding.account_id);
  }else if(entry.game==='cs2')receipt=await cs2Receipt(db,userId,entry.match_ref,options.cs2);
  else return reject('unsupported_game');
  return attachVerificationReceipt(db,entryId,revision,userId,receipt);
}
