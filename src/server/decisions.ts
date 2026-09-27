import { randomUUID } from "node:crypto";
import type { Queryable } from "./db.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail } from "./errors.ts";
import { completeTournament, computePlacements, loserOf, lockMatch, placeInSlot, regMembers, type MatchRow } from "./tournaments.ts";
import { grantXp, XP } from "./progression.ts";

type Rewrite = { scoreA: number | null; scoreB: number | null; outcome: "played" | "decision" };

/**
 * Changes the recorded winner of a completed match (a correction or an overturned dispute) and applies
 * the bracket consequences in the same transaction:
 *  - the new winner replaces the old one in the next match, the new loser drops into the losers slot;
 *  - automatic byes along the way are re-routed; a played, reported or live dependent match blocks it;
 *  - grand final: if the undefeated winners champion loses on review, a bracket reset is created and the
 *    tournament resumes; if a reset existed and the losers champion's grand-final win is reversed, the
 *    unplayed reset is removed and the tournament completes;
 *  - the deciding match (final, grand final, reset) re-settles placements and the champion award, which
 *    pays a new champion without clawing anything back.
 */
export async function rewriteWinner(q: Queryable, matchId: string, newWinner: string, result: Rewrite, actorId: string) {
  const m = await lockMatch(q, matchId);
  if (m.status !== "completed" || m.outcome === "bye" || !m.winner_reg) fail("not_editable");
  if (newWinner !== m.a_reg && newWinner !== m.b_reg) fail("invalid_input");
  const oldWinner = m.winner_reg!;
  const setResult = () =>
    q.query("update matches set winner_reg = $2, score_a = $3, score_b = $4, outcome = $5, updated_at = now() where id = $1", [
      m.id,
      newWinner,
      result.scoreA,
      result.scoreB,
      result.outcome,
    ]);
  if (newWinner === oldWinner) {
    await setResult();
    return { changedWinner: false };
  }
  const oldLoser = loserOf(m, oldWinner);
  const [game] = await q.query<{ game: string }>("select game from tournaments where id = $1", [m.tournament_id]);
  // The new winner earns the win XP; nothing already credited to the previous winner is taken back.
  await grantXp(q, await regMembers(q, newWinner), XP.matchWin, "match_win", game?.game ?? "", m.id, `match:${m.id}:win`);

  if (m.bracket === "GF" && m.round === 1) {
    const [reset] = await q.query<MatchRow>(
      "select * from matches where tournament_id = $1 and bracket = 'GF' and round = 2 for update",
      [m.tournament_id],
    );
    if (oldWinner === m.a_reg) {
      // The winners champion had taken the grand final outright; now the losers champion wins it.
      await setResult();
      if (!reset)
        await q.query(
          `insert into matches (id, tournament_id, bracket, round, position, a_reg, b_reg, status) values ($1, $2, 'GF', 2, 0, $3, $4, 'ready')`,
          [randomUUID(), m.tournament_id, m.a_reg, m.b_reg],
        );
      await q.query("update registrations set placement = null where tournament_id = $1", [m.tournament_id]);
      const [t] = await q.query<{ name: string; slug: string }>(
        "update tournaments set status = 'IN_PROGRESS', completed_at = null, updated_at = now() where id = $1 returning name, slug",
        [m.tournament_id],
      );
      await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "bracket_reset", { tournament: t?.name, slug: t?.slug });
      await audit(q, { actorId, action: "tournament.reopened_for_reset", entity: "tournament", entityId: m.tournament_id, data: { matchId: m.id } });
      return { changedWinner: true };
    }
    // The losers champion had won the grand final (a reset exists); now the winners champion wins outright.
    if (reset) {
      const [results] = await q.query<{ n: number }>("select count(*)::int as n from match_results where match_id = $1", [reset.id]);
      if (!["pending", "ready"].includes(reset.status) || (results?.n ?? 0) > 0) fail("dependent_match_played");
      await q.query("delete from matches where id = $1", [reset.id]);
    }
    await setResult();
    await completeTournament(q, m.tournament_id);
    return { changedWinner: true };
  }

  if (!m.next_match_id) {
    // Single-elimination final or the bracket reset: the champion changes.
    await setResult();
    const [t] = await q.query<{ status: string }>("select status from tournaments where id = $1", [m.tournament_id]);
    if (t?.status === "COMPLETED") await completeTournament(q, m.tournament_id);
    else await computePlacements(q, m.tournament_id);
    return { changedWinner: true };
  }

  await placeInSlot(q, m.next_match_id, m.next_slot!, newWinner, actorId, oldWinner);
  if (m.loser_next_match_id && oldLoser) await placeInSlot(q, m.loser_next_match_id, m.loser_next_slot!, oldWinner, actorId, oldLoser);
  await setResult();
  return { changedWinner: true };
}
