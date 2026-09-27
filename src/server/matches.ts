import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { canReferee, notify } from "./access.ts";
import { fail } from "./errors.ts";
import { completeMatch, computePlacements, regLeaders, regMembers, type MatchRow } from "./tournaments.ts";
import * as v from "./validate.ts";

type Locked = MatchRow & { t_status: string; org_id: string; t_name: string };

async function lockMatch(q: Queryable, matchId: string): Promise<Locked> {
  const [m] = await q.query<Locked>(
    `select m.*, t.status as t_status, t.org_id, t.name as t_name
       from matches m join tournaments t on t.id = m.tournament_id
      where m.id = $1 for update of m`,
    [matchId],
  );
  if (!m) fail("not_found");
  return m;
}

async function sideOf(q: Queryable, m: MatchRow, userId: string): Promise<"a" | "b" | null> {
  if ((await regLeaders(q, m.a_reg)).includes(userId)) return "a";
  if ((await regLeaders(q, m.b_reg)).includes(userId)) return "b";
  return null;
}

function live(m: Locked) {
  if (m.t_status !== "IN_PROGRESS") fail("tournament_not_live");
}

function scores(input: { scoreA: unknown; scoreB: unknown }, m: MatchRow) {
  const scoreA = v.intIn(input.scoreA, 0, 999);
  const scoreB = v.intIn(input.scoreB, 0, 999);
  if (scoreA === scoreB) fail("draw_not_allowed");
  return { scoreA, scoreB, winner: scoreA > scoreB ? m.a_reg! : m.b_reg! };
}

async function nextVersion(q: Queryable, matchId: string) {
  const [row] = await q.query<{ n: number }>("select coalesce(max(version), 0)::int + 1 as n from match_results where match_id = $1", [matchId]);
  return row?.n ?? 1;
}

async function staffFor(q: Queryable, orgId: string) {
  const rows = await q.query<{ user_id: string }>("select user_id from org_members where org_id = $1", [orgId]);
  return rows.map((r) => r.user_id);
}

export type ResultInput = { scoreA: unknown; scoreB: unknown; evidenceUrl: unknown; note: unknown };

/** A participant reports a result. The opponent confirms it or opens a dispute. */
export async function submitResult(db: Database, user: SessionUser, matchId: string, input: ResultInput) {
  await db.tx(async (q) => {
    const m = await lockMatch(q, matchId);
    live(m);
    if (!["ready", "in_progress", "result_submitted"].includes(m.status)) fail(m.status === "completed" ? "already_completed" : "match_not_ready");
    const side = await sideOf(q, m, user.id);
    if (!side) fail("not_participant");
    const { scoreA, scoreB, winner } = scores(input, m);
    const evidence = v.optionalUrl(input.evidenceUrl);
    const note = v.clean(input.note, 1000);
    const pending = await q.query<{ id: string; side: string; score_a: number; score_b: number; winner_reg: string }>(
      "select * from match_results where match_id = $1 and status = 'pending' order by version desc",
      [m.id],
    );
    const theirs = pending.find((p) => p.side && p.side !== side);
    await q.query("update match_results set status = 'superseded' where match_id = $1 and status = 'pending' and side = $2", [m.id, side]);
    const version = await nextVersion(q, m.id);
    const [row] = await q.query<{ id: string }>(
      `insert into match_results (match_id, version, source, side, submitted_by, score_a, score_b, winner_reg, evidence_url, note)
       values ($1,$2,'participant',$3,$4,$5,$6,$7,$8,$9) returning id`,
      [m.id, version, side, user.id, scoreA, scoreB, winner, evidence, note],
    );
    const opponentReg = side === "a" ? m.b_reg : m.a_reg;
    if (theirs) {
      if (theirs.score_a === scoreA && theirs.score_b === scoreB) {
        await q.query(
          "update match_results set status = 'confirmed', decided_by = $2, decided_at = now() where id = any($1)",
          [[theirs.id, row.id], user.id],
        );
        await completeMatch(q, m, { winner, scoreA, scoreB, outcome: "played" }, user.id);
        await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "result_confirmed", { matchId: m.id, tournament: m.t_name });
        await audit(q, { actorId: user.id, action: "match.result_agreed", entity: "match", entityId: m.id, data: { scoreA, scoreB } });
        return;
      }
      await q.query("update matches set status = 'disputed', updated_at = now() where id = $1", [m.id]);
      await q.query("insert into disputes (match_id, opened_by, reason) values ($1, $2, $3)", [m.id, user.id, "conflicting_results"]);
      await notify(q, await staffFor(q, m.org_id), "dispute_opened", { matchId: m.id, tournament: m.t_name });
      await notify(q, await regLeaders(q, opponentReg), "dispute_opened", { matchId: m.id, tournament: m.t_name });
      await audit(q, { actorId: user.id, action: "match.results_conflict", entity: "match", entityId: m.id, data: { scoreA, scoreB } });
      return;
    }
    await q.query("update matches set status = 'result_submitted', updated_at = now() where id = $1", [m.id]);
    await notify(q, await regLeaders(q, opponentReg), "result_submitted", { matchId: m.id, tournament: m.t_name });
    await audit(q, { actorId: user.id, action: "match.result_submitted", entity: "match", entityId: m.id, data: { version, scoreA, scoreB, evidence: Boolean(evidence) } });
  });
}

export async function confirmResult(db: Database, user: SessionUser, matchId: string) {
  await db.tx(async (q) => {
    const m = await lockMatch(q, matchId);
    live(m);
    if (m.status === "completed") fail("already_completed");
    const side = await sideOf(q, m, user.id);
    if (!side) fail("not_participant");
    const [pending] = await q.query<{ id: string; side: string; score_a: number; score_b: number; winner_reg: string }>(
      "select * from match_results where match_id = $1 and status = 'pending' order by version desc limit 1",
      [m.id],
    );
    if (!pending || m.status !== "result_submitted") fail("no_pending_result");
    if (pending.side === side) fail("own_result");
    await q.query("update match_results set status = 'confirmed', decided_by = $2, decided_at = now() where id = $1", [pending.id, user.id]);
    await completeMatch(q, m, { winner: pending.winner_reg, scoreA: pending.score_a, scoreB: pending.score_b, outcome: "played" }, user.id);
    await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "result_confirmed", { matchId: m.id, tournament: m.t_name });
    await audit(q, { actorId: user.id, action: "match.result_confirmed", entity: "match", entityId: m.id, data: { resultId: pending.id } });
  });
}

export async function disputeResult(db: Database, user: SessionUser, matchId: string, reasonInput: unknown) {
  const reason = v.clean(reasonInput, 1000);
  if (reason.length < 5) fail("invalid_input");
  await db.tx(async (q) => {
    const m = await lockMatch(q, matchId);
    live(m);
    if (!["result_submitted", "ready", "in_progress"].includes(m.status)) fail(m.status === "completed" ? "already_completed" : "match_not_ready");
    const side = await sideOf(q, m, user.id);
    if (!side) fail("not_participant");
    await q.query("update matches set status = 'disputed', updated_at = now() where id = $1", [m.id]);
    await q.query("insert into disputes (match_id, opened_by, reason) values ($1, $2, $3)", [m.id, user.id, reason]);
    await notify(q, await staffFor(q, m.org_id), "dispute_opened", { matchId: m.id, tournament: m.t_name });
    await notify(q, await regLeaders(q, side === "a" ? m.b_reg : m.a_reg), "dispute_opened", { matchId: m.id, tournament: m.t_name });
    await audit(q, { actorId: user.id, action: "match.disputed", entity: "match", entityId: m.id });
  });
}

/** Referee or organiser decision. Closes open disputes and advances the winner. */
export async function officialResult(
  db: Database,
  user: SessionUser,
  matchId: string,
  input: ResultInput & { resolution?: unknown },
) {
  await db.tx(async (q) => {
    const m = await lockMatch(q, matchId);
    if (!(await canReferee(q, m.org_id, user))) fail("forbidden");
    live(m);
    if (m.status === "completed") fail("already_completed");
    if (!m.a_reg || !m.b_reg) fail("match_not_ready");
    const { scoreA, scoreB, winner } = scores(input, m);
    const evidence = v.optionalUrl(input.evidenceUrl);
    const note = v.clean(input.note, 1000);
    const resolution = v.clean(input.resolution, 1000);
    await q.query("update match_results set status = 'superseded' where match_id = $1 and status = 'pending'", [m.id]);
    const version = await nextVersion(q, m.id);
    await q.query(
      `insert into match_results (match_id, version, source, submitted_by, score_a, score_b, winner_reg, evidence_url, note, status, decided_by, decided_at)
       values ($1,$2,'official',$3,$4,$5,$6,$7,$8,'confirmed',$3,now())`,
      [m.id, version, user.id, scoreA, scoreB, winner, evidence, note],
    );
    if (resolution)
      await q.query("update disputes set resolution = $2 where match_id = $1 and status = 'open'", [m.id, resolution]);
    await completeMatch(q, m, { winner, scoreA, scoreB, outcome: "played" }, user.id);
    await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "result_confirmed", { matchId: m.id, tournament: m.t_name });
    await audit(q, { actorId: user.id, action: "match.official_result", entity: "match", entityId: m.id, data: { version, scoreA, scoreB } });
  });
}

export async function markNoShow(db: Database, user: SessionUser, matchId: string, absentInput: unknown) {
  const absent = absentInput === "a" || absentInput === "b" ? absentInput : fail("invalid_input");
  await db.tx(async (q) => {
    const m = await lockMatch(q, matchId);
    if (!(await canReferee(q, m.org_id, user))) fail("forbidden");
    live(m);
    if (m.status === "completed") fail("already_completed");
    if (!m.a_reg || !m.b_reg) fail("match_not_ready");
    const winner = (absent === "a" ? m.b_reg : m.a_reg)!;
    await q.query("update match_results set status = 'superseded' where match_id = $1 and status = 'pending'", [m.id]);
    const version = await nextVersion(q, m.id);
    await q.query(
      `insert into match_results (match_id, version, source, submitted_by, winner_reg, outcome, note, status, decided_by, decided_at)
       values ($1,$2,'official',$3,$4,'no_show',$5,'confirmed',$3,now())`,
      [m.id, version, user.id, winner, `no_show:${absent}`],
    );
    await completeMatch(q, m, { winner, scoreA: null, scoreB: null, outcome: "no_show" }, user.id);
    await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "no_show_recorded", { matchId: m.id, tournament: m.t_name });
    await audit(q, { actorId: user.id, action: "match.no_show", entity: "match", entityId: m.id, data: { absent } });
  });
}

/**
 * Corrects a confirmed result by adding a new version. Refused when the dependent match has
 * already progressed, so played games are never silently rewritten.
 */
export async function correctResult(
  db: Database,
  user: SessionUser,
  matchId: string,
  input: ResultInput,
) {
  await db.tx(async (q) => {
    const m = await lockMatch(q, matchId);
    if (!(await canReferee(q, m.org_id, user))) fail("forbidden");
    if (!["IN_PROGRESS", "PAUSED", "COMPLETED"].includes(m.t_status)) fail("tournament_not_live");
    if (m.status !== "completed" || m.outcome === "bye") fail("not_editable");
    const { scoreA, scoreB, winner } = scores(input, m);
    const note = v.clean(input.note, 1000);
    if (note.length < 5) fail("invalid_input");
    if (m.next_match_id) {
      const [next] = await q.query<MatchRow>("select * from matches where id = $1 for update", [m.next_match_id]);
      const [results] = await q.query<{ n: number }>("select count(*)::int as n from match_results where match_id = $1", [next.id]);
      if (!["pending", "ready"].includes(next.status) || (results?.n ?? 0) > 0) fail("dependent_match_played");
      if (winner !== m.winner_reg) {
        const slot = m.next_slot === "a" ? "a_reg" : "b_reg";
        await q.query(`update matches set ${slot} = $2, updated_at = now() where id = $1`, [next.id, winner]);
      }
    }
    await q.query("update match_results set status = 'superseded' where match_id = $1 and status = 'confirmed'", [m.id]);
    const version = await nextVersion(q, m.id);
    await q.query(
      `insert into match_results (match_id, version, source, submitted_by, score_a, score_b, winner_reg, evidence_url, note, status, decided_by, decided_at)
       values ($1,$2,'official',$3,$4,$5,$6,$7,$8,'confirmed',$3,now())`,
      [m.id, version, user.id, scoreA, scoreB, winner, v.optionalUrl(input.evidenceUrl), note],
    );
    await q.query(
      "update matches set winner_reg = $2, score_a = $3, score_b = $4, outcome = 'played', updated_at = now() where id = $1",
      [m.id, winner, scoreA, scoreB],
    );
    if (m.t_status === "COMPLETED") await computePlacements(q, m.tournament_id);
    await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "result_corrected", { matchId: m.id, tournament: m.t_name });
    await audit(q, {
      actorId: user.id,
      action: "match.result_corrected",
      entity: "match",
      entityId: m.id,
      data: { version, before: { winner: m.winner_reg, scoreA: m.score_a, scoreB: m.score_b }, after: { winner, scoreA, scoreB }, note },
    });
  });
}

export async function updateMatchDetails(
  db: Database,
  user: SessionUser,
  matchId: string,
  input: { roomCode?: unknown; scheduledAt?: unknown; timeZone?: unknown; live?: unknown },
) {
  await db.tx(async (q) => {
    const m = await lockMatch(q, matchId);
    const referee = await canReferee(q, m.org_id, user);
    const side = await sideOf(q, m, user.id);
    if (!referee && !side) fail("forbidden");
    if (["completed", "cancelled"].includes(m.status)) fail("already_completed");
    if (input.roomCode !== undefined) {
      const code = v.oneLine(input.roomCode, 80);
      await q.query("update matches set room_code = $2, updated_at = now() where id = $1", [m.id, code]);
      await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))].filter((id) => id !== user.id), "room_code", { matchId: m.id, tournament: m.t_name });
    }
    if (input.scheduledAt !== undefined && input.scheduledAt !== "") {
      if (!referee) fail("forbidden");
      const at = v.zonedToUtc(input.scheduledAt, input.timeZone);
      await q.query("update matches set scheduled_at = $2, updated_at = now() where id = $1", [m.id, at.toISOString()]);
      await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "match_scheduled", { matchId: m.id, tournament: m.t_name, at: at.toISOString() });
    }
    if (v.bool(input.live)) {
      live(m);
      if (m.status !== "ready") fail("match_not_ready");
      await q.query("update matches set status = 'in_progress', updated_at = now() where id = $1", [m.id]);
    }
    await audit(q, { actorId: user.id, action: "match.details_updated", entity: "match", entityId: m.id });
  });
}
