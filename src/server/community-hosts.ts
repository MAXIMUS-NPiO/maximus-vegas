import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { activeAccount } from "./product-access.ts";
import { requireSection, notify, staffWith } from "./access.ts";
import { audit } from "./audit.ts";
import { fail } from "./errors.ts";
import * as v from "./validate.ts";

export type CommunityHost = { user_id: string; role: "host" | "psychologist"; bio: string; languages: string; jurisdiction: string; organisation: string; credential: string; credential_url: string; booking_url: string; status: string; version: number; verified_until: Date | null; review_note: string; username: string; display_name: string; avatar_media_id: string | null };
const httpsUrl = (value: unknown) => {
  const raw = v.oneLine(value, 500); if (!raw) return "";
  try { const u = new URL(raw); if (u.protocol !== "https:" || u.username || u.password) fail("invalid_url"); return u.toString(); } catch { return fail("invalid_url"); }
};
export async function applyCommunityHost(db: Database, user: SessionUser, input: Record<string, unknown>) {
  const role = String(input.role); if (!["host", "psychologist"].includes(role) || !v.bool(input.consent)) fail("consent_required");
  const bio = v.clean(input.bio, 600), languages = v.oneLine(input.languages, 100), jurisdiction = v.oneLine(input.jurisdiction, 100), organisation = v.oneLine(input.organisation, 150);
  const credential = v.oneLine(input.credential, 150), credentialUrl = httpsUrl(input.credentialUrl), bookingUrl = httpsUrl(input.bookingUrl);
  if (bio.length < 30 || !languages || !jurisdiction || !organisation || (role === "psychologist" && (!credential || !credentialUrl || !bookingUrl))) fail("invalid_input");
  await db.tx(async q => {
    await q.query("select id from users where id=$1 for update", [user.id]); await activeAccount(q, user);
    const [rate] = await q.query<{ n: number }>("select count(*)::int as n from audit_log where actor_id=$1 and action='community.host_applied' and at>now()-interval '1 day'", [user.id]);
    if (rate.n >= 10) fail("request_limit");
    if ((await q.query("select 1 from community_hosts where user_id=$1 and status='suspended'", [user.id]))[0]) fail("account_restricted");
    await q.query(`insert into community_hosts(user_id,role,bio,languages,jurisdiction,organisation,credential,credential_url,booking_url)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(user_id) do update set role=$2,bio=$3,languages=$4,jurisdiction=$5,organisation=$6,
      credential=$7,credential_url=$8,booking_url=$9,status='pending',version=community_hosts.version+1,reviewed_by=null,verified_until=null,review_note='',updated_at=now()`,
      [user.id, role, bio, languages, jurisdiction, organisation, credential, credentialUrl, bookingUrl]);
    await notify(q,await staffWith(q,"academy"),"community_host_review",{adminTab:"academy"});
    await audit(q, { actorId: user.id, action: "community.host_applied", entity: "user", entityId: user.id, data: { role } });
  });
}
export async function reviewCommunityHost(db: Database, staff: SessionUser, id: string, input: Record<string, unknown>) {
  requireSection(staff, "academy");
  const status = String(input.status), version = v.intIn(input.version, 1, 100000), note = v.clean(input.note, 1000);
  if (id === staff.id || !["verified", "rejected", "suspended"].includes(status) || note.length < 20) fail("invalid_input");
  const until = status === "verified" ? new Date(String(input.until)) : null;
  if (until && (!Number.isFinite(until.getTime()) || until.getTime() <= Date.now() || until.getTime() > Date.now() + 366 * 86400000)) fail("invalid_date");
  if (status === "verified" && !v.bool(input.verified)) fail("consent_required");
  await db.tx(async q => {
    const [row] = await q.query<CommunityHost>("select * from community_hosts where user_id=$1 for update", [id]);
    if (!row || row.version !== version) fail("request_state");
    if (status === "verified" && row.role === "psychologist" && (!row.credential || !row.credential_url || !row.booking_url)) fail("invalid_input");
    await q.query("update community_hosts set status=$2,review_note=$3,reviewed_by=$4,verified_until=$5,updated_at=now() where user_id=$1", [id, status, note, staff.id, until]);
    await notify(q,[id],"community_host_decision",{communitySupport:"1"});
    await audit(q, { actorId: staff.id, action: "community.host_reviewed", entity: "user", entityId: id, data: { status, version } });
  });
}
export async function communityHosts(q: Queryable) {
  return q.query<CommunityHost>(`select h.user_id,h.role,h.bio,h.languages,h.jurisdiction,h.organisation,h.credential,h.credential_url,h.booking_url,h.verified_until,u.username,u.display_name,u.avatar_media_id
    from community_hosts h join users u on u.id=h.user_id where h.status='verified' and h.verified_until>now() and u.status='active'
    and not exists(select 1 from sanctions s where s.user_id=u.id and s.kind='suspension' and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now()))
    order by h.role,u.display_name limit 100`);
}
