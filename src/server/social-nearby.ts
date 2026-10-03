import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { activeAccount } from "./product-access.ts";
import { audit } from "./audit.ts";
import { fail } from "./errors.ts";
import { NEARBY_CONSENT, type NearbyStatus } from "../lib/nearby.ts";

/** Only the owning account receives this status; coordinates never enter component props. */
export async function nearbyStatus(q: Queryable, userId: string): Promise<NearbyStatus> {
  const [row] = await q.query<{ revision: number; active: boolean; expires_at: Date | null; next_update_at: Date | null }>(`select p.nearby_revision as revision,
    coalesce(p.visible and not p.suspended and n.expires_at>now() and n.consent_version=$2
      and u.status='active' and u.adult_confirmed_at is not null
      and not exists(select 1 from sanctions s where s.user_id=u.id and s.kind='suspension' and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now())),false) as active,
    n.expires_at,p.nearby_updated_at+interval '1 hour' as next_update_at
    from social_profiles p join users u on u.id=p.user_id left join social_locations n on n.user_id=p.user_id where p.user_id=$1`, [userId, NEARBY_CONSENT]);
  return { revision: row?.revision ?? 0, active: row?.active ?? false, expiresAt: row?.expires_at?.toISOString() ?? null, nextUpdateAt: row?.next_update_at?.toISOString() ?? null };
}

/** Caller holds the user's lock. Revision fences delayed uploads after consent is revoked. */
export async function clearNearby(q: Queryable, userId: string) {
  await q.query("update social_profiles set nearby_revision=nearby_revision+1 where user_id=$1", [userId]);
  await q.query("delete from social_locations where user_id=$1", [userId]);
}

export async function saveNearby(db: Database, user: SessionUser, input: Record<string, unknown>) {
  if (input.consent !== NEARBY_CONSENT) fail("consent_required");
  const { latCell, lngCell, revision } = input;
  if (typeof latCell !== "number" || !Number.isInteger(latCell) || latCell < -900 || latCell > 900 ||
      typeof lngCell !== "number" || !Number.isInteger(lngCell) || lngCell < -1800 || lngCell >= 1800 ||
      (Math.abs(latCell) === 900 && lngCell !== 0) || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 ||
      Object.keys(input).some(k => !["action", "consent", "latCell", "lngCell", "revision"].includes(k))) fail("invalid_input");
  return db.tx(async q => {
    await q.query("select id from users where id=$1 for update", [user.id]);
    await activeAccount(q, user);
    const [profile] = await q.query<{ nearby_revision: number }>("select nearby_revision from social_profiles where user_id=$1 and visible and not suspended", [user.id]);
    if (!profile) fail("consent_required");
    if (profile.nearby_revision !== revision) fail("request_state");
    if ((await q.query("select 1 from social_profiles where user_id=$1 and nearby_updated_at>now()-interval '1 hour'", [user.id])).length) fail("request_limit");
    await q.query(`insert into social_locations(user_id,lat_cell,lng_cell,consent_version) values($1,$2,$3,$4)
      on conflict(user_id) do update set lat_cell=excluded.lat_cell,lng_cell=excluded.lng_cell,consent_version=excluded.consent_version,updated_at=now(),expires_at=now()+interval '7 days'`, [user.id, latCell, lngCell, NEARBY_CONSENT]);
    await q.query("update social_profiles set nearby_revision=nearby_revision+1,nearby_updated_at=now() where user_id=$1", [user.id]);
    await audit(q, { actorId: user.id, action: "social.nearby_enabled", entity: "user", entityId: user.id, data: { version: NEARBY_CONSENT } });
    return nearbyStatus(q, user.id);
  });
}

export async function disableNearby(db: Database, user: SessionUser) {
  return db.tx(async q => {
    await q.query("select id from users where id=$1 for update", [user.id]);
    await clearNearby(q, user.id);
    await audit(q, { actorId: user.id, action: "social.nearby_disabled", entity: "user", entityId: user.id });
    return nearbyStatus(q, user.id);
  });
}

/** Expiry is enforced by discovery itself, even if maintenance is delayed. */
export async function expireNearby(q: Queryable) {
  await q.query("delete from social_locations where expires_at<=now()");
}
