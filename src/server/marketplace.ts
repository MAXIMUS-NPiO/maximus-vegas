import { notify } from "./access.ts";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { fail } from "./errors.ts";
import { audit } from "./audit.ts";
import * as v from "./validate.ts";

export const SKIN_GAMES = { cs2: "Counter-Strike 2", dota2: "Dota 2", rust: "Rust", tf2: "Team Fortress 2" } as const;
export const MARKET_CURRENCIES = ["USD", "EUR", "AED"] as const;
/** Deliberately fail closed. An environment flag alone must never enable unimplemented settlement. */
export function marketplaceReadiness() {
  return { inventory: false, transfers: false, payments: false, trading: false } as const;
}
export type ListingDraft = { id: string; game: string; title: string; asset_ref: string; price_minor: number; currency: string; created_at: Date; published:boolean };
export function priceMinor(raw: unknown) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!/^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$/.test(value)) fail("invalid_input");
  const [whole, fraction = ""] = value.split(".");
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (n < 1 || n > 100000000) fail("invalid_input");
  return n;
}
export async function saveListingDraft(db: Database, user: SessionUser, input: Record<string, unknown>) {
  if (user.restricted) fail("account_suspended");
  const game = v.oneLine(input.game, 20);
  if (!(game in SKIN_GAMES)) fail("invalid_game");
  const title = v.oneLine(input.title, 150);
  const asset = v.oneLine(input.asset, 100);
  const currency = v.oneLine(input.currency, 3);
  if (title.length < 3 || !/^[a-zA-Z0-9:_-]{1,100}$/.test(asset) || !(MARKET_CURRENCIES as readonly string[]).includes(currency)) fail("invalid_input");
  const price = priceMinor(input.price);
  return db.tx(async q => {
    await q.query("select id from users where id=$1 for update", [user.id]);
    const [old] = await q.query<{id:string}>("select id from skin_listing_drafts where user_id=$1 and game=$2 and asset_ref=$3", [user.id, game, asset]);
    if (old) fail("duplicate_entry");
    const [r] = await q.query<{id:string}>("insert into skin_listing_drafts(user_id,game,title,asset_ref,price_minor,currency) values($1,$2,$3,$4,$5,$6) returning id", [user.id,game,title,asset,price,currency]);
    await audit(q,{actorId:user.id,action:"marketplace.draft_created",entity:"skin_listing",entityId:r.id});
    return r.id;
  });
}
export const listingDrafts = (q: Queryable, userId: string) => q.query<ListingDraft>("select id,game,title,asset_ref,price_minor,currency,created_at,published from skin_listing_drafts where user_id=$1 order by created_at desc", [userId]);
export async function deleteListingDraft(db: Database, user: SessionUser, id: string) {
  await db.tx(async q => {
    const rows = await q.query("delete from skin_listing_drafts where id=$1 and user_id=$2 returning id", [id,user.id]);
    if (!rows.length) fail("not_found");
    await audit(q,{actorId:user.id,action:"marketplace.draft_deleted",entity:"skin_listing",entityId:id});
  });
}

export type MarketOrder = {id:string;listing_id:string|null;seller_id:string;buyer_id:string;title:string;game:string;price_minor:number;currency:string;status:string;case_id:string|null;seller:string;buyer:string;created_at:Date};
export async function publishListing(db:Database,user:SessionUser,id:string,publish:boolean){
 if(user.restricted) fail("account_suspended");
 await db.tx(async q=>{
  const [r]=await q.query("update skin_listing_drafts set published=$3 where id=$1 and user_id=$2 returning id",[id,user.id,publish]);
  if(!r)fail("not_found");
  await audit(q,{actorId:user.id,action:publish?"marketplace.published":"marketplace.unpublished",entity:"skin_listing",entityId:id});
 });
}
export const publicListings=(q:Queryable,game="")=>q.query<ListingDraft & {user_id:string;username:string}>(
 "select d.*,u.username from skin_listing_drafts d join users u on u.id=d.user_id where d.published=true and u.status='active' and ($1='' or d.game=$1) order by d.created_at desc limit 100",[game]);
export const myMarketOrders=(q:Queryable,id:string)=>q.query<MarketOrder>("select o.*,s.username seller,b.username buyer from skin_demo_orders o join users s on s.id=o.seller_id join users b on b.id=o.buyer_id where $1 in (o.seller_id,o.buyer_id) order by o.created_at desc limit 100",[id]);
export async function requestDemoOrder(db:Database,user:SessionUser,listingId:string){
 if(user.restricted)fail("account_suspended");
 return db.tx(async q=>{
  const [l]=await q.query<ListingDraft & {user_id:string;published:boolean}>("select * from skin_listing_drafts where id=$1 for update",[listingId]);
  if(!l||!l.published)fail("not_found");if(l.user_id===user.id)fail("cannot_modify_self");
  const [old]=await q.query<{id:string}>("select id from skin_demo_orders where listing_id=$1 and buyer_id=$2 and status not in ('cancelled','completed')",[listingId,user.id]);
  if(old)return old.id;
  const [r]=await q.query<{id:string}>("insert into skin_demo_orders(listing_id,seller_id,buyer_id,title,game,price_minor,currency) values($1,$2,$3,$4,$5,$6,$7) returning id",[listingId,l.user_id,user.id,l.title,l.game,l.price_minor,l.currency]);
  await audit(q,{actorId:user.id,action:"marketplace.demo_requested",entity:"skin_demo_order",entityId:r.id});
  await notify(q,[l.user_id],"marketplace_updated",{marketplace:"1"});
  return r.id;
 });
}
export async function demoOrderStep(db:Database,user:SessionUser,id:string,step:string){
 if(user.restricted && step!=="cancel")fail("account_suspended");
 await db.tx(async q=>{
  // Serialise transitions and dispute opening on this row.
  const [o]=await q.query<MarketOrder>("select * from skin_demo_orders where id=$1 for update",[id]);
  if(!o||![o.seller_id,o.buyer_id].includes(user.id))fail("not_found");
  if(o.status==="disputed"||o.case_id)fail("pending_reviews");
  let next="";
  if(step==="accept"&&user.id===o.seller_id&&o.status==="requested")next="awaiting_payment";
  if(step==="pay"&&user.id===o.buyer_id&&o.status==="awaiting_payment")next="payment_simulated";
  if(step==="deliver"&&user.id===o.seller_id&&o.status==="payment_simulated")next="delivery_simulated";
  if(step==="confirm"&&user.id===o.buyer_id&&o.status==="delivery_simulated")next="completed";
  if(step==="cancel"&&["requested","awaiting_payment"].includes(o.status))next="cancelled";
  if(!next)fail("invalid_transition");
  await q.query("update skin_demo_orders set status=$2 where id=$1",[id,next]);
  await audit(q,{actorId:user.id,action:"marketplace.demo_"+step,entity:"skin_demo_order",entityId:id,data:{from:o.status,to:next,simulated:true}});
  await notify(q,[user.id===o.seller_id?o.buyer_id:o.seller_id],"marketplace_updated",{marketplace:"1"});
 });
}
