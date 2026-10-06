/**
 * Sponsors are records entered by platform administrators — only real, agreed partners. The homepage
 * strip and tournament pages show nothing until such a record exists and is active.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { requireSection } from "./access.ts";
import { fail } from "./errors.ts";
import { storeUpload } from "./media.ts";
import * as v from "./validate.ts";
import { requireStepUp } from "./mfa.ts";

export async function updateSponsor(db:Database,user:SessionUser,id:string,input:Record<string,unknown>,logo?:File|null) {
  requireSection(user,"sponsors"); requireStepUp(user);
  const name=v.displayName(input.name,80), website=v.optionalUrl(input.website), tier=String(input.tier);
  const version=v.intIn(input.version,1,2147483647),reason=v.clean(input.reason,500);
  if(!SPONSOR_TIERS.includes(tier as never)||reason.length<10) fail("invalid_input");
  await db.tx(async q=>{
    const [old]=await q.query<SponsorRow & {version:number}>("select * from sponsors where id=$1 for update",[id]);
    if(!old) fail("not_found"); if(old.version!==version) fail("not_editable");
    const newLogo=await storeUpload(q,user.id,"sponsor_logo",logo);
    const active=input.active==="1";
    await q.query("update sponsors set name=$2,tier=$3,website_url=$4,logo_media_id=$5,active=$6,version=version+1 where id=$1",
      [id,name,tier,website,input.removeLogo==="1"?null:newLogo??old.logo_media_id,active]);
    await audit(q,{actorId:user.id,action:"sponsor.updated",entity:"sponsor",entityId:id,data:{before:{name:old.name,tier:old.tier,website:old.website_url,active:old.active},name,tier,website,active,reason,version:version+1}});
  });
}

export const SPONSOR_TIERS = ["title", "gold", "silver", "partner"] as const;

export async function createSponsor(db: Database, user: SessionUser, input: { name: unknown; tier: unknown; website: unknown; logo?: File | null }) {
  requireSection(user, "sponsors");
  const name = v.displayName(input.name, 80);
  const tier = (SPONSOR_TIERS as readonly string[]).includes(String(input.tier)) ? String(input.tier) : fail("invalid_input");
  const website = v.optionalUrl(input.website);
  return db.tx(async (q) => {
    const logo = await storeUpload(q, user.id, "sponsor_logo", input.logo);
    const [row] = await q.query<{ id: string }>(
      "insert into sponsors (name, tier, website_url, logo_media_id, created_by) values ($1, $2, $3, $4, $5) returning id",
      [name, tier, website, logo, user.id],
    );
    await audit(q, { actorId: user.id, action: "sponsor.created", entity: "sponsor", entityId: row.id, data: { name, tier } });
    return row.id;
  });
}

export async function attachSponsor(db: Database, user: SessionUser, tournamentId: string, sponsorId: string, attach: boolean) {
  requireSection(user, "sponsors");
  await db.tx(async (q) => {
    const [t] = await q.query("select 1 from tournaments where id = $1", [tournamentId]);
    const [s] = await q.query("select 1 from sponsors where id = $1", [sponsorId]);
    if (!t || !s) fail("not_found");
    if (attach) await q.query("insert into tournament_sponsors (tournament_id, sponsor_id) values ($1, $2) on conflict do nothing", [tournamentId, sponsorId]);
    else await q.query("delete from tournament_sponsors where tournament_id = $1 and sponsor_id = $2", [tournamentId, sponsorId]);
    await audit(q, { actorId: user.id, action: attach ? "sponsor.attached" : "sponsor.detached", entity: "tournament", entityId: tournamentId, data: { sponsorId } });
  });
}

export type SponsorRow = { id: string; name: string; tier: string; website_url: string; logo_media_id: string | null; active: boolean };

export async function activeSponsors(q: Queryable) {
  return q.query<SponsorRow>(
    `select id, name, tier, website_url, logo_media_id, active from sponsors where active
      order by array_position(array['title','gold','silver','partner'], tier), name`,
  );
}

export async function allSponsors(q: Queryable) {
  return q.query<SponsorRow>("select id, name, tier, website_url, logo_media_id, active from sponsors order by created_at desc");
}

export async function tournamentSponsors(q: Queryable, tournamentId: string) {
  return q.query<SponsorRow>(
    `select s.id, s.name, s.tier, s.website_url, s.logo_media_id, s.active from tournament_sponsors ts join sponsors s on s.id = ts.sponsor_id
      where ts.tournament_id = $1 and s.active order by array_position(array['title','gold','silver','partner'], s.tier), s.name`,
    [tournamentId],
  );
}
