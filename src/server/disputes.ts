/**
 * Post-result disputes (handoff spec, section 5). A participant disputes a decided match with a note and
 * optional evidence; an organiser or referee upholds it (the result stands) or overturns it (the other
 * side becomes the recorded winner). The dispute references the match row, which carries its bracket
 * (winners, losers, grand final or reset), so a decision always resolves to the right place.
 *
 * Reputation: a dispute the player filed that was reviewed and upheld counts against them; an overturned
 * one does not, so legitimate reports are never discouraged.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { rewriteWinner } from "./decisions.ts";
import { lockMatchWithTournament, nextVersion, requireStageOpen, sideOf, staffFor } from "./matches.ts";
import { canRefereeTournament, isRoundBracket, regLeaders, regMembers } from "./tournaments.ts";
import * as v from "./validate.ts";

export const REPUTATION = { start: 100, upheldPenalty: 5 } as const;

export async function reputation(q: Queryable, userId: string): Promise<number> {
  const [r] = await q.query<{ n: number }>(
    "select count(*)::int as n from disputes where opened_by = $1 and kind = 'post_result' and decision = 'upheld'",
    [userId],
  );
  return Math.max(0, REPUTATION.start - REPUTATION.upheldPenalty * (r?.n ?? 0));
}

export async function fileDispute(
  db: Database,
  user: SessionUser,
  matchId: string,
  input: { reason: unknown; evidenceUrl?: unknown; evidenceMediaId?: string | null },
) {
  const reason = v.clean(input.reason, 1000);
  if (reason.length < 10) fail("invalid_input");
  const evidence = v.optionalUrl(input.evidenceUrl);
  return db.tx(async (q) => {
    const m = await lockMatchWithTournament(q, matchId);
    if (!["IN_PROGRESS", "PAUSED", "COMPLETED"].includes(m.t_status)) fail("tournament_not_live");
    if (m.status !== "completed" || m.outcome === "bye" || !m.winner_reg || !m.a_reg || !m.b_reg) fail("not_editable");
    requireStageOpen(m);
    const side = await sideOf(q, m, user.id);
    if (!side) fail("not_participant");
    let id: string;
    try {
      const [row] = await q.query<{ id: string }>(
        `insert into disputes (match_id, opened_by, reason, kind, evidence_url, evidence_media_id)
         values ($1, $2, $3, 'post_result', $4, $5) returning id`,
        [m.id, user.id, reason, evidence, input.evidenceMediaId ?? null],
      );
      id = row.id;
    } catch (error) {
      if (isUniqueViolation(error)) fail("dispute_exists");
      throw error;
    }
    await notify(q, await staffFor(q, m.org_id, m.tournament_id), "dispute_opened", { matchId: m.id, tournament: m.t_name });
    await notify(q, await regLeaders(q, side === "a" ? m.b_reg : m.a_reg), "dispute_opened", { matchId: m.id, tournament: m.t_name });
    await audit(q, { actorId: user.id, action: "dispute.filed", entity: "match", entityId: m.id, data: { disputeId: id, bracket: m.bracket, round: m.round, position: m.position } });
    return id;
  });
}

export async function decideDispute(db: Database, user: SessionUser, disputeId: string, decisionInput: unknown, noteInput: unknown) {
  const decision = decisionInput === "uphold" ? "upheld" : decisionInput === "overturn" ? "overturned" : fail("invalid_input");
  const note = v.clean(noteInput, 1000);
  if (note.length < 5) fail("invalid_input");
  await db.tx(async (q) => {
    const [d] = await q.query<{ id: string; match_id: string; opened_by: string; status: string; kind: string }>(
      "select id, match_id, opened_by, status, kind from disputes where id = $1 for update",
      [disputeId],
    );
    if (!d || d.kind !== "post_result") fail("not_found");
    if (d.status !== "open") fail("already_completed");
    const m = await lockMatchWithTournament(q, d.match_id);
    if (!(await canRefereeTournament(q, { id: m.tournament_id, org_id: m.org_id }, user))) fail("forbidden");
    if (decision === "overturned") {
      requireStageOpen(m);
      const newWinner = m.winner_reg === m.a_reg ? m.b_reg! : m.a_reg!;
      await rewriteWinner(q, m.id, newWinner, { scoreA: null, scoreB: null, outcome: "decision" }, user.id);
      await q.query("update match_results set status = 'superseded' where match_id = $1 and status = 'confirmed'", [m.id]);
      const version = await nextVersion(q, m.id);
      await q.query(
        `insert into match_results (match_id, version, source, submitted_by, winner_reg, outcome, note, status, decided_by, decided_at)
         values ($1,$2,'official',$3,$4,'decision',$5,'confirmed',$3,now())`,
        [m.id, version, user.id, newWinner, note],
      );
    }
    await q.query(
      "update disputes set status = 'resolved', decision = $2, resolution = $3, resolved_by = $4, resolved_at = now() where id = $1",
      [d.id, decision, note, user.id],
    );
    if (isRoundBracket(m.bracket)) {
      // A playoff waits for the open disputes of its main stage: deciding the last one may start it.
      const { afterRoundMatch } = await import("./rounds.ts");
      await afterRoundMatch(q, m.tournament_id, user.id);
    }
    await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], decision === "overturned" ? "dispute_overturned" : "dispute_upheld", {
      matchId: m.id,
      tournament: m.t_name,
    });
    await audit(q, {
      actorId: user.id,
      action: `dispute.${decision}`,
      entity: "match",
      entityId: m.id,
      data: { disputeId: d.id, filedBy: d.opened_by, bracket: m.bracket, round: m.round, position: m.position, note },
    });
  });
}
