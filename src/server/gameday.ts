/**
 * Game Day (owner's specification, section 9): the participant's central screen during an event.
 *
 * For every event the player is in today it finds the current match (or, when there is none, what the event
 * is waiting for) and explains, from the match state and the player's side, what is happening and the one
 * action available now. A participant can call the referee for an open match: one open call per side, which
 * staff close with a reply the side sees. Calls are the first kind of incident; the live-operations queue
 * extends the same table.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail } from "./errors.ts";
import { lockMatchWithTournament, noShowFrom, staffFor } from "./matches.ts";
import { canRefereeTournament, regLeaders, regMembers } from "./tournaments.ts";
import * as v from "./validate.ts";

export type StepKey =
  // a match of the player
  | "paused"
  | "waiting_opponent"
  | "check_in"
  | "opponent_check_in"
  | "opponent_absent"
  | "play"
  | "confirm"
  | "wait_confirm"
  | "review"
  | "won"
  | "won_last"
  | "dropped"
  | "lost"
  | "draw"
  | "bye"
  | "cancelled"
  // the event, when no match is open for the player
  | "event_check_in"
  | "event_ready"
  | "waiting_start"
  | "waiting_round"
  | "out"
  | "finished"
  | "disqualified"
  | "ffa"
  | "leaderboard";

export type StepAction = "checkin" | "report" | "confirm" | "call_referee" | "next" | "event_checkin" | "open_lobby" | "open_tournament";

export type Step = { key: StepKey; action: StepAction | null; deadline: Date | null };

export type MatchStepInput = {
  tStatus: string;
  status: string;
  outcome: string | null;
  side: "a" | "b";
  aReg: string | null;
  bReg: string | null;
  winnerReg: string | null;
  checkedIn: { a: boolean; b: boolean };
  /** Side that submitted the result now awaiting confirmation. */
  pendingSide: "a" | "b" | null;
  noShowAt: Date | null;
  /** Another open match of this side exists in the event (after a win, a bye, a draw or a drop to the lower bracket). */
  hasNext: boolean;
  now: Date;
};

const step = (key: StepKey, action: StepAction | null = null, deadline: Date | null = null): Step => ({ key, action, deadline });

/** What is happening in a match for one side, and the one action that side has now. Pure. */
export function matchStep(x: MatchStepInput): Step {
  const mine = x.side === "a" ? x.aReg : x.bReg;
  const other = x.side === "a" ? "b" : "a";
  if (x.status === "cancelled") return step("cancelled");
  if (x.status === "completed") {
    const next = x.hasNext ? "next" : null;
    if (x.outcome === "bye") return step("bye", next);
    if (!x.winnerReg) return step("draw", next);
    if (x.winnerReg === mine) return x.hasNext ? step("won", "next") : step("won_last");
    return x.hasNext ? step("dropped", "next") : step("lost");
  }
  if (x.tStatus === "PAUSED") return step("paused");
  if (!x.aReg || !x.bReg || x.status === "pending") return step("waiting_opponent");
  if (x.status === "disputed") return step("review");
  if (x.status === "result_submitted") return x.pendingSide === x.side ? step("wait_confirm") : step("confirm", "confirm");
  if (x.status === "ready" && x.tStatus === "IN_PROGRESS") {
    if (!x.checkedIn[x.side]) return step("check_in", "checkin", x.noShowAt);
    if (!x.checkedIn[other]) {
      if (x.noShowAt && x.now.getTime() >= x.noShowAt.getTime()) return step("opponent_absent", "call_referee");
      return step("opponent_check_in", null, x.noShowAt);
    }
  }
  return step("play", "report");
}

export type EventStepInput = {
  tStatus: string;
  format: string;
  regStatus: string;
  checkInOpen: boolean;
  checkedIn: boolean;
  /** The player's last completed match was lost in an elimination bracket and nothing follows it. */
  eliminated: boolean;
  /** An open FFA lobby of the player. */
  lobby: boolean;
};

/** What the event is waiting for when the player has no open match. Pure. */
export function eventStep(x: EventStepInput): Step {
  if (x.regStatus === "disqualified") return step("disqualified", "open_tournament");
  if (["COMPLETED", "ARCHIVED"].includes(x.tStatus)) return step("finished", "open_tournament");
  if (["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(x.tStatus)) {
    if (x.checkedIn) return step("event_ready");
    if (x.checkInOpen) return step("event_check_in", "event_checkin");
    return step("waiting_start");
  }
  if (x.tStatus === "PAUSED") return step("paused");
  if (x.format === "ffa") return x.lobby ? step("ffa", "open_lobby") : step(x.eliminated ? "out" : "waiting_round");
  if (x.format === "leaderboard") return step("leaderboard", "open_tournament");
  return step(x.eliminated ? "out" : "waiting_round");
}

/** Brackets where a loss with nothing after it ends the player's event. */
const ELIMINATION_BRACKETS = new Set(["W", "L", "GF"]);

export type GameDayEntry = {
  tournament: {
    id: string;
    slug: string;
    name: string;
    game: string;
    status: string;
    format: string;
    starts_at: Date;
    check_in_open: boolean;
    check_in_required: boolean;
  };
  registration: { id: string; status: string; checked_in_at: Date | null; placement: number | null; team_name: string | null };
  /** May act for the entry: the solo player, or the team's owner or captain. */
  leader: boolean;
  matchId: string | null;
  lobbyId: string | null;
  step: Step;
};

type MatchRow = {
  id: string;
  status: string;
  outcome: string | null;
  bracket: string | null;
  a_reg: string | null;
  b_reg: string | null;
  winner_reg: string | null;
  a_checked_in_at: Date | null;
  b_checked_in_at: Date | null;
  scheduled_at: Date | null;
};

const MATCH_COLUMNS = "m.id, m.status, m.outcome, m.bracket, m.a_reg, m.b_reg, m.winner_reg, m.a_checked_in_at, m.b_checked_in_at, m.scheduled_at";

/** The open match of an entry that comes first in the event: earlier stage and round first. */
export async function openMatchFor(q: Queryable, tournamentId: string, regId: string, exceptId?: string) {
  const [m] = await q.query<MatchRow>(
    `select ${MATCH_COLUMNS} from matches m
      where m.tournament_id = $1 and (m.a_reg = $2 or m.b_reg = $2) and m.status not in ('completed','cancelled') and m.id <> coalesce($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      order by m.stage, m.round, m.scheduled_at nulls last, m.position limit 1`,
    [tournamentId, regId, exceptId ?? null],
  );
  return m ?? null;
}

export async function pendingSideOf(q: Queryable, matchId: string): Promise<"a" | "b" | null> {
  const [r] = await q.query<{ side: "a" | "b" | null }>("select side from match_results where match_id = $1 and status = 'pending' order by version desc limit 1", [matchId]);
  return r?.side ?? null;
}

/** The player's events for today: live, about to start (check-in open or within a day), or finished within a day. */
export async function gameDay(q: Queryable, user: SessionUser, now = new Date()): Promise<GameDayEntry[]> {
  const regs = await q.query<{
    id: string;
    status: string;
    checked_in_at: Date | null;
    placement: number | null;
    team_name: string | null;
    t_id: string;
    slug: string;
    name: string;
    game: string;
    t_status: string;
    format: string;
    t_stage: number | null;
    starts_at: Date;
    check_in_open: boolean;
    check_in_required: boolean;
    no_show_minutes: number | null;
  }>(
    `select r.id, r.status, r.checked_in_at, r.placement, tm.name as team_name,
            t.id as t_id, t.slug, t.name, t.game, t.status as t_status, t.format, t.stage as t_stage, t.starts_at, t.check_in_open, t.check_in_required, t.no_show_minutes
       from registrations r join tournaments t on t.id = r.tournament_id left join teams tm on tm.id = r.team_id
      where r.status in ('registered','disqualified')
        and (r.user_id = $1 or tm.owner_id = $1 or tm.captain_id = $1
             or exists (select 1 from roster_entries re where re.registration_id = r.id and re.user_id = $1))
        and (t.status in ('IN_PROGRESS','PAUSED')
             or (t.status in ('REGISTRATION_OPEN','REGISTRATION_CLOSED') and (t.check_in_open or t.starts_at < $2::timestamptz + interval '24 hours'))
             or (t.status = 'COMPLETED' and t.completed_at > $2::timestamptz - interval '24 hours'))
      order by case when t.status in ('IN_PROGRESS','PAUSED') then 0 when t.status = 'COMPLETED' then 2 else 1 end, t.starts_at, t.name
      limit 12`,
    [user.id, now.toISOString()],
  );
  const out: GameDayEntry[] = [];
  for (const r of regs) {
    const live = ["IN_PROGRESS", "PAUSED"].includes(r.t_status);
    const current = live ? await openMatchFor(q, r.t_id, r.id) : null;
    let entryStep: Step;
    let matchId: string | null = null;
    let lobbyId: string | null = null;
    if (current) {
      const side = current.a_reg === r.id ? "a" : "b";
      matchId = current.id;
      entryStep = matchStep({
        tStatus: r.t_status,
        status: current.status,
        outcome: current.outcome,
        side,
        aReg: current.a_reg,
        bReg: current.b_reg,
        winnerReg: current.winner_reg,
        checkedIn: { a: Boolean(current.a_checked_in_at), b: Boolean(current.b_checked_in_at) },
        pendingSide: current.status === "result_submitted" ? await pendingSideOf(q, current.id) : null,
        noShowAt: noShowFrom({ scheduled_at: current.scheduled_at, t_no_show: r.no_show_minutes }),
        hasNext: false,
        now,
      });
    } else {
      const [last] = await q.query<MatchRow>(
        `select ${MATCH_COLUMNS} from matches m where m.tournament_id = $1 and (m.a_reg = $2 or m.b_reg = $2) and m.status = 'completed'
          order by m.completed_at desc nulls last, m.stage desc, m.round desc limit 1`,
        [r.t_id, r.id],
      );
      if (last) matchId = last.id;
      if (r.format === "ffa" && live) {
        const [lobby] = await q.query<{ id: string }>(
          "select l.id from ffa_lobbies l join ffa_entries e on e.lobby_id = l.id where e.registration_id = $1 and l.status = 'open' order by l.round desc limit 1",
          [r.id],
        );
        lobbyId = lobby?.id ?? null;
      }
      let eliminated = false;
      if (r.format === "ffa") {
        // Out once a newer round exists without the player; between rounds the player is waiting, not out.
        if (live && !lobbyId) {
          const [x] = await q.query<{ mine: number | null; current: number | null }>(
            "select (select max(round) from ffa_entries where registration_id = $1)::int as mine, (select max(round) from ffa_lobbies where tournament_id = $2)::int as current",
            [r.id, r.t_id],
          );
          eliminated = x?.mine != null && x.current != null && x.current > x.mine;
        }
      } else if (last) {
        const lostInBracket = Boolean(last.winner_reg && last.winner_reg !== r.id && ELIMINATION_BRACKETS.has(last.bracket ?? ""));
        const missedPlayoff =
          r.t_stage === 2 && !(await q.query("select 1 from matches where tournament_id = $1 and stage = 2 and (a_reg = $2 or b_reg = $2) limit 1", [r.t_id, r.id])).length;
        eliminated = lostInBracket || missedPlayoff;
      }
      entryStep = eventStep({
        tStatus: r.t_status,
        format: r.format,
        regStatus: r.status,
        checkInOpen: r.check_in_open,
        checkedIn: Boolean(r.checked_in_at),
        eliminated,
        lobby: Boolean(lobbyId),
      });
    }
    out.push({
      tournament: {
        id: r.t_id,
        slug: r.slug,
        name: r.name,
        game: r.game,
        status: r.t_status,
        format: r.format,
        starts_at: r.starts_at,
        check_in_open: r.check_in_open,
        check_in_required: r.check_in_required,
      },
      registration: { id: r.id, status: r.status, checked_in_at: r.checked_in_at, placement: r.placement, team_name: r.team_name },
      leader: (await regLeaders(q, r.id)).includes(user.id),
      matchId,
      lobbyId,
      step: entryStep,
    });
  }
  return out;
}

// ---------- Referee calls ----------

export type RefereeCall = {
  id: string;
  side: "a" | "b" | null;
  message: string;
  status: "open" | "resolved";
  resolution: string;
  created_at: Date;
  resolved_at: Date | null;
  opened_by: string;
  resolved_by: string | null;
};

/** Calls of a match, newest first, with the usernames of the caller and of the staff member who answered. */
export async function refereeCalls(q: Queryable, matchId: string): Promise<RefereeCall[]> {
  return q.query<RefereeCall>(
    `select i.id, i.side, i.message, i.status, i.resolution, i.created_at, i.resolved_at, u.username as opened_by, s.username as resolved_by
       from incidents i join users u on u.id = i.opened_by left join users s on s.id = i.resolved_by
      where i.match_id = $1 and i.kind = 'referee_call' order by i.created_at desc`,
    [matchId],
  );
}

async function sideName(q: Queryable, regId: string | null) {
  const [r] = await q.query<{ name: string }>(
    "select coalesce(tm.name, u.display_name) as name from registrations r left join teams tm on tm.id = r.team_id left join users u on u.id = r.user_id where r.id = $1",
    [regId],
  );
  return r?.name ?? "";
}

/**
 * A participant asks the referee to come to the match. Players on the roster and the entry's leaders may call;
 * a side has at most one open call, so a repeated call returns the open one and notifies nobody again.
 */
export async function callReferee(db: Database, user: SessionUser, matchId: string, messageInput: unknown): Promise<{ id: string; created: boolean }> {
  const message = v.clean(messageInput, 500);
  if (message.length < 3) fail("invalid_input");
  return db.tx(async (q) => {
    const m = await lockMatchWithTournament(q, matchId);
    if (!["IN_PROGRESS", "PAUSED"].includes(m.t_status)) fail("tournament_not_live");
    if (["completed", "cancelled"].includes(m.status)) fail("match_closed");
    const inSide = async (reg: string | null) => [...(await regMembers(q, reg)), ...(await regLeaders(q, reg))].includes(user.id);
    const side = m.a_reg && (await inSide(m.a_reg)) ? "a" : m.b_reg && (await inSide(m.b_reg)) ? "b" : null;
    if (!side) fail("not_participant");
    const [open] = await q.query<{ id: string }>(
      "select id from incidents where match_id = $1 and side = $2 and kind = 'referee_call' and status = 'open'",
      [m.id, side],
    );
    if (open) return { id: open.id, created: false };
    const [row] = await q.query<{ id: string }>(
      "insert into incidents (tournament_id, match_id, kind, side, opened_by, message) values ($1, $2, 'referee_call', $3, $4, $5) returning id",
      [m.tournament_id, m.id, side, user.id, message],
    );
    const staff = (await staffFor(q, m.org_id, m.tournament_id)).filter((id) => id !== user.id);
    await notify(q, staff, "referee_call", { tournament: m.t_name, matchId: m.id, side: await sideName(q, side === "a" ? m.a_reg : m.b_reg) });
    await audit(q, { actorId: user.id, action: "match.referee_called", entity: "match", entityId: m.id, data: { side, incident: row.id } });
    return { id: row.id, created: true };
  });
}

/** Staff answer a call and close it; the caller and the side's leaders are notified. Closing a closed call changes nothing. */
export async function closeRefereeCall(db: Database, user: SessionUser, callId: string, noteInput: unknown): Promise<{ matchId: string; closed: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(callId)) fail("not_found");
  const note = v.clean(noteInput, 500);
  return db.tx(async (q) => {
    const [ref] = await q.query<{ match_id: string | null }>("select match_id from incidents where id = $1 and kind = 'referee_call'", [callId]);
    if (!ref?.match_id) fail("not_found");
    // Same lock order as every match writer: tournament, match, then the call.
    const m = await lockMatchWithTournament(q, ref!.match_id!);
    if (!(await canRefereeTournament(q, { id: m.tournament_id, org_id: m.org_id }, user))) fail("forbidden");
    const [call] = await q.query<{ status: string; opened_by: string; side: "a" | "b" | null }>(
      "select status, opened_by, side from incidents where id = $1 for update",
      [callId],
    );
    if (call.status !== "open") return { matchId: m.id, closed: false };
    await q.query("update incidents set status = 'resolved', resolution = $2, resolved_by = $3, resolved_at = now() where id = $1", [callId, note, user.id]);
    const leaders = call.side ? await regLeaders(q, call.side === "a" ? m.a_reg : m.b_reg) : [];
    await notify(q, [call.opened_by, ...leaders].filter((id) => id !== user.id), "referee_call_closed", { tournament: m.t_name, matchId: m.id });
    await audit(q, { actorId: user.id, action: "match.referee_call_closed", entity: "match", entityId: m.id, data: { incident: callId } });
    return { matchId: m.id, closed: true };
  });
}

/** Open calls of a tournament, oldest first: the referee's to-do list. */
export async function openCallsFor(q: Queryable, tournamentId: string) {
  return q.query<{ id: string; match_id: string; side: "a" | "b" | null; message: string; created_at: Date; opened_by: string }>(
    `select i.id, i.match_id, i.side, i.message, i.created_at, u.username as opened_by
       from incidents i join users u on u.id = i.opened_by
      where i.tournament_id = $1 and i.kind = 'referee_call' and i.status = 'open' order by i.created_at`,
    [tournamentId],
  );
}
