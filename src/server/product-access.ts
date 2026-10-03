import type { Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { canManageOrg } from "./access.ts";
import { fail } from "./errors.ts";

/** Recheck persisted status for background calls as well as HTTP actions. */
export async function activeAccount(q: Queryable, user: SessionUser) {
  const [row] = await q.query("select 1 from users where id=$1 and status='active' and adult_confirmed_at is not null", [user.id]);
  if (!row || user.restricted) fail("account_restricted");
}

export async function manageVenue(q: Queryable, user: SessionUser, venueId: string, confirmed = false) {
  const [venue] = await q.query<{ id: string; org_id: string; status: string }>("select id,org_id,status from venues where id=$1", [venueId]);
  if (!venue || !(await canManageOrg(q, venue.org_id, user))) fail("forbidden");
  if (confirmed && venue.status !== "confirmed") fail("venue_not_confirmed");
  return venue;
}
