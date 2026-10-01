/**
 * FFA lobbies on the database: rounds, lobbies, games, results with versions, disputes, advancement and final
 * places. The rules live in ffa.ts (version MV-FFA-1).
 *
 * Integrity rules:
 *  - Every write locks the tournament row first (the same order as match actions), so the last game of a
 *    round creates the next round exactly once.
 *  - A result is entered by staff for the whole lobby; a correction is a new version with a reason, and every
 *    version is kept. A disputed game is resolved by upholding it or by recording a corrected version.
 *  - The next round waits for open disputes about the current one; once it exists, the results of earlier
 *    rounds are final (stage_locked). Results of the final round can be corrected after completion: places
 *    and the champion award are re-settled (a new champion is paid, nothing is clawed back).
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { grantXp, XP } from "./progression.ts";
import {
  dealLobbies,
  ffaPlaces,
  ffaSettingsOf,
  FFA_MAX_ROUNDS,
  FFA_VERSION,
  lobbyTable,
  nextRoundSeeds,
  validateGame,
  type FfaGame,
  type FfaRow,
  type GameLine,
} from "./ffa.ts";
import { canRefereeTournament, completeTournament, lockTournament, regLeaders, regMembers, type TournamentRow } from "./tournaments.ts";
import * as v from "./validate.ts";

type StartRow = Pick<TournamentRow, "id" | "name" | "slug" | "format_settings" | "starts_at" | "org_id">;

async function rosterOf(q: Queryable, tournamentId: string) {
  const rows = await q.query<{ user_id: string }>(
    "select re.user_id from roster_entries re join registrations r on r.id = re.registration_id where re.tournament_id = $1 and r.status = 'registered'",
    [tournamentId],
  );
  return rows.map((r) => r.user_id);
}

/** When the lobbies of round r start: the start plus (r − 1) × the interval; without one, only round 1 is dated. */
function lobbyTime(t: StartRow, round: number, hours: number): string | null {
  const start = new Date(t.starts_at).getTime();
  if (hours > 0) return new Date(Math.max(round === 1 ? start : Date.now(), start + (round - 1) * hours * 3_600_000)).toISOString();
  return round === 1 ? new Date(start).toISOString() : null;
}

/** Creates the lobbies of a round from the entrants in seed order, with their games. */
async function createRound(q: Queryable, t: StartRow, round: number, seeded: string[], actorId: string) {
  const s = ffaSettingsOf(t);
  const lobbies = dealLobbies(seeded, s.lobbySize);
  const seedOf = new Map(seeded.map((id, i) => [id, i + 1]));
  const at = lobbyTime(t, round, s.roundHours);
  for (let i = 0; i < lobbies.length; i++) {
    const [lobby] = await q.query<{ id: string }>(
      "insert into ffa_lobbies (tournament_id, round, lobby_no, scheduled_at) values ($1, $2, $3, $4) returning id",
      [t.id, round, i + 1, at],
    );
    for (const reg of lobbies[i])
      await q.query("insert into ffa_entries (lobby_id, tournament_id, round, registration_id, seed) values ($1, $2, $3, $4, $5)", [lobby.id, t.id, round, reg, seedOf.get(reg)]);
    for (let g = 1; g <= s.games; g++) await q.query("insert into ffa_games (lobby_id, tournament_id, game_no) values ($1, $2, $3)", [lobby.id, t.id, g]);
    for (const reg of lobbies[i]) await notify(q, await regMembers(q, reg), "ffa_lobby", { tournament: t.name, slug: t.slug, lobbyId: lobby.id, round: String(round) });
  }
  await audit(q, {
    actorId,
    action: "tournament.ffa_round_created",
    entity: "tournament",
    entityId: t.id,
    data: { round, entrants: seeded.length, lobbies: lobbies.length, sizes: lobbies.map((l) => l.length), version: FFA_VERSION },
  });
}

export async function startFfa(q: Queryable, t: StartRow, participants: Array<{ id: string }>, actorId: string) {
  await q.query("update tournaments set started_at = now(), check_in_open = false where id = $1", [t.id]);
  await notify(q, await rosterOf(q, t.id), "tournament_started", { tournament: t.name, slug: t.slug });
  await audit(q, {
    actorId,
    action: "tournament.ffa_started",
    entity: "tournament",
    entityId: t.id,
    data: { entrants: participants.length, settings: { ...ffaSettingsOf(t) } },
  });
  await createRound(q, t, 1, participants.map((p) => p.id), actorId);
}

/** Rebuilds round 1 of an event without any result (safe regeneration). The caller checked the state. */
export async function regenerateFfa(q: Queryable, t: StartRow, participants: Array<{ id: string }>, actorId: string) {
  await q.query("delete from ffa_lobbies where tournament_id = $1", [t.id]);
  await createRound(q, t, 1, participants.map((p) => p.id), actorId);
  return { lobbies: (await q.query<{ n: number }>("select count(*)::int as n from ffa_lobbies where tournament_id = $1", [t.id]))[0]?.n ?? 0 };
}

/** Results recorded or disputed in an FFA event: anything a regeneration would discard. */
export async function ffaActivity(q: Queryable, tournamentId: string) {
  const [row] = await q.query<{ n: number }>(
    `select (select count(*)::int from ffa_games where tournament_id = $1 and status = 'completed')
          + (select count(*)::int from ffa_disputes d join ffa_games g on g.id = d.game_id where g.tournament_id = $1) as n`,
    [tournamentId],
  );
  return row?.n ?? 0;
}

const latestRound = async (q: Queryable, tournamentId: string) =>
  (await q.query<{ round: number }>("select coalesce(max(round), 0)::int as round from ffa_lobbies where tournament_id = $1", [tournamentId]))[0]?.round ?? 0;

type LockedGame = { id: string; lobby_id: string; game_no: number; status: string; version: number; round: number; lobby_no: number };

/** Locks the tournament, then the game (the same order as every other writer). */
async function lockGame(q: Queryable, gameId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(gameId)) fail("not_found");
  const [ref] = await q.query<{ tournament_id: string }>("select tournament_id from ffa_games where id = $1", [gameId]);
  if (!ref) fail("not_found");
  const t = await lockTournament(q, ref.tournament_id);
  const [g] = await q.query<LockedGame>(
    `select g.id, g.lobby_id, g.game_no, g.status, g.version, l.round, l.lobby_no
       from ffa_games g join ffa_lobbies l on l.id = g.lobby_id where g.id = $1 for update of g`,
    [gameId],
  );
  if (!g) fail("not_found");
  return { t, g };
}

export type GameInput = { lines: Array<{ reg: string; placement: unknown; kills: unknown }>; evidenceUrl?: unknown; note?: unknown };

/**
 * Records the result of a lobby game (version 1) or corrects it (a new version with a reason). Staff only.
 * Completing the last game of a round moves the event on: the next round, or the final places.
 */
export async function recordGame(db: Database, user: SessionUser, gameId: string, input: GameInput) {
  const note = v.clean(input.note, 1000);
  const evidence = v.optionalUrl(input.evidenceUrl);
  await db.tx(async (q) => {
    const { t, g } = await lockGame(q, gameId);
    if (!(await canRefereeTournament(q, t, user))) fail("forbidden");
    const first = g.status !== "completed";
    if (first ? t.status !== "IN_PROGRESS" : !["IN_PROGRESS", "PAUSED", "COMPLETED"].includes(t.status)) fail("tournament_not_live");
    if (g.round < (await latestRound(q, t.id))) fail("stage_locked");
    if (!first && note.length < 5) fail("invalid_input");
    const entrants = (await q.query<{ registration_id: string }>("select registration_id from ffa_entries where lobby_id = $1", [g.lobby_id])).map((r) => r.registration_id);
    const lines = validateGame(entrants, input.lines);
    const before = await q.query<GameLine>("select registration_id as reg, placement, kills from ffa_results where game_id = $1", [g.id]);
    await q.query("delete from ffa_results where game_id = $1", [g.id]);
    for (const l of lines) await q.query("insert into ffa_results (game_id, registration_id, placement, kills) values ($1, $2, $3, $4)", [g.id, l.reg, l.placement, l.kills]);
    const version = g.version + 1;
    await q.query("insert into ffa_result_versions (game_id, version, results, note, evidence_url, decided_by) values ($1, $2, $3, $4, $5, $6)", [
      g.id,
      version,
      JSON.stringify(lines),
      note,
      evidence,
      user.id,
    ]);
    await q.query(
      "update ffa_games set status = 'completed', version = $2, evidence_url = $3, decided_by = $4, completed_at = coalesce(completed_at, now()) where id = $1",
      [g.id, version, evidence, user.id],
    );
    // XP: the game winner earns a win, everyone else who played earns a played game; idempotent per game and entrant.
    const [meta] = await q.query<{ game: string }>("select game from tournaments where id = $1", [t.id]);
    for (const l of lines) {
      const members = await regMembers(q, l.reg);
      if (l.placement === 1) await grantXp(q, members, XP.matchWin, "match_win", meta?.game ?? "", g.id, `ffa:${g.id}:${l.reg}:win`);
      else if (first) await grantXp(q, members, XP.matchPlayed, "match_played", meta?.game ?? "", g.id, `ffa:${g.id}:${l.reg}:played`);
    }
    if (!first)
      await q.query(
        "update ffa_disputes set status = 'resolved', decision = 'corrected', resolution = $2, resolved_by = $3, resolved_at = now() where game_id = $1 and status = 'open'",
        [g.id, note, user.id],
      );
    const told = new Set<string>();
    for (const reg of entrants) for (const id of await regMembers(q, reg)) told.add(id);
    await notify(q, [...told], first ? "ffa_result" : "ffa_result_corrected", { tournament: t.name, slug: t.slug, lobbyId: g.lobby_id, game: String(g.game_no) });
    await audit(q, {
      actorId: user.id,
      action: first ? "ffa.game_recorded" : "ffa.game_corrected",
      entity: "tournament",
      entityId: t.id,
      data: { gameId: g.id, lobbyId: g.lobby_id, round: g.round, game: g.game_no, version, results: lines, ...(first ? {} : { before, note }) },
    });
    if (t.status === "COMPLETED") await completeTournament(q, t.id);
    else await afterFfaGame(q, t.id, user.id);
  });
}

/**
 * After a game result or a decided dispute: closes finished lobbies and, when the whole round is finished and
 * no dispute about it is open, starts the next round or completes the event.
 */
export async function afterFfaGame(q: Queryable, tournamentId: string, actorId: string) {
  const [t] = await q.query<TournamentRow>("select * from tournaments where id = $1", [tournamentId]);
  if (!t || t.format !== "ffa" || !["IN_PROGRESS", "PAUSED"].includes(t.status)) return;
  const round = await latestRound(q, t.id);
  await q.query(
    `update ffa_lobbies l set status = 'completed' where l.tournament_id = $1 and l.round = $2 and l.status = 'open'
        and not exists (select 1 from ffa_games g where g.lobby_id = l.id and g.status <> 'completed')`,
    [t.id, round],
  );
  const [state] = await q.query<{ open: number; disputes: number }>(
    `select (select count(*)::int from ffa_lobbies where tournament_id = $1 and round = $2 and status = 'open') as open,
            (select count(*)::int from ffa_disputes d join ffa_games g on g.id = d.game_id join ffa_lobbies l on l.id = g.lobby_id
              where l.tournament_id = $1 and l.round = $2 and d.status = 'open') as disputes`,
    [t.id, round],
  );
  if ((state?.open ?? 1) > 0 || (state?.disputes ?? 0) > 0) return;
  const tables = await roundTables(q, t, round);
  if (tables.length === 1) {
    await completeTournament(q, t.id);
    return;
  }
  const seeds = nextRoundSeeds(tables.map((l) => l.rows), ffaSettingsOf(t).advance);
  if (seeds.length < 2 || round >= FFA_MAX_ROUNDS) {
    await audit(q, { actorId, action: "tournament.ffa_ended_early", entity: "tournament", entityId: t.id, data: { round, qualifiers: seeds.length } });
    await completeTournament(q, t.id);
    return;
  }
  const advanced = new Set(seeds);
  for (const lobby of tables)
    for (const row of lobby.rows)
      if (!row.disqualified)
        await notify(q, await regMembers(q, row.id), advanced.has(row.id) ? "ffa_advanced" : "ffa_eliminated", { tournament: t.name, slug: t.slug, round: String(round + 1) });
  await createRound(q, t, round + 1, seeds, actorId);
}

export type LobbyTable = { id: string; round: number; lobby_no: number; status: string; scheduled_at: Date | null; games_done: number; games_total: number; rows: FfaRow[] };

/** Tables of the lobbies of one round (or of every round), in lobby order. */
export async function roundTables(q: Queryable, t: { id: string; format_settings?: unknown }, round?: number): Promise<LobbyTable[]> {
  const settings = ffaSettingsOf(t);
  const lobbies = await q.query<Omit<LobbyTable, "rows">>(
    `select l.id, l.round, l.lobby_no, l.status, l.scheduled_at,
            (select count(*)::int from ffa_games g where g.lobby_id = l.id and g.status = 'completed') as games_done,
            (select count(*)::int from ffa_games g where g.lobby_id = l.id) as games_total
       from ffa_lobbies l where l.tournament_id = $1 and ($2::int is null or l.round = $2) order by l.round, l.lobby_no`,
    [t.id, round ?? null],
  );
  if (!lobbies.length) return [];
  const ids = lobbies.map((l) => l.id);
  const [entries, games, lines] = await Promise.all([
    q.query<{ lobby_id: string; registration_id: string; seed: number; status: string }>(
      `select e.lobby_id, e.registration_id, e.seed, r.status from ffa_entries e join registrations r on r.id = e.registration_id
        where e.lobby_id = any($1) order by e.seed`,
      [ids],
    ),
    q.query<{ id: string; lobby_id: string; status: string }>("select id, lobby_id, status from ffa_games where lobby_id = any($1)", [ids]),
    q.query<{ game_id: string; registration_id: string; placement: number; kills: number }>(
      "select r.game_id, r.registration_id, r.placement, r.kills from ffa_results r join ffa_games g on g.id = r.game_id where g.lobby_id = any($1)",
      [ids],
    ),
  ]);
  return lobbies.map((l) => {
    const lobbyGames: FfaGame[] = games
      .filter((g) => g.lobby_id === l.id)
      .map((g) => ({ status: g.status, lines: lines.filter((x) => x.game_id === g.id).map((x) => ({ reg: x.registration_id, placement: x.placement, kills: x.kills })) }));
    const entrants = entries.filter((e) => e.lobby_id === l.id).map((e) => ({ id: e.registration_id, seed: e.seed, disqualified: e.status === "disqualified" }));
    return { ...l, rows: lobbyTable(entrants, lobbyGames, settings) };
  });
}

/** Final places of an FFA event. Returns false while its last round is still being played. */
export async function ffaPlacements(q: Queryable, tournamentId: string): Promise<boolean> {
  const [t] = await q.query<TournamentRow>("select * from tournaments where id = $1", [tournamentId]);
  if (!t || t.format !== "ffa") return false;
  await q.query("update registrations set placement = null where tournament_id = $1", [t.id]);
  const all = await roundTables(q, t);
  if (!all.length) return false;
  const last = Math.max(...all.map((l) => l.round));
  const lastLobbies = all.filter((l) => l.round === last);
  if (lastLobbies.some((l) => l.status !== "completed" && l.games_done < l.games_total)) return false;
  const rounds = [...new Set(all.map((l) => l.round))].sort((a, b) => a - b).map((round) => ({ round, lobbies: all.filter((l) => l.round === round).map((l) => l.rows) }));
  // A last round with several lobbies ended the event because fewer than two qualified: the qualifier wins.
  const survivors = lastLobbies.length > 1 ? nextRoundSeeds(lastLobbies.map((l) => l.rows), ffaSettingsOf(t).advance) : [];
  for (const [reg, place] of ffaPlaces(rounds, survivors)) await q.query("update registrations set placement = $2 where id = $1", [reg, place]);
  await q.query("update registrations set placement = null where tournament_id = $1 and status = 'disqualified'", [t.id]);
  return true;
}

/** Staff set a lobby's code (shown to its entrants only) and start time. */
export async function setLobbyDetails(db: Database, user: SessionUser, lobbyId: string, input: { roomCode?: unknown; scheduledAt?: unknown; timeZone?: unknown }) {
  if (!/^[0-9a-f-]{36}$/i.test(lobbyId)) fail("not_found");
  await db.tx(async (q) => {
    const [ref] = await q.query<{ tournament_id: string }>("select tournament_id from ffa_lobbies where id = $1", [lobbyId]);
    if (!ref) fail("not_found");
    const t = await lockTournament(q, ref.tournament_id);
    if (!(await canRefereeTournament(q, t, user))) fail("forbidden");
    const [lobby] = await q.query<{ id: string; status: string; round: number; lobby_no: number }>("select id, status, round, lobby_no from ffa_lobbies where id = $1 for update", [lobbyId]);
    if (lobby.status !== "open") fail("already_completed");
    const code = input.roomCode === undefined ? undefined : v.oneLine(input.roomCode, 80);
    const at = String(input.scheduledAt ?? "").trim() ? v.zonedToUtc(input.scheduledAt, input.timeZone) : undefined;
    if (code !== undefined) await q.query("update ffa_lobbies set room_code = $2 where id = $1", [lobby.id, code]);
    if (at) await q.query("update ffa_lobbies set scheduled_at = $2 where id = $1", [lobby.id, at.toISOString()]);
    const entrants = await q.query<{ registration_id: string }>("select registration_id from ffa_entries where lobby_id = $1", [lobby.id]);
    const told = new Set<string>();
    for (const e of entrants) for (const id of await regMembers(q, e.registration_id)) told.add(id);
    await notify(q, [...told], "ffa_lobby_updated", { tournament: t.name, slug: t.slug, lobbyId: lobby.id, round: String(lobby.round) });
    await audit(q, { actorId: user.id, action: "ffa.lobby_updated", entity: "tournament", entityId: t.id, data: { lobbyId: lobby.id, roomCode: code !== undefined, at: at?.toISOString() ?? null } });
  });
}

/** An entrant of the lobby disputes a recorded game while its round is still open. */
export async function fileFfaDispute(db: Database, user: SessionUser, gameId: string, input: { reason: unknown; evidenceUrl?: unknown }) {
  const reason = v.clean(input.reason, 1000);
  if (reason.length < 10) fail("invalid_input");
  const evidence = v.optionalUrl(input.evidenceUrl);
  return db.tx(async (q) => {
    const { t, g } = await lockGame(q, gameId);
    if (!["IN_PROGRESS", "PAUSED", "COMPLETED"].includes(t.status)) fail("tournament_not_live");
    if (g.status !== "completed") fail("not_editable");
    if (g.round < (await latestRound(q, t.id))) fail("stage_locked");
    const entrants = await q.query<{ registration_id: string }>("select registration_id from ffa_entries where lobby_id = $1", [g.lobby_id]);
    let mine = false;
    for (const e of entrants) if ((await regLeaders(q, e.registration_id)).includes(user.id)) mine = true;
    if (!mine) fail("not_participant");
    let id: string;
    try {
      const [row] = await q.query<{ id: string }>("insert into ffa_disputes (game_id, opened_by, reason, evidence_url) values ($1, $2, $3, $4) returning id", [g.id, user.id, reason, evidence]);
      id = row.id;
    } catch (error) {
      if (isUniqueViolation(error)) fail("dispute_exists");
      throw error;
    }
    const staff = await q.query<{ user_id: string }>(
      "select user_id from org_members where org_id = $1 union select user_id from tournament_organizers where tournament_id = $2",
      [t.org_id, t.id],
    );
    await notify(q, staff.map((s) => s.user_id), "ffa_dispute_opened", { tournament: t.name, slug: t.slug, lobbyId: g.lobby_id, game: String(g.game_no) });
    await audit(q, { actorId: user.id, action: "ffa.dispute_filed", entity: "tournament", entityId: t.id, data: { disputeId: id, gameId: g.id, lobbyId: g.lobby_id } });
    return id;
  });
}

/** Staff keep a disputed result as it is. (A corrected version resolves the dispute as "corrected".) */
export async function upholdFfaDispute(db: Database, user: SessionUser, disputeId: string, noteInput: unknown) {
  const note = v.clean(noteInput, 1000);
  if (note.length < 5) fail("invalid_input");
  if (!/^[0-9a-f-]{36}$/i.test(disputeId)) fail("not_found");
  await db.tx(async (q) => {
    const [d] = await q.query<{ id: string; game_id: string; opened_by: string; status: string }>("select id, game_id, opened_by, status from ffa_disputes where id = $1", [disputeId]);
    if (!d) fail("not_found");
    const { t, g } = await lockGame(q, d.game_id);
    if (!(await canRefereeTournament(q, t, user))) fail("forbidden");
    const [fresh] = await q.query<{ status: string }>("select status from ffa_disputes where id = $1 for update", [d.id]);
    if (fresh.status !== "open") fail("already_completed");
    await q.query("update ffa_disputes set status = 'resolved', decision = 'upheld', resolution = $2, resolved_by = $3, resolved_at = now() where id = $1", [d.id, note, user.id]);
    await notify(q, [d.opened_by], "dispute_upheld", { tournament: t.name, slug: t.slug, lobbyId: g.lobby_id });
    await audit(q, { actorId: user.id, action: "ffa.dispute_upheld", entity: "tournament", entityId: t.id, data: { disputeId: d.id, gameId: g.id, note } });
    // The round may have been waiting for this decision.
    await afterFfaGame(q, t.id, user.id);
  });
}

export type LobbyGame = {
  id: string;
  game_no: number;
  status: string;
  version: number;
  evidence_url: string;
  completed_at: Date | null;
  lines: Array<{ registration_id: string; placement: number; kills: number }>;
};

/** Everything the lobby page shows. Room codes are returned only to callers allowed to see them. */
export async function lobbyDetail(q: Queryable, lobbyId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(lobbyId)) return null;
  const [lobby] = await q.query<{
    id: string;
    tournament_id: string;
    round: number;
    lobby_no: number;
    status: string;
    room_code: string;
    scheduled_at: Date | null;
    t_slug: string;
    t_name: string;
    t_status: string;
    t_game: string;
    t_settings: unknown;
    org_id: string;
    rounds: number;
    lobbies: number;
  }>(
    `select l.*, t.slug as t_slug, t.name as t_name, t.status as t_status, t.game as t_game, t.format_settings as t_settings, t.org_id,
            (select max(round) from ffa_lobbies x where x.tournament_id = l.tournament_id)::int as rounds,
            (select count(*) from ffa_lobbies x where x.tournament_id = l.tournament_id and x.round = l.round)::int as lobbies
       from ffa_lobbies l join tournaments t on t.id = l.tournament_id where l.id = $1`,
    [lobbyId],
  );
  if (!lobby) return null;
  const [games, lines, disputes, table] = await Promise.all([
    q.query<Omit<LobbyGame, "lines">>("select id, game_no, status, version, evidence_url, completed_at from ffa_games where lobby_id = $1 order by game_no", [lobbyId]),
    q.query<{ game_id: string; registration_id: string; placement: number; kills: number }>(
      "select r.game_id, r.registration_id, r.placement, r.kills from ffa_results r join ffa_games g on g.id = r.game_id where g.lobby_id = $1 order by r.placement",
      [lobbyId],
    ),
    q.query<{ id: string; game_id: string; reason: string; evidence_url: string; status: string; decision: string | null; resolution: string; created_at: Date; opened_by: string }>(
      `select d.id, d.game_id, d.reason, d.evidence_url, d.status, d.decision, d.resolution, d.created_at, u.username as opened_by
         from ffa_disputes d join users u on u.id = d.opened_by join ffa_games g on g.id = d.game_id where g.lobby_id = $1 order by d.created_at desc`,
      [lobbyId],
    ),
    roundTables(q, { id: lobby.tournament_id, format_settings: lobby.t_settings }, lobby.round),
  ]);
  return {
    lobby,
    games: games.map((g) => ({ ...g, lines: lines.filter((l) => l.game_id === g.id) })),
    disputes,
    rows: table.find((l) => l.id === lobbyId)?.rows ?? [],
  };
}
