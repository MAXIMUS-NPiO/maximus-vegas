import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.ts";
import { signUp, sessionUser } from "../src/server/auth.ts";
import { openCase, readCase, addCaseEvidence, claimCase, decideCase, appealCase, eraseMarketData, evidenceDigest } from "../src/server/arbitration.ts";
import { saveListingDraft, deleteListingDraft, listingDrafts, priceMinor, marketplaceReadiness } from "../src/server/marketplace.ts";
test("skins drafts stay private, reject duplicate assets and cannot enable trading",async()=>{
 const db=await openDatabase({embedded:true,dataDir:"memory://"});
 try{
 const make=async(name:string)=>{const s=await signUp(db,{username:name,email:name+"@example.com",displayName:name,password:"Test-pass-123456",adult:"on",terms:"on"});return (await sessionUser(db,s.token))!;};
 const a=await make("marketalpha"),b=await make("marketbeta");
 assert.equal(priceMinor("10.01"),1001); for(const v of ["0","-1","1e2","1.001","1x5","1000001"])assert.throws(()=>priceMinor(v));
 const input={game:"cs2",title:"Test item",asset:"12345",price:"10.50",currency:"USD"};
 const id=await saveListingDraft(db,a,input);
 assert.equal((await listingDrafts(db,b.id)).length,0);
 await assert.rejects(saveListingDraft(db,a,input),(e:any)=>e.code==="duplicate_entry");
 await assert.rejects(deleteListingDraft(db,b,id),(e:any)=>e.code==="not_found");
 assert.equal(marketplaceReadiness().trading,false);
 await deleteListingDraft(db,a,id);assert.equal((await listingDrafts(db,a.id)).length,0);
 }finally{await db.close();}
});
test("arbitration enforces privacy, MFA, response period, independent appeal and redaction",async()=>{
 const db=await openDatabase({embedded:true,dataDir:"memory://"});
 try{
 const make=async(name:string)=>{const s=await signUp(db,{username:name,email:name+"@example.com",displayName:name,password:"Test-pass-123456",adult:"on",terms:"on"});return (await sessionUser(db,s.token))!;};
 const a=await make("casealpha"),b=await make("casebeta"),outside=await make("caseoutsider"),r1=await make("reviewone"),r2=await make("reviewtwo");
 for(const r of [r1,r2]){r.roles=["support"];r.mfaAt=new Date();await db.query("insert into mfa_factors(user_id,secret,scheme,confirmed_at) values($1,'test','plain',now())",[r.id]);}
 const input={username:b.username,category:"marketplace",title:"Delivery dispute",body:"The item was not delivered as agreed.",evidence:"https://example.com/evidence"};
 const id=await openCase(db,a,input);
 await assert.rejects(openCase(db,a,{...input,username:"doesnotexist"}),(e:any)=>e.code==="not_found");
 await assert.rejects(openCase(db,a,input),(e:any)=>e.code==="duplicate_entry");
 await assert.rejects(readCase(db,outside,id),(e:any)=>e.code==="forbidden");
 await assert.rejects(claimCase(db,{...a,roles:["admin"]},id));
 await assert.rejects(claimCase(db,{...r1,mfaAt:null},id),(e:any)=>e.code==="mfa_required");
 await claimCase(db,r1,id);
 await assert.rejects(claimCase(db,r2,id),(e:any)=>e.code==="not_editable");
 await assert.rejects(decideCase(db,r1,id,"claim_supported","Reviewed all available evidence."),(e:any)=>e.code==="pending_reviews");
 await addCaseEvidence(db,b,id,"Here is my response to this claim.","https://example.com/response");
 await decideCase(db,r1,id,"claim_supported","Reviewed all available evidence.");
 await assert.rejects(addCaseEvidence(db,a,id,"Cannot change a decided case.",""),(e:any)=>e.code==="not_editable");
 await appealCase(db,b,id,"Please review the first decision again.","");
 await assert.rejects(claimCase(db,r1,id),(e:any)=>e.code==="cannot_modify_self");
 await claimCase(db,r2,id);
 await assert.rejects(decideCase(db,r2,id,"claim_rejected","An independent decision on the appeal."),(e:any)=>e.code==="pending_reviews");
 await addCaseEvidence(db,a,id,"My response to the appeal is recorded.","");
 await decideCase(db,r2,id,"claim_rejected","An independent decision on the appeal.");
 const result=await readCase(db,a,id);assert.equal(result.c.status,"closed");assert.equal(result.entries.filter(e=>e.kind.includes("decision")).length,2);
 await assert.rejects(appealCase(db,a,id,"A further appeal cannot duplicate.",""),(e:any)=>e.code==="not_editable");
 for(const e of result.entries)assert.equal(e.digest,evidenceDigest(e.body,e.evidence_url));
 await db.tx(q=>eraseMarketData(q,b.id));
 const redacted=await readCase(db,a,id);assert.ok(redacted.entries.filter(e=>e.author_id===b.id).every(e=>e.body==="[removed]"&&e.evidence_url===""));
 }finally{await db.close();}
});

test("public listings and simulated orders preserve roles, snapshots and dispute holds",async()=>{
 const db=await openDatabase({embedded:true,dataDir:"memory://"});
 try{
 const make=async(name:string)=>{const s=await signUp(db,{username:name,email:name+"@example.com",displayName:name,password:"Test-pass-123456",adult:"on",terms:"on"});return (await sessionUser(db,s.token))!;};
 const seller=await make("simpleseller"),buyer=await make("simplebuyer"),outsider=await make("outsiderbuyer");
 const {publishListing,publicListings,requestDemoOrder,demoOrderStep,myMarketOrders}=await import("../src/server/marketplace.ts");
 const id=await saveListingDraft(db,seller,{game:"cs2",title:"Public item",asset:"888",price:"5.25",currency:"USD"});
 assert.equal((await publicListings(db)).length,0);
 await publishListing(db,seller,id,true);assert.equal((await publicListings(db))[0].title,"Public item");
 await assert.rejects(requestDemoOrder(db,seller,id),(e:any)=>e.code==="cannot_modify_self");
 const [o,o2]=await Promise.all([requestDemoOrder(db,buyer,id),requestDemoOrder(db,buyer,id)]);assert.equal(o,o2);
 await assert.rejects(demoOrderStep(db,buyer,o,"accept"),(e:any)=>e.code==="invalid_transition");
 await demoOrderStep(db,seller,o,"accept");
 await assert.rejects(demoOrderStep(db,seller,o,"pay"),(e:any)=>e.code==="invalid_transition");
 await demoOrderStep(db,buyer,o,"pay");
 await assert.rejects(demoOrderStep(db,buyer,o,"pay"),(e:any)=>e.code==="invalid_transition");
 const c=await openCase(db,buyer,{username:seller.username,category:"marketplace",title:"Dispute on simulated delivery",body:"This simulated transaction needs review.",orderId:o});
 await assert.rejects(demoOrderStep(db,seller,o,"deliver"),(e:any)=>e.code==="pending_reviews");
 assert.equal((await myMarketOrders(db,buyer.id))[0].case_id,c);
 assert.equal((await myMarketOrders(db,outsider.id)).length,0);
 await deleteListingDraft(db,seller,id);
 assert.equal((await myMarketOrders(db,buyer.id))[0].price_minor,525);
 assert.equal((await myMarketOrders(db,buyer.id))[0].listing_id,null);
 }finally{await db.close();}
});
