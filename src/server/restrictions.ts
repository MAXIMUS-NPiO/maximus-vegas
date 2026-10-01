/**
 * Live sanctions that stop an action (MV-CONDUCT-1). A suspension stops everything except reading and
 * appealing (enforced for every action in the action route through the session's `restricted` flag);
 * a queue ban stops quick match and challenges; a tournament ban stops registrations and roster entries.
 */
import type { Queryable } from "./db.ts";
import { fail } from "./errors.ts";

export type RestrictionKind = "queue_ban" | "tournament_ban";

/** SQL condition for a sanction in force now (alias `s`). */
export const LIVE_SANCTION = "s.revoked_at is null and s.starts_at <= now() and (s.ends_at is null or s.ends_at > now())";

/** Players among `ids` with a live sanction of this kind or a suspension. */
export async function restrictedPlayers(q: Queryable, ids: string[], kind: RestrictionKind): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await q.query<{ user_id: string }>(
    `select distinct s.user_id from sanctions s where s.user_id = any($1::uuid[]) and s.kind in ($2, 'suspension') and ${LIVE_SANCTION}`,
    [ids, kind],
  );
  return rows.map((r) => r.user_id);
}

/** Refuses the action when any of the players is restricted for it. */
export async function assertNotRestricted(q: Queryable, ids: string[], kind: RestrictionKind) {
  if ((await restrictedPlayers(q, ids, kind)).length) fail(kind === "queue_ban" ? "queue_restricted" : "tournament_restricted");
}
