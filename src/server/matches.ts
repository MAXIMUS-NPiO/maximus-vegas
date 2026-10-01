import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail } from "./errors.ts";
import { canRefereeTournament, completeMatch, isRoundBracket, regLeaders, regMembers, type MatchRow } from "./tournaments.ts";
import { rewriteWinner } from "./decisions.ts";
import { isRoundFormat, settingsOf } from "./format-settings.ts";
import { depthKey, parseMatchOverride, seriesCustomised, seriesOf, seriesRulesOf, seriesScoreValid } from "./series.ts";
import * as v from "./validate.ts";

type Locked = MatchRow & {
  t_status: string;
  org_id: string;
  t_name: string;
  t_slug: string;
  t_format: string;
  t_settings: unknown;
  t_stage: number;
  t_no_show: number | null;
  t_series: unknown;
  scheduled_at: Date | null;
  series_override: number | null;
  venue_id: string | null;
};

/**
 * Locks the tournament row, then the match. Every writer takes the tournament first (transitions,
 * disqualification, regeneration), so the order is the same everywhere and the results of one tournament
 * are applied one at a time: two results that finish a Swiss round together pair the next round once.
 */
export async function lockMatchWithTournament(q: Queryable, matchId: string): Promise<Locked> {
  if (!/^[0-9a-f-]{36}$/i.test(matchId)) fail("not_found");
  const [ref] = await q.query<{ tournament_id: string }>("select tournament_id from matches where id = $1", [matchId]);
  if (!ref) fail("not_found");
  await q.query("select id from tournaments where id = $1 for update", [ref.tournament_id]);
  const [m] = await q.query<Locked>(
    `select m.*, t.status as t_status, t.org_id, t.name as t_name, t.slug as t_slug, t.format as t_format, t.format_settings as t_settings,
            t.stage as t_stage, t.no_show_minutes as t_no_show, t.series_rules as t_series
       from matches m join tournaments t on t.id = m.tournament_id
      where m.id = $1 for update of m`,
    [matchId],
  );
  if (!m) fail("not_found");
  return m;
}

/** Once the playoff exists, the main stage that seeded it is final: its results no longer change. */
export function requireStageOpen(m: Locked) {
  if (m.stage === 1 && m.t_stage === 2) fail("stage_locked");
}

/** Draws are accepted only in round robin and Swiss, and only when the organiser allowed them. */
export const drawAllowed = (m: Locked) => isRoundBracket(m.bracket) && settingsOf({ format: m.t_format, format_settings: m.t_settings }).allowDraws;

export async function sideOf(q: Queryable, m: { a_reg: string | null; b_reg: string | null }, userId: string): Promise<"a" | "b" | null> {
  if ((await regLeaders(q, m.a_reg)).includes(userId)) return "a";
  if ((await regLeaders(q, m.b_reg)).includes(userId)) return "b";
  return null;
}

const refereeOf = (q: Queryable, m: Locked, user: SessionUser) => canRefereeTournament(q, { id: m.tournament_id, org_id: m.org_id }, user);

function live(m: Locked) {
  if (m.t_status !== "IN_PROGRESS") fail("tournament_not_live");
}

/** Series length of a locked match under the tournament's rules (MV-SERIES-1). */
export async function seriesLengthOf(q: Queryable, m: Locked): Promise<number> {
  const rules = seriesRulesOf({ series_rules: m.t_series });
  if (!seriesCustomised(rules) && !m.series_override) return 1;
  const [row] = await q.query<{ top: number }>(
    "select coalesce(max(round), 0)::int as top from matches where tournament_id = $1 and stage = $2 and bracket = $3",
    [m.tournament_id, m.stage, m.bracket],
  );
  const playoff = isRoundFormat(m.t_format) ? (settingsOf({ format: m.t_format, format_settings: m.t_settings }).playoff?.format ?? null) : null;
  return seriesOf(rules, m, { main: m.t_format, playoff }, new Map([[depthKey(m.stage, m.bracket), row?.top || m.round]])).bestOf;
}

async function scores(q: Queryable, input: { scoreA: unknown; scoreB: unknown }, m: Locked) {
  const scoreA = v.intIn(input.scoreA, 0, 999);
  const scoreB = v.intIn(input.scoreB, 0, 999);
  // A best-of-N series ends when one side has won (N + 1) / 2 games.
  const bestOf = await seriesLengthOf(q, m);
  if (bestOf > 1 && !seriesScoreValid(bestOf, scoreA, scoreB)) fail("invalid_series_score");
  if (scoreA === scoreB && !drawAllowed(m)) fail("draw_not_allowed");
  const winner: string | null = scoreA === scoreB ? null : scoreA > scoreB ? m.a_reg! : m.b_reg!;
  return { scoreA, scoreB, winner };
}

export async function nextVersion(q: Queryable, matchId: string) {
  const [row] = await q.query<{ n: number }>("select coalesce(max(version), 0)::int + 1 as n from match_results where match_id = $1", [matchId]);
  return row?.n ?? 1;
}

/** Staff who see dispute and review queues: the space's members and the tournament's co-organisers. */
export async function staffFor(q: Queryable, orgId: string, tournamentId?: string) {
  const rows = await q.query<{ user_id: string }>(
    "select user_id from org_members where org_id = $1 union select user_id from tournament_organizers where tournament_id = $2",
    [orgId, tournamentId ?? null],
  );
  return rows.map((r) => r.user_id);
}

export type ResultInput = { scoreA: unknown; scoreB: unknown; evidenceUrl: unknown; note: unknown };

/** A participant reports a result. The opponent confirms it or opens a dispute. */
export async function submitResult(db: Database, user: SessionUser, matchId: string, input: ResultInput) {
  await db.tx(async (q) => {
    const m = await lockMatchWithTournament(q, matchId);
    live(m);
    if (!["ready", "in_progress", "result_submitted"].includes(m.status)) fail(m.status === "completed" ? "already_completed" : "match_not_ready");
    const side = await sideOf(q, m, user.id);
    if (!side) fail("not_participant");
    const { scoreA, scoreB, winner } = await scores(q, input, m);
    const evidence = v.optionalUrl(input.evidenceUrl);
    const note = v.clean(input.note, 1000);
    const pending = await q.query<{ id: string; side: string; score_a: number; score_b: number; winner_reg: string | null }>(
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
      await notify(q, await staffFor(q, m.org_id, m.tournament_id), "dispute_opened", { matchId: m.id, tournament: m.t_name });
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
    const m = await lockMatchWithTournament(q, matchId);
    live(m);
    if (m.status === "completed") fail("already_completed");
    const side = await sideOf(q, m, user.id);
    if (!side) fail("not_participant");
    const [pending] = await q.query<{ id: string; side: string; score_a: number; score_b: number; winner_reg: string | null }>(
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

/** Disputes a reported (not yet decided) result. Decided results use the post-result dispute flow. */
export async function disputeResult(db: Database, user: SessionUser, matchId: string, reasonInput: unknown) {
  const reason = v.clean(reasonInput, 1000);
  if (reason.length < 5) fail("invalid_input");
  await db.tx(async (q) => {
    const m = await lockMatchWithTournament(q, matchId);
    live(m);
    if (!["result_submitted", "ready", "in_progress"].includes(m.status)) fail(m.status === "completed" ? "already_completed" : "match_not_ready");
    const side = await sideOf(q, m, user.id);
    if (!side) fail("not_participant");
    await q.query("update matches set status = 'disputed', updated_at = now() where id = $1", [m.id]);
    await q.query("insert into disputes (match_id, opened_by, reason) values ($1, $2, $3)", [m.id, user.id, reason]);
    await notify(q, await staffFor(q, m.org_id, m.tournament_id), "dispute_opened", { matchId: m.id, tournament: m.t_name });
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
    const m = await lockMatchWithTournament(q, matchId);
    if (!(await refereeOf(q, m, user))) fail("forbidden");
    live(m);
    if (m.status === "completed") fail("already_completed");
    if (!m.a_reg || !m.b_reg) fail("match_not_ready");
    const { scoreA, scoreB, winner } = await scores(q, input, m);
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
      await q.query("update disputes set resolution = $2 where match_id = $1 and status = 'open' and kind = 'pre_result'", [m.id, resolution]);
    await completeMatch(q, m, { winner, scoreA, scoreB, outcome: "played" }, user.id);
    await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "result_confirmed", { matchId: m.id, tournament: m.t_name });
    await audit(q, { actorId: user.id, action: "match.official_result", entity: "match", entityId: m.id, data: { version, scoreA, scoreB } });
  });
}

/** The earliest moment a no-show can be recorded under the tournament's policy (null = any time). */
export function noShowFrom(m: { scheduled_at: Date | string | null; t_no_show: number | null }): Date | null {
  if (m.t_no_show === null || m.t_no_show === undefined || !m.scheduled_at) return null;
  return new Date(new Date(m.scheduled_at).getTime() + m.t_no_show * 60_000);
}

export async function markNoShow(db: Database, user: SessionUser, matchId: string, absentInput: unknown) {
  const absent = absentInput === "a" || absentInput === "b" ? absentInput : fail("invalid_input");
  await db.tx(async (q) => {
    const m = await lockMatchWithTournament(q, matchId);
    if (!(await refereeOf(q, m, user))) fail("forbidden");
    live(m);
    if (m.status === "completed") fail("already_completed");
    if (!m.a_reg || !m.b_reg) fail("match_not_ready");
    // Late policy: the absent side keeps its grace period after the scheduled time.
    const from = noShowFrom(m);
    if (from && from.getTime() > Date.now()) fail("no_show_too_early");
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
 * Corrects a confirmed result by adding a new version. Played or reported dependent matches block it,
 * so played games are never silently rewritten; automatic byes are re-routed.
 */
export async function correctResult(db: Database, user: SessionUser, matchId: string, input: ResultInput) {
  await db.tx(async (q) => {
    const m = await lockMatchWithTournament(q, matchId);
    if (!(await refereeOf(q, m, user))) fail("forbidden");
    if (!["IN_PROGRESS", "PAUSED", "COMPLETED"].includes(m.t_status)) fail("tournament_not_live");
    if (m.status !== "completed" || m.outcome === "bye" || !m.a_reg || !m.b_reg) fail("not_editable");
    requireStageOpen(m);
    const { scoreA, scoreB, winner } = await scores(q, input, m);
    const note = v.clean(input.note, 1000);
    if (note.length < 5) fail("invalid_input");
    if (isRoundBracket(m.bracket)) {
      const { rewriteRoundResult } = await import("./rounds.ts");
      await rewriteRoundResult(q, m, { winner, scoreA, scoreB, outcome: "played" });
    } else await rewriteWinner(q, m.id, winner!, { scoreA, scoreB, outcome: "played" }, user.id);
    await q.query("update match_results set status = 'superseded' where match_id = $1 and status = 'confirmed'", [m.id]);
    const version = await nextVersion(q, m.id);
    await q.query(
      `insert into match_results (match_id, version, source, submitted_by, score_a, score_b, winner_reg, evidence_url, note, status, decided_by, decided_at)
       values ($1,$2,'official',$3,$4,$5,$6,$7,$8,'confirmed',$3,now())`,
      [m.id, version, user.id, scoreA, scoreB, winner, v.optionalUrl(input.evidenceUrl), note],
    );
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
  input: { roomCode?: unknown; scheduledAt?: unknown; timeZone?: unknown; live?: unknown; venueId?: unknown; force?: unknown },
) {
  await db.tx(async (q) => {
    const m = await lockMatchWithTournament(q, matchId);
    const referee = await refereeOf(q, m, user);
    const side = await sideOf(q, m, user.id);
    if (!referee && !side) fail("forbidden");
    if (["completed", "cancelled"].includes(m.status)) fail("already_completed");
    if (input.roomCode !== undefined) {
      const code = v.oneLine(input.roomCode, 80);
      await q.query("update matches set room_code = $2, updated_at = now() where id = $1", [m.id, code]);
      await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))].filter((id) => id !== user.id), "room_code", { matchId: m.id, tournament: m.t_name });
    }
    let moved = false;
    const schedule = await import("./schedule.ts");
    const before = await schedule.scheduleConflicts(q, { id: m.tournament_id }, [m.id]);
    if (input.scheduledAt !== undefined && input.scheduledAt !== "") {
      if (!referee) fail("forbidden");
      const at = v.zonedToUtc(input.scheduledAt, input.timeZone);
      await q.query("update matches set scheduled_at = $2, updated_at = now() where id = $1", [m.id, at.toISOString()]);
      await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "match_scheduled", { matchId: m.id, tournament: m.t_name, at: at.toISOString() });
      moved = true;
    }
    const venueText = input.venueId === undefined ? null : String(input.venueId).trim();
    const currentVenue = m.venue_id ?? "";
    if (venueText !== null && venueText !== currentVenue) {
      if (!referee) fail("forbidden");
      let venueName = "";
      if (venueText) {
        const [venue] = await q.query<{ name: string }>("select name from tournament_venues where id::text = $1 and tournament_id = $2", [venueText, m.tournament_id]);
        if (!venue) fail("not_found");
        venueName = venue.name;
      }
      await q.query("update matches set venue_id = $2, updated_at = now() where id = $1", [m.id, venueText || null]);
      if (venueName)
        await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "match_venue", { matchId: m.id, tournament: m.t_name, venue: venueName, at: "" });
      moved = true;
    }
    // A venue hosts one match at a time and nobody plays two at once, unless the referee confirms the override.
    if (moved) {
      const conflicts = await schedule.guardConflicts(q, { id: m.tournament_id }, [m.id], v.bool(input.force), before);
      if (conflicts.length) await audit(q, { actorId: user.id, action: "match.schedule_override", entity: "match", entityId: m.id, data: { conflicts: conflicts.length, kinds: [...new Set(conflicts.map((c) => c.kind))] } });
    }
    if (v.bool(input.live)) {
      live(m);
      if (m.status !== "ready") fail("match_not_ready");
      await q.query("update matches set status = 'in_progress', updated_at = now() where id = $1", [m.id]);
    }
    await audit(q, { actorId: user.id, action: "match.details_updated", entity: "match", entityId: m.id });
  });
}

/**
 * A referee sets the series length of one match (and, for a table match, its points) before any result is
 * reported for it. Empty values return the match to what its round, group, stage and tournament say.
 */
export async function setMatchFormat(db: Database, user: SessionUser, matchId: string, input: Record<string, unknown>) {
  await db.tx(async (q) => {
    const m = await lockMatchWithTournament(q, matchId);
    if (!(await refereeOf(q, m, user))) fail("forbidden");
    if (!["IN_PROGRESS", "PAUSED"].includes(m.t_status)) fail("tournament_not_live");
    if (!["pending", "ready", "in_progress"].includes(m.status)) fail("not_editable");
    const [reported] = await q.query("select 1 from match_results where match_id = $1 and status in ('pending','confirmed') limit 1", [m.id]);
    if (reported) fail("not_editable");
    const { series, points } = parseMatchOverride(input, isRoundBracket(m.bracket), m.t_format === "swiss");
    await q.query("update matches set series_override = $2, points_override = $3, updated_at = now() where id = $1", [
      m.id,
      series,
      points ? JSON.stringify(points) : null,
    ]);
    await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "match_format_changed", { matchId: m.id, tournament: m.t_name });
    await audit(q, { actorId: user.id, action: "match.format_set", entity: "match", entityId: m.id, data: { series, points } });
  });
}
