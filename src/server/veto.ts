/**
 * Map veto (owner's specification, section 9), algorithm MV-VETO-1.
 *
 * The event has a map pool; each match's series length (MV-SERIES-1) decides the turns. With N maps and a best of K:
 * K − 1 picks and N − K bans. Two opening bans come first when there are spare maps, then the picks, then the
 * remaining bans; the one map left is the decider. Side A (the higher seed) starts and the sides alternate. Only the
 * leaders of the side whose turn it is act; a map is taken once; a referee can reset the veto with a reason.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail } from "./errors.ts";
import { lockMatchWithTournament, seriesLengthOf } from "./matches.ts";
import { canRefereeTournament, regLeaders, regMembers } from "./tournaments.ts";
import * as v from "./validate.ts";
import { mapPoolOf } from "./map-pool.ts";

export const VETO_VERSION = "MV-VETO-1";
export { MAX_POOL, mapPoolOf, parseMapPool } from "./map-pool.ts";

export type Side = "a" | "b";
export type VetoAction = "ban" | "pick";
export type VetoTurn = { step: number; side: Side; action: VetoAction };
export type VetoRow = { step: number; side: Side; action: VetoAction; map: string };

/** The turns for a pool and a series length, or null when the pool is too small for the series. Pure. */
export function vetoSequence(pool: number, bestOf: number): VetoTurn[] | null {
  if (pool < 2 || bestOf < 1 || pool < bestOf) return null;
  const picks = bestOf - 1;
  const bans = pool - bestOf;
  const opening = Math.min(2, bans);
  const actions: VetoAction[] = [...Array(opening).fill("ban"), ...Array(picks).fill("pick"), ...Array(bans - opening).fill("ban")];
  return actions.map((action, i) => ({ step: i + 1, side: i % 2 === 0 ? "a" : "b", action }));
}

export type VetoState = {
  turns: VetoTurn[];
  done: VetoRow[];
  next: VetoTurn | null;
  remaining: string[];
  /** Maps to play in order: the picks, then the decider once every turn is taken. */
  maps: Array<{ map: string; by: Side | null }>;
  complete: boolean;
};

/** Where a veto stands. Pure. */
export function vetoState(pool: string[], bestOf: number, rows: VetoRow[]): VetoState | null {
  const turns = vetoSequence(pool.length, bestOf);
  if (!turns) return null;
  const done = [...rows].sort((a, b) => a.step - b.step);
  const taken = new Set(done.map((r) => r.map));
  const remaining = pool.filter((m) => !taken.has(m));
  const complete = done.length >= turns.length;
  const maps: VetoState["maps"] = done.filter((r) => r.action === "pick").map((r) => ({ map: r.map, by: r.side }));
  if (complete && remaining.length === 1) maps.push({ map: remaining[0], by: null });
  return { turns, done, next: complete ? null : turns[done.length], remaining, maps, complete };
}

export async function vetoRows(q: Queryable, matchId: string): Promise<VetoRow[]> {
  return q.query<VetoRow>("select step, side, action, map from match_vetoes where match_id = $1 order by step", [matchId]);
}

/** A leader of the side whose turn it is bans or picks a map. */
export async function vetoMap(db: Database, user: SessionUser, matchId: string, mapInput: unknown): Promise<VetoState> {
  const map = typeof mapInput === "string" ? mapInput : "";
  return db.tx(async (q) => {
    const m = await lockMatchWithTournament(q, matchId);
    if (m.t_status !== "IN_PROGRESS") fail("tournament_not_live");
    if (!m.a_reg || !m.b_reg || !["ready", "in_progress"].includes(m.status)) fail("match_not_ready");
    if (m.paused_at) fail("match_paused");
    const [t] = await q.query<{ map_pool: unknown }>("select map_pool from tournaments where id = $1", [m.tournament_id]);
    const pool = mapPoolOf(t ?? {});
    if (!pool) fail("veto_unavailable");
    const state = vetoState(pool!, await seriesLengthOf(q, m), await vetoRows(q, m.id));
    if (!state) fail("veto_unavailable");
    if (state!.complete || !state!.next) fail("veto_complete");
    const turn = state!.next!;
    if (!(await regLeaders(q, turn.side === "a" ? m.a_reg : m.b_reg)).includes(user.id)) fail("not_your_turn");
    if (!state!.remaining.includes(map)) fail("invalid_input");
    await q.query("insert into match_vetoes (match_id, step, side, action, map, created_by) values ($1, $2, $3, $4, $5, $6)", [
      m.id,
      turn.step,
      turn.side,
      turn.action,
      map,
      user.id,
    ]);
    await audit(q, { actorId: user.id, action: "match.veto", entity: "match", entityId: m.id, data: { step: turn.step, side: turn.side, action: turn.action, map } });
    const after = vetoState(pool!, await seriesLengthOf(q, m), await vetoRows(q, m.id))!;
    if (after.complete)
      await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "veto_done", {
        tournament: m.t_name,
        matchId: m.id,
        maps: after.maps.map((x) => x.map).join(", "),
      });
    else {
      const other = after.next!.side === "a" ? m.a_reg : m.b_reg;
      await notify(q, await regLeaders(q, other), "veto_turn", { tournament: m.t_name, matchId: m.id });
    }
    return after;
  });
}

/** A referee clears the veto so the sides start again; both sides are told why. */
export async function resetVeto(db: Database, user: SessionUser, matchId: string, reasonInput: unknown): Promise<{ changed: boolean }> {
  const reason = v.clean(reasonInput, 300);
  if (reason.length < 3) fail("invalid_input");
  return db.tx(async (q) => {
    const m = await lockMatchWithTournament(q, matchId);
    if (!(await canRefereeTournament(q, { id: m.tournament_id, org_id: m.org_id }, user))) fail("forbidden");
    if (["completed", "cancelled"].includes(m.status)) fail("not_editable");
    const removed = await q.query("delete from match_vetoes where match_id = $1 returning step", [m.id]);
    if (!removed.length) return { changed: false };
    await audit(q, { actorId: user.id, action: "match.veto_reset", entity: "match", entityId: m.id, data: { reason, steps: removed.length } });
    await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "veto_reset", { tournament: m.t_name, matchId: m.id });
    return { changed: true };
  });
}

/** The veto of a match as a viewer sees it, or null when the event has no usable pool for this match's series. */
export async function vetoFor(q: Queryable, matchId: string, viewerId?: string | null) {
  const [m] = await q.query<Parameters<typeof seriesLengthOf>[1] & { map_pool: unknown }>(
    `select m.*, t.status as t_status, t.org_id, t.name as t_name, t.slug as t_slug, t.format as t_format, t.format_settings as t_settings,
            t.stage as t_stage, t.no_show_minutes as t_no_show, t.series_rules as t_series, t.map_pool
       from matches m join tournaments t on t.id = m.tournament_id where m.id = $1`,
    [matchId],
  );
  if (!m) return null;
  const pool = mapPoolOf(m);
  if (!pool) return null;
  const bestOf = await seriesLengthOf(q, m);
  const state = vetoState(pool, bestOf, await vetoRows(q, m.id));
  if (!state) return null;
  const nextSide = state.next ? (state.next.side === "a" ? m.a_reg : m.b_reg) : null;
  const myTurn = Boolean(viewerId && nextSide && (await regLeaders(q, nextSide)).includes(viewerId));
  return { state, pool, bestOf, myTurn };
}
