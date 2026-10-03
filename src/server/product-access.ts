import type { Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { canManageOrg } from "./access.ts";
import { fail } from "./errors.ts";

/** Recheck persisted status for background calls as well as HTTP actions. */
export async function activeAccount(q: Queryable, user: SessionUser) {
  const [row] = await q.query(`select 1 from users u where u.id=$1 and u.status='active' and u.adult_confirmed_at is not null
    and not exists(select 1 from sanctions s where s.user_id=u.id and s.kind='suspension' and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now()))`, [user.id]);
  if (!row || user.restricted) fail("account_restricted");
}

export async function manageVenue(q: Queryable, user: SessionUser, venueId: string, confirmed = false) {
  const [venue] = await q.query<{ id: string; org_id: string; status: string }>("select id,org_id,status from venues where id=$1", [venueId]);
  if (!venue || !(await canManageOrg(q, venue.org_id, user))) fail("forbidden");
  if (confirmed && venue.status !== "confirmed") fail("venue_not_confirmed");
  return venue;
}
