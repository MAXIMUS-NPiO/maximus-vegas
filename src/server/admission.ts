/**
 * Admission criteria of a tournament: what every player of an entry must meet to register. They are checked
 * for the solo player or every member of a team's event roster, at registration and whenever a roster
 * changes (an edit before the lock or a substitution after it). Criteria are frozen once anyone has applied.
 *
 *  - a confirmed email address;
 *  - an account at least N days old;
 *  - at least N XP earned in this tournament's game;
 *  - at least N confirmed matches played in this tournament's game.
 * XP and matches come from confirmed activity only (xp_events), so they cannot be claimed by hand.
 */
import type { Queryable } from "./db.ts";
import { fail } from "./errors.ts";
import * as v from "./validate.ts";

export type Admission = { emailVerified: boolean; minAccountDays: number | null; minXp: number | null; minMatches: number | null };

export type AdmissionInput = { emailVerified?: unknown; minAccountDays?: unknown; minXp?: unknown; minMatches?: unknown };

const optional = (value: unknown, max: number) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const n = v.intIn(text, 0, max);
  return n === 0 ? null : n;
};

/** The organiser's criteria; null when none is set. */
export function parseAdmission(input: AdmissionInput): Admission | null {
  const a: Admission = {
    emailVerified: v.bool(input.emailVerified),
    minAccountDays: optional(input.minAccountDays, 3650),
    minXp: optional(input.minXp, 1_000_000),
    minMatches: optional(input.minMatches, 10_000),
  };
  return a.emailVerified || a.minAccountDays !== null || a.minXp !== null || a.minMatches !== null ? a : null;
}

export function admissionOf(t: { admission?: unknown }): Admission | null {
  const raw = t.admission as Partial<Admission> | null | undefined;
  if (!raw || typeof raw !== "object") return null;
  const num = (x: unknown) => (Number.isInteger(x) && (x as number) > 0 ? (x as number) : null);
  const a: Admission = { emailVerified: raw.emailVerified === true, minAccountDays: num(raw.minAccountDays), minXp: num(raw.minXp), minMatches: num(raw.minMatches) };
  return a.emailVerified || a.minAccountDays !== null || a.minXp !== null || a.minMatches !== null ? a : null;
}

export type PlayerStanding = { userId: string; emailVerified: boolean; accountDays: number; xp: number; matches: number };

/** Where each player stands against the criteria (XP and confirmed matches in the game). */
export async function playerStandings(q: Queryable, game: string, userIds: string[]): Promise<PlayerStanding[]> {
  if (!userIds.length) return [];
  const rows = await q.query<{ id: string; verified: boolean; days: number; xp: number; matches: number }>(
    `select u.id, (u.email_verified_at is not null) as verified,
            floor(extract(epoch from (now() - u.created_at)) / 86400)::int as days,
            coalesce((select sum(x.amount)::int from xp_events x where x.user_id = u.id and x.game = $2), 0) as xp,
            coalesce((select count(distinct x.ref)::int from xp_events x where x.user_id = u.id and x.game = $2
                       and x.reason in ('match_win','match_played')), 0) as matches
       from users u where u.id = any($1)`,
    [userIds, game],
  );
  return rows.map((r) => ({ userId: r.id, emailVerified: r.verified, accountDays: r.days, xp: r.xp, matches: r.matches }));
}

export type Unmet = "admission_email" | "admission_account_age" | "admission_xp" | "admission_matches";

export function unmetCriteria(a: Admission, p: PlayerStanding): Unmet[] {
  const out: Unmet[] = [];
  if (a.emailVerified && !p.emailVerified) out.push("admission_email");
  if (a.minAccountDays !== null && p.accountDays < a.minAccountDays) out.push("admission_account_age");
  if (a.minXp !== null && p.xp < a.minXp) out.push("admission_xp");
  if (a.minMatches !== null && p.matches < a.minMatches) out.push("admission_matches");
  return out;
}

/** Fails with the first criterion any of the players does not meet. */
export async function checkAdmission(q: Queryable, t: { game: string; admission?: unknown }, userIds: string[]) {
  const a = admissionOf(t);
  if (!a) return;
  for (const p of await playerStandings(q, t.game, userIds)) {
    const [first] = unmetCriteria(a, p);
    if (first) fail(first);
  }
}
