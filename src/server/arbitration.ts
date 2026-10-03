import { createHash } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { fail } from "./errors.ts";
import { audit } from "./audit.ts";
import { notify, staffWith, requireSection } from "./access.ts";
import { requireStaffMfa } from "./mfa.ts";
import * as v from "./validate.ts";

export const CASE_KINDS = ["marketplace","team","tournament","account","other"] as const;
export type CaseState = "open" | "reviewing" | "decided" | "appealed" | "closed";
export type CaseRow = { id: string; opened_by: string; respondent_id: string; category: string; title: string; status: CaseState; assigned_to: string | null; first_reviewer: string | null; outcome: string | null; created_at: Date; response_due: Date; updated_at: Date };
export type CaseEntry = { id: string; author_id: string; username: string; kind: string; body: string; evidence_url: string; digest: string; created_at: Date };
export const isParty = (c: CaseRow, id: string) => c.opened_by === id || c.respondent_id === id;
const text = (raw: unknown, min=20, max=4000) => { const s=v.clean(raw,max); if(s.length<min) fail("invalid_input"); return s; };
export const evidenceDigest = (body: string, url: string) => createHash("sha256").update(JSON.stringify([body,url])).digest("hex");
async function entry(q: Queryable, c: CaseRow, userId: string, kind: string, body: string, url="") {
  await q.query("insert into arbitration_entries(case_id,author_id,kind,body,evidence_url,digest) values($1,$2,$3,$4,$5,$6)",[c.id,userId,kind,body,url,evidenceDigest(body,url)]);
  await q.query("update arbitration_cases set updated_at=now() where id=$1",[c.id]);
  await audit(q,{actorId:userId,action:"arbitration."+kind,entity:"arbitration_case",entityId:c.id,data:{digest:evidenceDigest(body,url)}});
  await notify(q,[c.opened_by,c.respondent_id,...(c.assigned_to?[c.assigned_to]:[])].filter(x=>x!==userId),"arbitration_updated",{caseId:c.id});
}
async function locked(q: Queryable, id: string) {
  const [c]=await q.query<CaseRow>("select * from arbitration_cases where id=$1 for update",[id]);
  if(!c) fail("not_found");
  return c;
}
export async function openCase(db: Database,user: SessionUser,input: Record<string,unknown>) {
  const category=v.oneLine(input.category,20);
  if(!(CASE_KINDS as readonly string[]).includes(category)) fail("invalid_input");
  const title=text(input.title,5,150), body=text(input.body), username=v.username(input.username);
  const url=v.optionalUrl(input.evidence);
  return db.tx(async q=>{
    await q.query("select id from users where id=$1 for update",[user.id]);
    const [other]=await q.query<{id:string}>("select id from users where username=$1 and status='active'",[username]);
    if(!other) fail("not_found");
    if(other.id===user.id) fail("cannot_modify_self");
    const orderId=typeof input.orderId==="string" && /^[0-9a-f-]{36}$/i.test(input.orderId)?input.orderId:null;
    if(input.orderId && !orderId)fail("invalid_input");
    if(orderId){
      const [o]=await q.query<{seller_id:string;buyer_id:string;status:string;case_id:string|null}>("select * from skin_demo_orders where id=$1 for update",[orderId]);
      if(!o || ![o.seller_id,o.buyer_id].includes(user.id) || ![o.seller_id,o.buyer_id].includes(other.id) || category!=="marketplace")fail("forbidden");
      if(o.case_id)fail("dispute_exists");
      if(o.status==="cancelled")fail("not_editable");
    }

    const [recent]=await q.query<{n:number}>("select count(*)::int n from arbitration_cases where opened_by=$1 and created_at>now()-interval '1 hour'",[user.id]);
    if(recent.n>=10) fail("too_many_attempts");
    const [duplicate]=await q.query("select id from arbitration_cases where opened_by=$1 and respondent_id=$2 and category=$3 and title=$4 and status in ('open','reviewing','appealed')",[user.id,other.id,category,title]);
    if(duplicate) fail("duplicate_entry");
    const [c]=await q.query<CaseRow>("insert into arbitration_cases(opened_by,respondent_id,category,title) values($1,$2,$3,$4) returning *",[user.id,other.id,category,title]);
    if(orderId){
      await q.query("update arbitration_cases set demo_order_id=$2 where id=$1",[c.id,orderId]);
      await q.query("update skin_demo_orders set case_id=$2,status='disputed' where id=$1",[orderId,c.id]);
    }
    await entry(q,c,user.id,"opened",body,url);
    await notify(q,(await staffWith(q,"disputes")).filter(x=>x!==user.id && x!==other.id),"arbitration_updated",{caseId:c.id});
    return c.id;
  });
}
export async function myCases(q: Queryable,userId:string) {
  return q.query<CaseRow>("select * from arbitration_cases where $1 in (opened_by,respondent_id) order by updated_at desc limit 100",[userId]);
}
export async function staffCases(q: Queryable,user:SessionUser) {
  requireSection(user,"disputes"); await requireStaffMfa(q,user);
  return q.query<CaseRow>("select * from arbitration_cases where status in ('open','reviewing','appealed') order by created_at limit 100");
}
export async function readCase(q: Queryable,user:SessionUser,id:string) {
  const [c]=await q.query<CaseRow>("select * from arbitration_cases where id=$1",[id]);
  if(!c) fail("not_found");
  if(!isParty(c,user.id)){requireSection(user,"disputes");await requireStaffMfa(q,user);}
  const entries=await q.query<CaseEntry>("select e.*,u.username from arbitration_entries e join users u on u.id=e.author_id where case_id=$1 order by e.created_at,e.id",[id]);
  return {c,entries};
}
export async function addCaseEvidence(db:Database,user:SessionUser,id:string,body:unknown,url:unknown) {
  const statement=text(body), evidence=v.optionalUrl(url);
  await db.tx(async q=>{
    const c=await locked(q,id);
    if(!isParty(c,user.id)) fail("forbidden");
    if(!["open","reviewing","appealed"].includes(c.status)) fail("not_editable");
    const [recent]=await q.query<{n:number}>("select count(*)::int n from arbitration_entries where author_id=$1 and created_at>now()-interval '1 hour'",[user.id]);
    if(recent.n>=30) fail("too_many_attempts");
    await entry(q,c,user.id,"evidence",statement,evidence);
  });
}
export async function claimCase(db:Database,user:SessionUser,id:string) {
  requireSection(user,"disputes");await requireStaffMfa(db,user);
  await db.tx(async q=>{
    const c=await locked(q,id);
    if(isParty(c,user.id)||c.first_reviewer===user.id) fail("cannot_modify_self");
    if(!["open","appealed"].includes(c.status) || c.assigned_to) fail("not_editable");
    await q.query("update arbitration_cases set assigned_to=$2,status=case when status='open' then 'reviewing' else status end where id=$1",[id,user.id]);
    await entry(q,c,user.id,"assigned","Reviewer assigned");
  });
}
export async function decideCase(db:Database,user:SessionUser,id:string,outcome:unknown,body:unknown) {
  requireSection(user,"disputes");await requireStaffMfa(db,user);
  const statement=text(body), result=v.oneLine(outcome,30);
  if(!["claim_supported","claim_rejected","agreement"].includes(result)) fail("invalid_input");
  await db.tx(async q=>{
    const c=await locked(q,id);
    if(isParty(c,user.id)||c.assigned_to!==user.id||c.first_reviewer===user.id) fail("forbidden");
    if(!["reviewing","appealed"].includes(c.status)) fail("not_editable");
    let responseUser=c.respondent_id;
    if(c.status==="appealed"){
      const [a]=await q.query<{author_id:string}>("select author_id from arbitration_entries where case_id=$1 and kind='appeal' order by created_at desc limit 1",[id]);
      responseUser=a.author_id===c.opened_by?c.respondent_id:c.opened_by;
    }
    const [response]=await q.query("select id from arbitration_entries where case_id=$1 and author_id=$2 and kind='evidence' and created_at >= $3::timestamptz-interval '72 hours' limit 1",[id,responseUser,c.response_due]);
    if(!response && new Date(c.response_due).getTime()>Date.now()) fail("pending_reviews");
    const appeal=c.status==="appealed";
    await q.query("update arbitration_cases set status=$2,outcome=$3,first_reviewer=coalesce(first_reviewer,$4) where id=$1",[id,appeal?"closed":"decided",result,user.id]);
    await entry(q,c,user.id,appeal?"appeal_decision":"decision",statement);
  });
}
export async function appealCase(db:Database,user:SessionUser,id:string,body:unknown,url:unknown) {
  const statement=text(body),evidence=v.optionalUrl(url);
  await db.tx(async q=>{
    const c=await locked(q,id);
    if(!isParty(c,user.id)) fail("forbidden");
    if(c.status!=="decided") fail("not_editable");
    await q.query("update arbitration_cases set status='appealed',assigned_to=null,response_due=now()+interval '72 hours' where id=$1",[id]);
    await entry(q,c,user.id,"appeal",statement,evidence);
    await notify(q,(await staffWith(q,"disputes")).filter(x=>x!==c.first_reviewer && !isParty(c,x)),"arbitration_updated",{caseId:id});
  });
}
export async function arbitrationExport(q:Queryable,userId:string) {
  return {
    cases:await q.query("select * from arbitration_cases where $1 in (opened_by,respondent_id)",[userId]),
    entries:await q.query("select e.* from arbitration_entries e join arbitration_cases c on c.id=e.case_id where $1 in(c.opened_by,c.respondent_id) order by e.created_at",[userId])
  };
}
export async function eraseMarketData(q:Queryable,userId:string) {
  await q.query("update skin_demo_orders set status='cancelled' where $1 in(seller_id,buyer_id) and status in('requested','awaiting_payment')",[userId]);
  await q.query("delete from skin_listing_drafts where user_id=$1",[userId]);
  await q.query("update arbitration_cases set title='[removed]' where opened_by=$1",[userId]);
  const body="[removed]";
  await q.query("update arbitration_entries set body=$2,evidence_url='',digest=$3 where author_id=$1 and kind in ('opened','evidence','appeal')",[userId,body,evidenceDigest(body,"")]);
  // Decisions remain as operational records; the existing account erasure anonymises the user row.
}
