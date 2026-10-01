/**
 * Bracket repair (owner's specification, section 9): correcting a decided elimination match after matches that
 * depended on it were played. Nothing is rewritten silently: a pure planner walks the bracket from the corrected
 * match along the winner and loser routes and lists every consequence, the referee sees the list, and the plan is
 * applied in one transaction only if the bracket is still exactly what was previewed (same plan hash).
 *
 * Consequences:
 *  - replace — a dependent match that has not started gets the right entrant (or loses one);
 *  - replay  — a started or decided dependent match is annulled (its result versions superseded, open disputes
 *              closed) and is played again with the right entrant; the places its result filled further on are
 *              emptied by the same rules;
 *  - remove_reset — a bracket reset that depended on a grand final being replayed or reversed is removed.
 * A replayed final or grand final returns the event to "in progress"; places are settled again when it ends.
 * Nothing already credited (XP, the champion award) is taken back. Round-robin, Swiss and group matches are
 * corrected by their own table rules and are not planned here.
 */
import { createHash } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail } from "./errors.ts";
import { correctResult, lockMatchWithTournament, nextVersion, requireStageOpen, scores } from "./matches.ts";
import { canRefereeTournament, completeTournament, regMembers } from "./tournaments.ts";
import { grantXp, XP } from "./progression.ts";
import * as v from "./validate.ts";

export type Slot = "a" | "b";

export type Node = {
  id: string;
  bracket: string;
  round: number;
  position: number;
  a_reg: string | null;
  b_reg: string | null;
  a_void: boolean;
  b_void: boolean;
  status: string;
  outcome: string | null;
  winner_reg: string | null;
  score_a: number | null;
  score_b: number | null;
  next_match_id: string | null;
  next_slot: Slot | null;
  loser_next_match_id: string | null;
  loser_next_slot: Slot | null;
  /** Result versions ever reported for the match. */
  results: number;
};

export type Annulled = { winner: string | null; scoreA: number | null; scoreB: number | null; outcome: string | null };

export type Step =
  | { kind: "replace"; matchId: string; slot: Slot; from: string | null; to: string | null }
  | { kind: "replay"; matchId: string; slot: Slot; from: string | null; to: string | null; annulled: Annulled }
  | { kind: "remove_reset"; matchId: string; annulled: Annulled | null };

export type Plan = { matchId: string; newWinner: string; steps: Step[]; reopens: boolean; hash: string };

const ELIMINATION = new Set(["W", "L", "GF"]);

const started = (n: Node) =>
  ["in_progress", "result_submitted", "disputed"].includes(n.status) || (n.status === "completed" && n.outcome !== "bye") || n.results > 0;
const annulledOf = (n: Node): Annulled => ({ winner: n.winner_reg, scoreA: n.score_a, scoreB: n.score_b, outcome: n.outcome });

/** Every consequence of giving `matchId` to `newWinner`, in the order they are applied. Pure. */
export function planRepair(nodes: Node[], matchId: string, newWinner: string): Plan {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const m = byId.get(matchId);
  if (!m) fail("not_found");
  if (!ELIMINATION.has(m!.bracket)) fail("not_editable");
  if (m!.status !== "completed" || m!.outcome === "bye" || !m!.winner_reg || !m!.a_reg || !m!.b_reg) fail("not_editable");
  if (newWinner !== m!.a_reg && newWinner !== m!.b_reg) fail("invalid_input");
  const steps: Step[] = [];
  let reopens = false;
  const done = (): Plan => {
    const hash = createHash("sha256").update(JSON.stringify({ matchId, newWinner, steps, reopens })).digest("hex").slice(0, 16);
    return { matchId, newWinner, steps, reopens, hash };
  };
  if (newWinner === m!.winner_reg) return done();
  const oldWinner = m!.winner_reg!;
  const oldLoser = oldWinner === m!.a_reg ? m!.b_reg : m!.a_reg;
  const reset = nodes.find((n) => n.bracket === "GF" && n.round === 2) ?? null;
  // Slots as the plan changes them, so later steps see earlier ones.
  const state = new Map(nodes.map((n) => [n.id, { a: n.a_reg, b: n.b_reg }]));
  const queue: Array<{ id: string; slot: Slot; from: string | null; to: string | null }> = [];
  const push = (id: string | null, slot: Slot | null, from: string | null, to: string | null) => {
    if (id && slot) queue.push({ id, slot, from, to });
  };

  if (m!.bracket === "GF" && m!.round === 1) {
    // The losers champion's grand-final win is reversed: the reset that win created goes.
    if (oldWinner === m!.b_reg && reset) steps.push({ kind: "remove_reset", matchId: reset.id, annulled: started(reset) ? annulledOf(reset) : null });
    // The other way round a reset is needed; the plain correction creates it (nothing depends on it yet).
    return done();
  }
  push(m!.next_match_id, m!.next_slot, oldWinner, newWinner);
  push(m!.loser_next_match_id, m!.loser_next_slot, oldLoser, oldWinner);

  while (queue.length) {
    const it = queue.shift()!;
    const n = byId.get(it.id);
    if (!n) fail("dependent_match_played");
    const cur = state.get(n!.id)!;
    if (cur[it.slot] !== it.from) {
      if (cur[it.slot] === it.to) continue;
      fail("dependent_match_played");
    }
    cur[it.slot] = it.to;
    if (n!.status === "cancelled") fail("dependent_match_played");
    const autoBye = n!.status === "completed" && n!.outcome === "bye" && (n!.a_void || n!.b_void);
    if (autoBye) {
      // A bye passes on whoever now sits in it.
      steps.push({ kind: "replace", matchId: n!.id, slot: it.slot, from: it.from, to: it.to });
      push(n!.next_match_id, n!.next_slot, it.from, it.to);
      continue;
    }
    if (!started(n!)) {
      steps.push({ kind: "replace", matchId: n!.id, slot: it.slot, from: it.from, to: it.to });
      continue;
    }
    const first = !steps.some((s) => s.kind === "replay" && s.matchId === n!.id);
    steps.push({ kind: "replay", matchId: n!.id, slot: it.slot, from: it.from, to: it.to, annulled: annulledOf(n!) });
    // A decided match's result is undone once: its winner and loser leave the places it gave them.
    if (first && n!.status === "completed" && n!.winner_reg) {
      const loser = n!.winner_reg === n!.a_reg ? n!.b_reg : n!.a_reg;
      push(n!.next_match_id, n!.next_slot, n!.winner_reg, null);
      if (loser) push(n!.loser_next_match_id, n!.loser_next_slot, loser, null);
      if (!n!.next_match_id) reopens = true;
      if (n!.bracket === "GF" && n!.round === 1 && reset && !steps.some((s) => s.kind === "remove_reset"))
        steps.push({ kind: "remove_reset", matchId: reset.id, annulled: started(reset) ? annulledOf(reset) : null });
    }
  }
  return done();
}

/** The elimination matches of the corrected match's stage, as the planner needs them. */
export async function bracketNodes(q: Queryable, tournamentId: string, stage: number): Promise<Node[]> {
  return q.query<Node>(
    `select m.id, m.bracket, m.round, m.position, m.a_reg, m.b_reg, m.a_void, m.b_void, m.status, m.outcome, m.winner_reg, m.score_a, m.score_b,
            m.next_match_id, m.next_slot, m.loser_next_match_id, m.loser_next_slot,
            (select count(*)::int from match_results r where r.match_id = m.id) as results
       from matches m where m.tournament_id = $1 and coalesce(m.stage, 1) = $2 and m.bracket in ('W','L','GF')`,
    [tournamentId, stage],
  );
}

/** The plan a referee would apply with this score; read-only. */
export async function previewRepair(q: Queryable, matchId: string, input: { scoreA: unknown; scoreB: unknown }): Promise<Plan> {
  const [ref] = await q.query<{ tournament_id: string }>("select tournament_id from matches where id = $1", [matchId]);
  if (!ref) fail("not_found");
  const [m] = await q.query<Parameters<typeof scores>[2]>(
    `select m.*, t.status as t_status, t.org_id, t.name as t_name, t.slug as t_slug, t.format as t_format, t.format_settings as t_settings,
            t.stage as t_stage, t.no_show_minutes as t_no_show, t.series_rules as t_series
       from matches m join tournaments t on t.id = m.tournament_id where m.id = $1`,
    [matchId],
  );
  const { winner } = await scores(q, input, m);
  if (!winner) fail("draw_not_allowed");
  return planRepair(await bracketNodes(q, m.tournament_id, m.stage ?? 1), m.id, winner!);
}

/**
 * Applies a previewed plan: the corrected result, then every consequence. Refused when the bracket changed since
 * the preview (`repair_plan_changed`). A plan with nothing to annul is an ordinary correction.
 */
export async function repairBracket(
  db: Database,
  user: SessionUser,
  matchId: string,
  input: { scoreA: unknown; scoreB: unknown; note: unknown; plan: unknown; evidenceUrl?: unknown },
): Promise<Plan> {
  const note = v.clean(input.note, 1000);
  if (note.length < 5) fail("invalid_input");
  const outcome = await db.tx(async (q): Promise<{ plan: Plan; simple: boolean }> => {
    const m = await lockMatchWithTournament(q, matchId);
    if (!(await canRefereeTournament(q, { id: m.tournament_id, org_id: m.org_id }, user))) fail("forbidden");
    if (!["IN_PROGRESS", "PAUSED", "COMPLETED"].includes(m.t_status)) fail("tournament_not_live");
    requireStageOpen(m);
    const { scoreA, scoreB, winner } = await scores(q, input, m);
    if (!winner) fail("draw_not_allowed");
    const plan = planRepair(await bracketNodes(q, m.tournament_id, m.stage ?? 1), m.id, winner!);
    if (plan.hash !== input.plan) fail("repair_plan_changed");
    if (!plan.steps.some((s) => s.kind !== "replace")) return { plan, simple: true };

    const touched = new Set<string>();
    const regs = new Set<string>([m.a_reg!, m.b_reg!]);
    for (const step of plan.steps) {
      touched.add(step.matchId);
      if (step.kind === "remove_reset") {
        const [r] = await q.query<{ a_reg: string | null; b_reg: string | null }>("select a_reg, b_reg from matches where id = $1", [step.matchId]);
        for (const x of [r?.a_reg, r?.b_reg]) if (x) regs.add(x);
        await q.query("delete from matches where id = $1", [step.matchId]);
        touched.delete(step.matchId);
        continue;
      }
      for (const x of [step.from, step.to]) if (x) regs.add(x);
      const col = step.slot === "a" ? "a_reg" : "b_reg";
      if (step.kind === "replay") {
        await q.query("update match_results set status = 'superseded' where match_id = $1 and status in ('pending','confirmed')", [step.matchId]);
        await q.query(
          "update disputes set status = 'resolved', resolution = 'annulled_by_bracket_repair', resolved_by = $2, resolved_at = now() where match_id = $1 and status = 'open'",
          [step.matchId, user.id],
        );
        await q.query(
          `update matches set ${col} = $2, winner_reg = null, score_a = null, score_b = null, outcome = null, completed_at = null,
             a_checked_in_at = null, b_checked_in_at = null, paused_at = null, pause_reason = '', status = 'pending', updated_at = now() where id = $1`,
          [step.matchId, step.to],
        );
        continue;
      }
      const [n] = await q.query<{ status: string; outcome: string | null; a_void: boolean; b_void: boolean }>(
        "select status, outcome, a_void, b_void from matches where id = $1",
        [step.matchId],
      );
      if (n.status === "completed" && n.outcome === "bye" && (n.a_void || n.b_void)) {
        // A bye keeps passing on whoever sits in it; with nobody left it waits again.
        if (step.to)
          await q.query(`update matches set ${col} = $2, winner_reg = $2, updated_at = now() where id = $1`, [step.matchId, step.to]);
        else
          await q.query(
            `update matches set ${col} = null, winner_reg = null, outcome = null, completed_at = null, status = 'pending', updated_at = now() where id = $1`,
            [step.matchId],
          );
        touched.delete(step.matchId);
        continue;
      }
      await q.query(`update matches set ${col} = $2, ${step.slot}_checked_in_at = null, updated_at = now() where id = $1`, [step.matchId, step.to]);
    }
    // Every touched open match is ready when both entrants are known, otherwise it waits.
    for (const id of touched)
      await q.query(
        `update matches set status = case when a_reg is not null and b_reg is not null then 'ready' else 'pending' end, updated_at = now()
          where id = $1 and status in ('pending','ready')`,
        [id],
      );

    // The corrected match itself, with a new result version.
    await q.query("update matches set winner_reg = $2, score_a = $3, score_b = $4, outcome = 'played', updated_at = now() where id = $1", [m.id, winner, scoreA, scoreB]);
    await q.query("update match_results set status = 'superseded' where match_id = $1 and status = 'confirmed'", [m.id]);
    const version = await nextVersion(q, m.id);
    await q.query(
      `insert into match_results (match_id, version, source, submitted_by, score_a, score_b, winner_reg, evidence_url, note, status, decided_by, decided_at)
       values ($1,$2,'official',$3,$4,$5,$6,$7,$8,'confirmed',$3,now())`,
      [m.id, version, user.id, scoreA, scoreB, winner, v.optionalUrl(input.evidenceUrl), note],
    );
    const [game] = await q.query<{ game: string }>("select game from tournaments where id = $1", [m.tournament_id]);
    await grantXp(q, await regMembers(q, winner), XP.matchWin, "match_win", game?.game ?? "", m.id, `match:${m.id}:win`);

    if (plan.reopens) {
      await q.query("update tournaments set status = 'IN_PROGRESS', completed_at = null, updated_at = now() where id = $1 and status = 'COMPLETED'", [m.tournament_id]);
      await q.query("update registrations set placement = null where tournament_id = $1", [m.tournament_id]);
    } else if (m.bracket === "GF" && plan.steps.some((s) => s.kind === "remove_reset")) await completeTournament(q, m.tournament_id);

    // Everyone in a changed match hears about it: the moved entrants and their opponents.
    for (const id of new Set(plan.steps.filter((x) => x.kind !== "remove_reset").map((x) => x.matchId))) {
      const [r] = await q.query<{ a_reg: string | null; b_reg: string | null }>("select a_reg, b_reg from matches where id = $1", [id]);
      for (const x of [r?.a_reg, r?.b_reg]) if (x) regs.add(x);
    }
    const members = new Set<string>();
    for (const r of regs) for (const u of await regMembers(q, r)) members.add(u);
    await notify(q, members, "bracket_repaired", { tournament: m.t_name, matchId: m.id });
    await audit(q, {
      actorId: user.id,
      action: "match.bracket_repaired",
      entity: "match",
      entityId: m.id,
      data: {
        plan: plan.hash,
        version,
        note,
        before: { winner: m.winner_reg, scoreA: m.score_a, scoreB: m.score_b },
        after: { winner, scoreA, scoreB },
        steps: plan.steps.map((s) => ({ kind: s.kind, match: s.matchId, ...(s.kind === "remove_reset" ? {} : { slot: s.slot, from: s.from, to: s.to }) })),
        reopened: plan.reopens,
      },
    });
    return { plan, simple: false };
  });
  // Only not-started matches change: the ordinary correction moves the entrants and repeats its own checks.
  if (outcome.simple) await correctResult(db, user, matchId, { scoreA: input.scoreA, scoreB: input.scoreB, evidenceUrl: input.evidenceUrl, note: input.note });
  return outcome.plan;
}
