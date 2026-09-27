import type { Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { fail } from "./errors.ts";

export const isAdmin = (user: SessionUser | null) => Boolean(user?.roles.includes("admin"));
export const isStaff = (user: SessionUser | null) =>
  Boolean(user?.roles.some((r) => r === "admin" || r === "support"));

export function requireUser(user: SessionUser | null): SessionUser {
  if (!user) fail("unauthorized");
  return user!;
}

export async function orgRole(q: Queryable, orgId: string, userId: string): Promise<string | null> {
  const [row] = await q.query<{ role: string }>(
    "select role from org_members where org_id = $1 and user_id = $2",
    [orgId, userId],
  );
  return row?.role ?? null;
}

/** Owners and admins of the organising space, or platform admins. */
export async function canManageOrg(q: Queryable, orgId: string, user: SessionUser | null) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  const role = await orgRole(q, orgId, user.id);
  return role === "owner" || role === "admin";
}

/** Anyone allowed to decide match results for events of this organising space. */
export async function canReferee(q: Queryable, orgId: string, user: SessionUser | null) {
  if (!user) return false;
  if (user.roles.includes("admin") || user.roles.includes("referee")) return true;
  return Boolean(await orgRole(q, orgId, user.id));
}

export async function notify(
  q: Queryable,
  userIds: Iterable<string>,
  kind: string,
  data: Record<string, unknown>,
) {
  const ids = [...new Set(userIds)].filter(Boolean);
  for (const id of ids)
    await q.query("insert into notifications (user_id, kind, data) values ($1, $2, $3)", [
      id,
      kind,
      JSON.stringify(data),
    ]);
}
