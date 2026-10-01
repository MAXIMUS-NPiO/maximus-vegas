/**
 * Batch changes of the match schedule during an event: set the start of one round, or shift every open match
 * (of one round or of the whole event) by a number of minutes. Both sides of every moved match are notified;
 * the change is one audit record. Completed and cancelled matches never move.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail } from "./errors.ts";
import { lockTournament, regMembers, requireManager } from "./tournaments.ts";
import * as v from "./validate.ts";

/** A round of a tournament: stage, bracket and round number ("1:W:2"); "all" is every open match. */
export type RoundKey = { stage: number; bracket: string; round: number } | "all";

export function parseRoundKey(value: unknown): RoundKey {
  const text = String(value ?? "").trim();
  if (text === "all") return "all";
  const m = /^([12]):(W|L|GF|RR|SW|G):(\d{1,3})$/.exec(text);
  if (!m) return fail("invalid_input");
  return { stage: Number(m[1]), bracket: m[2], round: Number(m[3]) };
}

export const roundKeyOf = (m: { stage?: number | null; bracket?: string | null; round: number }) => `${m.stage ?? 1}:${m.bracket ?? "W"}:${m.round}`;

type Open = { id: string; a_reg: string | null; b_reg: string | null; scheduled_at: Date | null };

async function openMatches(q: Queryable, tournamentId: string, key: RoundKey) {
  const base = "select id, a_reg, b_reg, scheduled_at from matches where tournament_id = $1 and status not in ('completed','cancelled')";
  return key === "all"
    ? q.query<Open>(`${base} order by stage, bracket, round, position for update`, [tournamentId])
    : q.query<Open>(`${base} and stage = $2 and bracket = $3 and round = $4 order by position for update`, [tournamentId, key.stage, key.bracket, key.round]);
}

/**
 * Moves open matches. `at` (local date-time in `timeZone`) sets the start of a round; `shiftMinutes`
 * (−1440…1440, not 0) moves every open match that already has a time.
 */
export async function reschedule(
  db: Database,
  user: SessionUser,
  tournamentId: string,
  input: { round: unknown; at?: unknown; timeZone?: unknown; shiftMinutes?: unknown },
) {
  const key = parseRoundKey(input.round);
  const at = String(input.at ?? "").trim() ? v.zonedToUtc(input.at, input.timeZone) : null;
  const shift = at ? 0 : v.intIn(input.shiftMinutes, -1440, 1440);
  if (!at && shift === 0) fail("invalid_input");
  if (at && key === "all") fail("invalid_input");
  return db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (!["IN_PROGRESS", "PAUSED"].includes(t.status)) fail("tournament_not_live");
    const matches = await openMatches(q, t.id, key);
    let moved = 0;
    for (const m of matches) {
      const next = at ? at : m.scheduled_at ? new Date(new Date(m.scheduled_at).getTime() + shift * 60_000) : null;
      if (!next) continue;
      await q.query("update matches set scheduled_at = $2, updated_at = now() where id = $1", [m.id, next.toISOString()]);
      await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "match_scheduled", {
        matchId: m.id,
        tournament: t.name,
        at: next.toISOString(),
      });
      moved++;
    }
    await audit(q, {
      actorId: user.id,
      action: "tournament.rescheduled",
      entity: "tournament",
      entityId: t.id,
      data: { round: key === "all" ? "all" : roundKeyOf(key), at: at?.toISOString() ?? null, shiftMinutes: at ? null : shift, moved },
    });
    return moved;
  });
}
