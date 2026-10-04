import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { activeAccount } from "./product-access.ts";
import { audit } from "./audit.ts";
import { fail } from "./errors.ts";

const uuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
async function leadership(q: Queryable, user: SessionUser, clanId: string) {
  await activeAccount(q, user);
  if (!(await q.query("select 1 from clan_members where clan_id=$1 and user_id=$2 and role in ('owner','officer')", [clanId, user.id]))[0]) fail("not_clan_leader");
}
export async function proposeClanRelationship(db: Database, user: SessionUser, clan: string, otherTag: string, kind: string) {
  if (!uuid(clan) || !["allies", "rivals"].includes(kind)) fail("invalid_input");
  return db.tx(async q => {
    const [other] = await q.query<{ id: string }>("select id from clans where tag=$1 and status='active'", [otherTag.trim().toUpperCase()]);
    if (!other || other.id === clan) fail("not_found");
    const [a, b] = [clan, other.id].sort();
    const rows = await q.query("select id from clans where id=any($1::uuid[]) and status='active' order by id for update", [[a, b]]);
    if (rows.length !== 2) fail("not_found");
    await leadership(q, user, clan);
    const [old] = await q.query<{ status: string; recent: boolean; valid: boolean }>("select status,expires_at>now() as valid,updated_at>now()-interval '7 days' as recent from clan_relationships where clan_a=$1 and clan_b=$2", [a, b]);
    if (old && (old.status === "active" || (old.status === "pending" && old.valid) || (old.status === "ended" && old.recent))) fail("request_exists");
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from clan_relationships where $1 in(clan_a,clan_b) and (status='active' or (status='pending' and expires_at>now()))", [clan]);
    if (n.n >= 10) fail("request_limit");
    await q.query(`insert into clan_relationships(clan_a,clan_b,proposed_by,kind) values($1,$2,$3,$4)
      on conflict(clan_a,clan_b) do update set proposed_by=$3,kind=$4,status='pending',updated_at=now(),expires_at=now()+interval '7 days'`, [a, b, clan, kind]);
    await audit(q, { actorId: user.id, action: "clan.relationship_proposed", entity: "clan", entityId: clan, data: { other: other.id, kind } });
  });
}
export async function respondClanRelationship(db: Database, user: SessionUser, id: string, clan: string, action: string) {
  if (!uuid(id) || !uuid(clan) || !["accept", "end"].includes(action)) fail("invalid_input");
  await db.tx(async q => {
    const [initial] = await q.query<{ clan_a: string; clan_b: string }>("select clan_a,clan_b from clan_relationships where id=$1 and $2 in(clan_a,clan_b)", [id, clan]);
    if (!initial) fail("not_found");
    const rows = await q.query("select id from clans where id=any($1::uuid[]) and status='active' order by id for update", [[initial.clan_a, initial.clan_b]]);
    if (rows.length !== 2) fail("not_found");
    await leadership(q, user, clan);
    const [r] = await q.query<{ proposed_by: string; status: string; valid: boolean }>("select proposed_by,status,expires_at>now() as valid from clan_relationships where id=$1 for update", [id]);
    if (action === "accept" && (r.proposed_by === clan || r.status !== "pending" || !r.valid)) fail("request_state");
    await q.query("update clan_relationships set status=$2,updated_at=now() where id=$1", [id, action === "accept" ? "active" : "ended"]);
    await audit(q, { actorId: user.id, action: `clan.relationship_${action}`, entity: "clan", entityId: clan });
  });
}
export async function clanRelationships(q: Queryable, clan: string, leader: boolean) {
  return q.query<{ id: string; name: string; slug: string; tag: string; kind: string; status: string; incoming: boolean }>(`select r.id,c.name,c.slug,c.tag,r.kind,r.status,r.proposed_by<>$1 as incoming
    from clan_relationships r join clans c on c.id=case when r.clan_a=$1 then r.clan_b else r.clan_a end
    where $1 in(r.clan_a,r.clan_b) and c.status='active' and (r.status='active' or ($2::boolean and r.status='pending' and r.expires_at>now()))
    order by r.status,r.created_at desc`, [clan, leader]);
}
