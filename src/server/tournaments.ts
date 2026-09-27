import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { canManageOrg, canReferee, notify } from "./access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { planSingleElimination, placementForLoss } from "./bracket.ts";
import { gameBySlug } from "../lib/games.ts";
import { uniqueSlug } from "./teams.ts";
import * as v from "./validate.ts";

export const STATUSES = [
  "DRAFT",
  "PUBLISHED",
  "REGISTRATION_OPEN",
  "REGISTRATION_CLOSED",
  "IN_PROGRESS",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
  "ARCHIVED",
] as const;
export type TournamentStatus = (typeof STATUSES)[number];

/** Explicitly allowed manual transitions. COMPLETED is reached only by confirming the final. */
export const TRANSITIONS: Record<TournamentStatus, TournamentStatus[]> = {
  DRAFT: ["PUBLISHED", "CANCELLED"],
  PUBLISHED: ["DRAFT", "REGISTRATION_OPEN", "CANCELLED"],
  REGISTRATION_OPEN: ["REGISTRATION_CLOSED", "CANCELLED"],
  REGISTRATION_CLOSED: ["REGISTRATION_OPEN", "IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["PAUSED", "CANCELLED"],
  PAUSED: ["IN_PROGRESS", "CANCELLED"],
  COMPLETED: ["ARCHIVED"],
  CANCELLED: ["ARCHIVED"],
  ARCHIVED: [],
};

export type TournamentRow = {
  id: string;
  slug: string;
  org_id: string;
  name: string;
  game: string;
  participant_type: "solo" | "team";
  team_size: number;
  max_participants: number;
  check_in_required: boolean;
  check_in_open: boolean;
  status: TournamentStatus;
  starts_at: Date;
};

export type MatchRow = {
  id: string;
  tournament_id: string;
  round: number;
  position: number;
  a_reg: string | null;
  b_reg: string | null;
  winner_reg: string | null;
  score_a: number | null;
  score_b: number | null;
  status: string;
  outcome: string | null;
  next_match_id: string | null;
  next_slot: "a" | "b" | null;
};

export async function lockTournament(q: Queryable, id: string): Promise<TournamentRow> {
  const [t] = await q.query<TournamentRow>("select * from tournaments where id = $1 for update", [id]);
  if (!t) fail("not_found");
  return t;
}

async function requireManager(q: Queryable, t: TournamentRow, user: SessionUser) {
  if (!(await canManageOrg(q, t.org_id, user))) fail("forbidden");
}

export type TournamentInput = {
  name: unknown;
  game: unknown;
  participantType: unknown;
  teamSize: unknown;
  maxParticipants: unknown;
  checkInRequired: unknown;
  region: unknown;
  startsAt: unknown;
  timeZone: unknown;
  description: unknown;
  rules: unknown;
};

function parseInput(input: TournamentInput) {
  const name = v.displayName(input.name, 80);
  const game = gameBySlug(String(input.game ?? ""));
  if (!game || !game.bracket) fail("invalid_game");
  const participantType = input.participantType === "team" ? "team" : input.participantType === "solo" ? "solo" : fail("invalid_input");
  const teamSize = participantType === "solo" ? 1 : v.intIn(input.teamSize || game!.teamSize, 2, 10);
  return {
    name,
    game: game!.slug,
    participantType,
    teamSize,
    maxParticipants: v.intIn(input.maxParticipants, 2, 512),
    checkInRequired: v.bool(input.checkInRequired),
    region: v.oneLine(input.region, 60),
    startsAt: v.zonedToUtc(input.startsAt, input.timeZone),
    description: v.clean(input.description, 4000),
    rules: v.clean(input.rules, 8000),
  };
}

export async function createTournament(db: Database, user: SessionUser, orgId: string, input: TournamentInput) {
  const data = parseInput(input);
  return db.tx(async (q) => {
    if (!(await canManageOrg(q, orgId, user))) fail("forbidden");
    const slug = await uniqueSlug(q, "tournaments", data.name);
    const [t] = await q.query<{ id: string; slug: string }>(
      `insert into tournaments (slug, org_id, name, game, participant_type, team_size, max_participants,
         check_in_required, region, starts_at, description, rules, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id, slug`,
      [slug, orgId, data.name, data.game, data.participantType, data.teamSize, data.maxParticipants, data.checkInRequired,
        data.region, data.startsAt.toISOString(), data.description, data.rules, user.id],
    );
    await audit(q, { actorId: user.id, action: "tournament.created", entity: "tournament", entityId: t.id, data: { name: data.name, game: data.game } });
    return t;
  });
}

export async function updateTournament(db: Database, user: SessionUser, tournamentId: string, input: TournamentInput) {
  const data = parseInput(input);
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (!["DRAFT", "PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status)) fail("not_editable");
    const [count] = await q.query<{ n: number; active: number }>(
      "select count(*)::int as n, count(*) filter (where status = 'registered')::int as active from registrations where tournament_id = $1 and status <> 'withdrawn'",
      [t.id],
    );
    const structural = data.game !== t.game || data.participantType !== t.participant_type || data.teamSize !== t.team_size;
    if (structural && (count?.n ?? 0) > 0) fail("not_editable");
    if (data.maxParticipants < (count?.active ?? 0)) fail("invalid_input");
    await q.query(
      `update tournaments set name=$2, game=$3, participant_type=$4, team_size=$5, max_participants=$6,
         check_in_required=$7, region=$8, starts_at=$9, description=$10, rules=$11, updated_at=now() where id=$1`,
      [t.id, data.name, data.game, data.participantType, data.teamSize, data.maxParticipants, data.checkInRequired,
        data.region, data.startsAt.toISOString(), data.description, data.rules],
    );
    await audit(q, { actorId: user.id, action: "tournament.updated", entity: "tournament", entityId: t.id });
  });
}

async function rosterUsers(q: Queryable, tournamentId: string): Promise<string[]> {
  const rows = await q.query<{ user_id: string }>(
    `select re.user_id from roster_entries re join registrations r on r.id = re.registration_id
      where re.tournament_id = $1 and r.status in ('registered')`,
    [tournamentId],
  );
  return rows.map((r) => r.user_id);
}

export async function regMembers(q: Queryable, regId: string | null): Promise<string[]> {
  if (!regId) return [];
  const rows = await q.query<{ user_id: string }>("select user_id from roster_entries where registration_id = $1", [regId]);
  return rows.map((r) => r.user_id);
}

/** Users who may act for a registration: the solo player, or the team's current owner and captain. */
export async function regLeaders(q: Queryable, regId: string | null): Promise<string[]> {
  if (!regId) return [];
  const [r] = await q.query<{ user_id: string | null; owner_id: string | null; captain_id: string | null }>(
    `select r.user_id, t.owner_id, t.captain_id from registrations r left join teams t on t.id = r.team_id where r.id = $1`,
    [regId],
  );
  if (!r) return [];
  return [r.user_id, r.owner_id, r.captain_id].filter((x): x is string => Boolean(x));
}

export async function transition(db: Database, user: SessionUser, tournamentId: string, toInput: unknown) {
  const to = String(toInput) as TournamentStatus;
  if (!STATUSES.includes(to)) fail("invalid_transition");
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (!TRANSITIONS[t.status].includes(to)) fail("invalid_transition");
    if (t.status === "PUBLISHED" && to === "DRAFT") {
      const [r] = await q.query("select 1 from registrations where tournament_id = $1 limit 1", [t.id]);
      if (r) fail("invalid_transition");
    }
    if (t.status === "REGISTRATION_CLOSED" && to === "IN_PROGRESS") await startBracket(q, t, user);
    if (to === "CANCELLED") {
      await q.query("update matches set status = 'cancelled', updated_at = now() where tournament_id = $1 and status <> 'completed'", [t.id]);
      await notify(q, await rosterUsers(q, t.id), "tournament_cancelled", { tournament: t.name, slug: t.slug });
    }
    if (to === "PAUSED" || (t.status === "PAUSED" && to === "IN_PROGRESS"))
      await notify(q, await rosterUsers(q, t.id), to === "PAUSED" ? "tournament_paused" : "tournament_resumed", { tournament: t.name, slug: t.slug });
    await q.query("update tournaments set status = $2, updated_at = now() where id = $1", [t.id, to]);
    if (to === "CANCELLED") await q.query("update tournaments set check_in_open = false where id = $1", [t.id]);
    await audit(q, { actorId: user.id, action: "tournament.status", entity: "tournament", entityId: t.id, data: { from: t.status, to } });
  });
}

export async function register(db: Database, user: SessionUser, tournamentId: string, teamId?: string) {
  return db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    if (t.status !== "REGISTRATION_OPEN") fail("registration_closed");
    let roster: string[];
    let regUser: string | null = null;
    let regTeam: string | null = null;
    if (t.participant_type === "solo") {
      if (teamId) fail("wrong_participant_type");
      roster = [user.id];
      regUser = user.id;
    } else {
      if (!teamId) fail("wrong_participant_type");
      const [team] = await q.query<{ id: string; game: string; owner_id: string; captain_id: string }>(
        "select * from teams where id = $1 for update",
        [teamId],
      );
      if (!team) fail("not_found");
      if (team.owner_id !== user.id && team.captain_id !== user.id) fail("not_team_leader");
      if (team.game !== t.game) fail("team_game_mismatch");
      roster = (await q.query<{ user_id: string }>(
        "select m.user_id from team_members m join users u on u.id = m.user_id where m.team_id = $1 and u.status = 'active'",
        [team.id],
      )).map((r) => r.user_id);
      if (roster.length < t.team_size) fail("team_too_small");
      if (roster.length > t.team_size + 3) fail("team_too_large");
      regTeam = team.id;
    }
    const [active] = await q.query<{ n: number }>(
      "select count(*)::int as n from registrations where tournament_id = $1 and status = 'registered'",
      [t.id],
    );
    const status = (active?.n ?? 0) >= t.max_participants ? "waitlisted" : "registered";
    let regId: string;
    try {
      const [reg] = await q.query<{ id: string }>(
        `insert into registrations (tournament_id, user_id, team_id, registered_by, status)
         values ($1, $2, $3, $4, $5) returning id`,
        [t.id, regUser, regTeam, user.id, status],
      );
      regId = reg.id;
    } catch (error) {
      if (isUniqueViolation(error)) fail("already_registered");
      throw error;
    }
    try {
      for (const member of roster)
        await q.query("insert into roster_entries (registration_id, tournament_id, user_id) values ($1, $2, $3)", [regId, t.id, member]);
    } catch (error) {
      if (isUniqueViolation(error)) fail("roster_conflict");
      throw error;
    }
    await notify(q, roster, status === "registered" ? "registered" : "waitlisted", { tournament: t.name, slug: t.slug });
    await audit(q, { actorId: user.id, action: "registration.created", entity: "tournament", entityId: t.id, data: { registrationId: regId, status, teamId: regTeam } });
    return { id: regId, status };
  });
}

async function findOwnRegistration(q: Queryable, tournamentId: string, user: SessionUser) {
  const rows = await q.query<{ id: string; status: string; checked_in_at: Date | null }>(
    `select r.id, r.status, r.checked_in_at from registrations r left join teams tm on tm.id = r.team_id
      where r.tournament_id = $1 and r.status in ('registered','waitlisted')
        and (r.user_id = $2 or tm.owner_id = $2 or tm.captain_id = $2)
      for update of r`,
    [tournamentId, user.id],
  );
  return rows[0] ?? null;
}

export async function withdraw(db: Database, user: SessionUser, tournamentId: string) {
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    if (!["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status)) fail("registration_closed");
    const reg = await findOwnRegistration(q, t.id, user);
    if (!reg) fail("not_registered");
    await q.query("update registrations set status = 'withdrawn', checked_in_at = null where id = $1", [reg!.id]);
    await q.query("delete from roster_entries where registration_id = $1", [reg!.id]);
    if (reg!.status === "registered") {
      const [next] = await q.query<{ id: string }>(
        "select id from registrations where tournament_id = $1 and status = 'waitlisted' order by created_at asc limit 1 for update",
        [t.id],
      );
      if (next) {
        await q.query("update registrations set status = 'registered' where id = $1", [next.id]);
        await notify(q, await regMembers(q, next.id), "promoted", { tournament: t.name, slug: t.slug });
      }
    }
    await audit(q, { actorId: user.id, action: "registration.withdrawn", entity: "tournament", entityId: t.id, data: { registrationId: reg!.id } });
  });
}

export async function checkIn(db: Database, user: SessionUser, tournamentId: string) {
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    if (!t.check_in_open || !["REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status)) fail("check_in_closed");
    const reg = await findOwnRegistration(q, t.id, user);
    if (!reg || reg.status !== "registered") fail("not_registered");
    if (reg!.checked_in_at) return;
    await q.query("update registrations set checked_in_at = now() where id = $1", [reg!.id]);
    await audit(q, { actorId: user.id, action: "registration.checked_in", entity: "tournament", entityId: t.id, data: { registrationId: reg!.id } });
  });
}

export async function setCheckInOpen(db: Database, user: SessionUser, tournamentId: string, open: boolean) {
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (!["REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status)) fail("invalid_transition");
    await q.query("update tournaments set check_in_open = $2, updated_at = now() where id = $1", [t.id, open]);
    if (open) {
      const regs = await q.query<{ id: string }>("select id from registrations where tournament_id = $1 and status = 'registered'", [t.id]);
      const users: string[] = [];
      for (const r of regs) users.push(...(await regLeaders(q, r.id)));
      await notify(q, users, "check_in_open", { tournament: t.name, slug: t.slug });
    }
    await audit(q, { actorId: user.id, action: open ? "tournament.check_in_opened" : "tournament.check_in_closed", entity: "tournament", entityId: t.id });
  });
}

export async function organizerCheckIn(db: Database, user: SessionUser, tournamentId: string, regId: string, checked: boolean) {
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (!["REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status)) fail("invalid_transition");
    const rows = await q.query("update registrations set checked_in_at = $3 where id = $1 and tournament_id = $2 and status = 'registered' returning id", [
      regId,
      t.id,
      checked ? new Date().toISOString() : null,
    ]);
    if (!rows.length) fail("not_found");
    await audit(q, { actorId: user.id, action: "registration.check_in_override", entity: "tournament", entityId: t.id, data: { registrationId: regId, checked } });
  });
}

export async function setSeeds(db: Database, user: SessionUser, tournamentId: string, seeds: Record<string, unknown>) {
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    if (!["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status)) fail("not_editable");
    for (const [regId, raw] of Object.entries(seeds)) {
      const text = String(raw ?? "").trim();
      const seed = text === "" ? null : v.intIn(text, 1, 512);
      await q.query("update registrations set seed = $3 where id = $1 and tournament_id = $2", [regId, t.id, seed]);
    }
    await audit(q, { actorId: user.id, action: "tournament.seeds_set", entity: "tournament", entityId: t.id, data: { seeds } });
  });
}

/** Participants in the order the bracket will use: manual seeds first, then registration order. */
export async function seededParticipants(q: Queryable, tournamentId: string, checkInRequired: boolean) {
  return q.query<{ id: string; seed: number | null }>(
    `select id, seed from registrations
      where tournament_id = $1 and status = 'registered' ${checkInRequired ? "and checked_in_at is not null" : ""}
      order by seed asc nulls last, created_at asc, id asc`,
    [tournamentId],
  );
}

async function startBracket(q: Queryable, t: TournamentRow, user: SessionUser) {
  const participants = await seededParticipants(q, t.id, t.check_in_required);
  if (participants.length < 2) fail("not_enough_participants");
  if (t.check_in_required)
    await q.query(
      "update registrations set status = 'not_checked_in' where tournament_id = $1 and status = 'registered' and checked_in_at is null",
      [t.id],
    );
  for (let i = 0; i < participants.length; i++)
    await q.query("update registrations set seed = $2 where id = $1", [participants[i].id, i + 1]);
  const plan = planSingleElimination(participants.map((p) => p.id));
  const ids = new Map<string, string>();
  for (const m of plan.matches) ids.set(`${m.round}:${m.position}`, randomUUID());
  const ordered = [...plan.matches].sort((a, b) => b.round - a.round || a.position - b.position);
  for (const m of ordered) {
    const both = m.round === 1 && m.a && m.b;
    await q.query(
      `insert into matches (id, tournament_id, round, position, a_reg, b_reg, status, next_match_id, next_slot, scheduled_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        ids.get(`${m.round}:${m.position}`),
        t.id,
        m.round,
        m.position,
        m.a,
        m.b,
        both ? "ready" : "pending",
        m.next ? ids.get(`${m.next.round}:${m.next.position}`) : null,
        m.next?.slot ?? null,
        m.round === 1 ? new Date(t.starts_at).toISOString() : null,
      ],
    );
  }
  await q.query("update tournaments set started_at = now(), check_in_open = false where id = $1", [t.id]);
  // Byes: the present participant advances without a game.
  for (const m of plan.matches.filter((m) => m.round === 1 && Boolean(m.a) !== Boolean(m.b))) {
    const [row] = await q.query<MatchRow>("select * from matches where id = $1 for update", [ids.get(`1:${m.position}`)]);
    await completeMatch(q, row, { winner: (m.a ?? m.b)!, scoreA: null, scoreB: null, outcome: "bye" }, user.id);
  }
  await notify(q, await rosterUsers(q, t.id), "tournament_started", { tournament: t.name, slug: t.slug });
  const ready = await q.query<{ id: string; a_reg: string; b_reg: string }>(
    "select id, a_reg, b_reg from matches where tournament_id = $1 and status = 'ready'",
    [t.id],
  );
  for (const m of ready)
    await notify(q, [...(await regMembers(q, m.a_reg)), ...(await regMembers(q, m.b_reg))], "match_ready", { matchId: m.id, tournament: t.name });
}

type Completion = {
  winner: string;
  scoreA: number | null;
  scoreB: number | null;
  outcome: "played" | "bye" | "walkover" | "no_show" | "disqualification";
};

/** Marks a match completed and advances the winner. Idempotency is enforced by the status guard. */
export async function completeMatch(q: Queryable, match: MatchRow, c: Completion, actorId: string) {
  if (match.status === "completed") fail("already_completed");
  if (c.winner !== match.a_reg && c.winner !== match.b_reg) fail("invalid_input");
  await q.query(
    `update matches set winner_reg = $2, score_a = $3, score_b = $4, outcome = $5, status = 'completed',
       completed_at = now(), updated_at = now() where id = $1`,
    [match.id, c.winner, c.scoreA, c.scoreB, c.outcome],
  );
  await q.query(
    "update disputes set status = 'resolved', resolution = coalesce(nullif(resolution, ''), 'result_confirmed'), resolved_by = $2, resolved_at = now() where match_id = $1 and status = 'open'",
    [match.id, actorId],
  );
  await advance(q, match, c.winner, actorId);
}

async function advance(q: Queryable, match: MatchRow, winner: string, actorId: string) {
  if (!match.next_match_id) {
    await completeTournament(q, match.tournament_id);
    return;
  }
  const [next] = await q.query<MatchRow>("select * from matches where id = $1 for update", [match.next_match_id]);
  const slot = match.next_slot === "a" ? "a_reg" : "b_reg";
  if (next[slot] === winner) return;
  if (!["pending", "ready"].includes(next.status)) fail("dependent_match_played");
  await q.query(`update matches set ${slot} = $2, updated_at = now() where id = $1`, [next.id, winner]);
  const updated = { ...next, [slot]: winner } as MatchRow;
  if (updated.a_reg && updated.b_reg) {
    await q.query("update matches set status = 'ready', updated_at = now() where id = $1 and status = 'pending'", [next.id]);
    const disq = await q.query<{ id: string }>(
      "select id from registrations where id = any($1) and status = 'disqualified'",
      [[updated.a_reg, updated.b_reg]],
    );
    if (disq.length === 1) {
      const loser = disq[0].id;
      const w = loser === updated.a_reg ? updated.b_reg! : updated.a_reg!;
      await completeMatch(q, { ...updated, status: "ready" }, { winner: w, scoreA: null, scoreB: null, outcome: "disqualification" }, actorId);
      return;
    }
    const [t] = await q.query<{ name: string }>("select name from tournaments where id = $1", [match.tournament_id]);
    await notify(q, [...(await regMembers(q, updated.a_reg)), ...(await regMembers(q, updated.b_reg))], "match_ready", {
      matchId: next.id,
      tournament: t?.name,
    });
  }
}

export async function computePlacements(q: Queryable, tournamentId: string) {
  const matches = await q.query<MatchRow>(
    "select * from matches where tournament_id = $1 order by round, position",
    [tournamentId],
  );
  if (!matches.length) return;
  const rounds = Math.max(...matches.map((m) => m.round));
  await q.query("update registrations set placement = null where tournament_id = $1", [tournamentId]);
  for (const m of matches) {
    if (m.status !== "completed" || !m.winner_reg || m.outcome === "bye") continue;
    const loser = m.winner_reg === m.a_reg ? m.b_reg : m.a_reg;
    if (loser) await q.query("update registrations set placement = $2 where id = $1", [loser, placementForLoss(m.round, rounds)]);
    if (m.round === rounds) await q.query("update registrations set placement = 1 where id = $1", [m.winner_reg]);
  }
}

async function completeTournament(q: Queryable, tournamentId: string) {
  await computePlacements(q, tournamentId);
  const [t] = await q.query<{ name: string; slug: string }>(
    "update tournaments set status = 'COMPLETED', completed_at = now(), updated_at = now() where id = $1 returning name, slug",
    [tournamentId],
  );
  await notify(q, await rosterUsers(q, tournamentId), "tournament_completed", { tournament: t?.name, slug: t?.slug });
  await audit(q, { actorId: null, action: "tournament.completed", entity: "tournament", entityId: tournamentId });
}

export async function disqualify(db: Database, user: SessionUser, tournamentId: string, regId: string, reasonInput: unknown) {
  const reason = v.oneLine(reasonInput, 300);
  if (!reason) fail("invalid_input");
  await db.tx(async (q) => {
    const t = await lockTournament(q, tournamentId);
    await requireManager(q, t, user);
    const [reg] = await q.query<{ id: string; status: string }>(
      "select id, status from registrations where id = $1 and tournament_id = $2 for update",
      [regId, t.id],
    );
    if (!reg || !["registered", "waitlisted"].includes(reg.status)) fail("not_found");
    await q.query("update registrations set status = 'disqualified' where id = $1", [reg.id]);
    if (t.status === "IN_PROGRESS" || t.status === "PAUSED") {
      const [open] = await q.query<MatchRow>(
        `select * from matches where tournament_id = $1 and (a_reg = $2 or b_reg = $2)
           and status in ('ready','in_progress','result_submitted','disputed') for update`,
        [t.id, reg.id],
      );
      if (open) {
        const winner = open.a_reg === reg.id ? open.b_reg! : open.a_reg!;
        await q.query("update match_results set status = 'superseded' where match_id = $1 and status = 'pending'", [open.id]);
        await completeMatch(q, open, { winner, scoreA: null, scoreB: null, outcome: "disqualification" }, user.id);
      }
    }
    await notify(q, await regMembers(q, reg.id), "disqualified", { tournament: t.name, slug: t.slug, reason });
    await audit(q, { actorId: user.id, action: "registration.disqualified", entity: "tournament", entityId: t.id, data: { registrationId: reg.id, reason } });
  });
}

export { canReferee };
