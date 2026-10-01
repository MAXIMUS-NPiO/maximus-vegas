import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { deleteAccount, exportAccount, signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg, createTeam } from "../src/server/teams.ts";
import {
  approveRegistration,
  cloneTournament,
  createTournament,
  disqualify,
  regenerateMatches,
  register,
  rejectRegistration,
  transition,
  updateTournament,
  withdraw,
  type TournamentInput,
} from "../src/server/tournaments.ts";
import { markNoShow, officialResult } from "../src/server/matches.ts";
import { rosterHistory, setRoster, substitute } from "../src/server/rosters.ts";
import { createFromTemplate, deleteTemplate, listTemplates, saveTemplate } from "../src/server/templates.ts";
import { reschedule } from "../src/server/schedule.ts";
import { fileFfaDispute, recordGame, roundTables, setLobbyDetails, upholdFfaDispute } from "../src/server/lobbies.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
let seq = 0;

async function mk(name: string): Promise<SessionUser> {
  const s = await signUp(db, { email: `${name}@example.com`, username: name, displayName: name.toUpperCase(), password: "correct horse battery", adult: "on", terms: "on" });
  return (await sessionUser(db, s.token))!;
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}

const base = (over: Partial<TournamentInput> = {}): TournamentInput => ({
  name: `Release5 ${++seq}`,
  game: "cs2",
  participantType: "solo",
  teamSize: 1,
  maxParticipants: 16,
  checkInRequired: "",
  region: "",
  startsAt: "2030-01-01T12:00",
  timeZone: "UTC",
  description: "",
  rules: "",
  ...over,
});

let owner: SessionUser;
let admin: SessionUser;
let orgId: string;

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  owner = await mk("r5owner");
  admin = await mk("r5admin");
  await db.query("insert into user_roles (user_id, role) values ($1, 'admin')", [admin.id]);
  admin = { ...admin, roles: ["admin"] };
  orgId = (await createOrg(db, owner, { name: "Release Five", description: "" })).id;
});
test.after(async () => {
  await db.close();
});

const regsOf = (tid: string) =>
  db.query<{ id: string; user_id: string | null; team_id: string | null; status: string; placement: number | null; seed: number | null; answers: Record<string, unknown> | null; decision_note: string }>(
    "select id, user_id, team_id, status, placement, seed, answers, decision_note from registrations where tournament_id = $1 order by created_at",
    [tid],
  );
const notes = (userId: string, kind: string) =>
  db.query<{ data: Record<string, string> }>("select data from notifications where user_id = $1 and kind = $2", [userId, kind]);
const open = async (input: Partial<TournamentInput>) => {
  const t = await createTournament(db, owner, orgId, base(input));
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  return t;
};

test("registration with approval, answers and a deadline: pending, approved, waitlisted, rejected and re-applied, expired at the start", async () => {
  const t = await open({
    maxParticipants: 2,
    registration: {
      approvalRequired: "on",
      fields: { field1Label: "Discord", field1Type: "text", field1Required: "on", field2Label: "Region", field2Type: "choice", field2Options: "EU, MENA" },
    },
  });
  const [a, b, c, d] = await Promise.all(["ra", "rb", "rc", "rd"].map((n) => mk(`${n}${seq}`)));
  await rejects(register(db, a, t.id, undefined, {}), "invalid_answers");
  await rejects(register(db, a, t.id, undefined, { answer_f1: "a#1", answer_f2: "Mars" }), "invalid_answers");
  const ra = await register(db, a, t.id, undefined, { answer_f1: "a#1", answer_f2: "MENA" });
  assert.equal(ra.status, "pending", "with approval an application waits");
  assert.equal((await notes(a.id, "registration_received")).length, 1);
  assert.equal((await notes(owner.id, "registration_pending")).length, 1, "the organiser is told");
  const rb = await register(db, b, t.id, undefined, { answer_f1: "b#2" });
  const rc = await register(db, c, t.id, undefined, { answer_f1: "c#3" });
  const rd = await register(db, d, t.id, undefined, { answer_f1: "d#4" });
  const stored = (await regsOf(t.id)).find((r) => r.id === ra.id)!;
  assert.deepEqual(stored.answers, { f1: "a#1", f2: "MENA" });
  // Questions are frozen once anyone applied.
  await rejects(
    updateTournament(db, owner, t.id, base({ name: "Renamed", maxParticipants: 2, registration: { approvalRequired: "on", fields: { field1Label: "Steam", field1Type: "text" } } })),
    "not_editable",
  );
  // Saving the form with the same questions and other changes is allowed (stored JSON compares equal).
  await updateTournament(
    db,
    owner,
    t.id,
    base({
      name: "Renamed",
      maxParticipants: 2,
      registration: {
        approvalRequired: "on",
        fields: { field1Label: "Discord", field1Type: "text", field1Required: "on", field2Label: "Region", field2Type: "choice", field2Options: "EU, MENA" },
      },
    }),
  );
  // Only managers decide; capacity applies at approval.
  await rejects(approveRegistration(db, a, t.id, ra.id), "forbidden");
  assert.equal(await approveRegistration(db, owner, t.id, ra.id), "registered");
  assert.equal(await approveRegistration(db, owner, t.id, rb.id), "registered");
  assert.equal(await approveRegistration(db, owner, t.id, rc.id), "waitlisted", "full: approved into the waitlist");
  await rejects(approveRegistration(db, owner, t.id, rc.id), "not_found");
  await rejects(rejectRegistration(db, owner, t.id, rd.id, "no"), "invalid_input");
  await rejectRegistration(db, owner, t.id, rd.id, "Region not supported");
  assert.equal((await notes(d.id, "registration_rejected"))[0].data.reason, "Region not supported");
  assert.equal((await db.query("select 1 from roster_entries where registration_id = $1", [rd.id])).length, 0, "the roster is released");
  // A rejected applicant may apply again; that application is not decided before the start and expires.
  const again = await register(db, d, t.id, undefined, { answer_f1: "d#4" });
  assert.equal(again.status, "pending");
  // Withdrawing frees a place: the waitlisted entrant moves up.
  await withdraw(db, b, t.id);
  assert.equal((await regsOf(t.id)).find((r) => r.id === rc.id)!.status, "registered");
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const after = (await regsOf(t.id)).find((r) => r.id === again.id)!;
  assert.deepEqual([after.status, after.decision_note], ["rejected", "expired"]);
  assert.equal((await notes(d.id, "registration_expired")).length, 1);
  // The applicant's export carries their answers; deleting the account erases them.
  const exported = await exportAccount(db, a);
  assert.deepEqual((exported.registrations as Array<{ answers: unknown }>).find((r) => r.answers)?.answers, { f1: "a#1", f2: "MENA" });
  await deleteAccount(db, a, "correct horse battery");
  assert.equal((await regsOf(t.id)).find((r) => r.id === ra.id)!.answers, null);

  // A deadline closes registration even while the status is still open.
  const late = await open({ registration: { registrationClosesAt: "2020-01-01T12:00" } });
  await rejects(register(db, b, late.id), "registration_closed");
  await rejects(createTournament(db, owner, orgId, base({ registration: { registrationClosesAt: "2031-01-01T12:00" } })), "invalid_date");
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("rosters: leaders edit until the lock, organisers substitute after it, every change is kept", async () => {
  const cap = await mk(`cap${seq}`);
  const team = await createTeam(db, cap, { name: `Roster Team ${seq}`, tag: "RT", game: "cs2" });
  const players = await Promise.all([1, 2, 3, 4, 5].map((i) => mk(`rp${seq}_${i}`)));
  for (const p of players.slice(0, 3)) await db.query("insert into team_members (team_id, user_id) values ($1, $2)", [team.id, p.id]);
  const t = await open({ participantType: "team", teamSize: 2, maxParticipants: 4 });
  const reg = await register(db, cap, t.id, team.id);
  const roster = async () => (await db.query<{ user_id: string }>("select user_id from roster_entries where registration_id = $1", [reg.id])).map((r) => r.user_id).sort();
  assert.equal((await roster()).length, 4, "registration captures the current line-up");
  await rejects(setRoster(db, players[0], t.id, reg.id, [cap.id, players[0].id]), "not_team_leader");
  await rejects(setRoster(db, cap, t.id, reg.id, [cap.id]), "invalid_roster");
  await rejects(setRoster(db, cap, t.id, reg.id, [cap.id, players[4].id]), "invalid_roster");
  await setRoster(db, cap, t.id, reg.id, [cap.id, players[1].id]);
  assert.deepEqual(await roster(), [cap.id, players[1].id].sort());
  const history = await rosterHistory(db, reg.id);
  assert.equal(history.filter((h) => h.kind === "edit").length, 2, "two players left the roster");
  // A second team cannot take a player who is on this roster.
  const cap2 = await mk(`capb${seq}`);
  const team2 = await createTeam(db, cap2, { name: `Second Team ${seq}`, tag: "ST", game: "cs2" });
  await db.query("insert into team_members (team_id, user_id) values ($1, $2)", [team2.id, players[1].id]);
  await db.query("insert into team_members (team_id, user_id) values ($1, $2)", [team2.id, players[3].id]);
  await rejects(register(db, cap2, t.id, team2.id), "roster_conflict");
  // The lock: after the start leaders cannot edit; the organiser substitutes with a reason.
  await db.query("insert into team_members (team_id, user_id) values ($1, $2)", [team.id, players[3].id]);
  const cap3 = await mk(`capc${seq}`);
  const team3 = await createTeam(db, cap3, { name: `Third Team ${seq}`, tag: "TT", game: "cs2" });
  await db.query("insert into team_members (team_id, user_id) values ($1, $2)", [team3.id, players[4].id]);
  await register(db, cap3, t.id, team3.id);
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  await rejects(setRoster(db, cap, t.id, reg.id, [cap.id, players[0].id]), "roster_locked");
  await rejects(substitute(db, cap, t.id, reg.id, players[1].id, players[0].id, "Injury in practice"), "forbidden");
  await rejects(substitute(db, owner, t.id, reg.id, players[1].id, players[4].id, "Not a member"), "invalid_roster");
  await substitute(db, owner, t.id, reg.id, players[1].id, players[0].id, "Injury in practice");
  assert.deepEqual(await roster(), [cap.id, players[0].id].sort());
  const sub = (await rosterHistory(db, reg.id))[0];
  assert.deepEqual([sub.kind, sub.reason], ["substitution", "Injury in practice"]);
  assert.equal((await notes(players[0].id, "roster_substitution")).length, 1);
  // The substitute plays and earns the match XP from now on.
  const [m] = await db.query<{ id: string; a_reg: string }>("select id, a_reg from matches where tournament_id = $1 and status = 'ready'", [t.id]);
  await officialResult(db, owner, m.id, { scoreA: m.a_reg === reg.id ? 2 : 0, scoreB: m.a_reg === reg.id ? 0 : 2, evidenceUrl: "", note: "" });
  const [xp] = await db.query<{ n: number }>("select count(*)::int as n from xp_events where user_id = $1 and ref = $2", [players[0].id, m.id]);
  assert.equal(xp.n, 1);
  // A lock time before the start stops leader edits too.
  const locked = await open({ participantType: "team", teamSize: 2, registration: { rosterLocksAt: "2020-01-01T12:00" } });
  const reg2 = await register(db, cap2, locked.id, team2.id);
  await rejects(setRoster(db, cap2, locked.id, reg2.id, [cap2.id, players[3].id]), "roster_locked");
});

test("templates: saved from a tournament, drafts created with its settings and shifted deadlines, real statistics", async () => {
  const src = await createTournament(
    db,
    owner,
    orgId,
    base({
      name: "Weekly Cup",
      format: "groups",
      settings: { groupCount: "2", groupAdvance: "1", playoffFormat: "single_elimination", roundHours: "2" },
      registration: { approvalRequired: "on", registrationClosesAt: "2029-12-31T12:00", noShowMinutes: "10", fields: { field1Label: "Discord", field1Type: "text" } },
    }),
  );
  await saveTemplate(db, owner, src.id, { name: "Weekly", category: "Cups" });
  await rejects(saveTemplate(db, await mk(`stranger${seq}`), src.id, { name: "Other", category: "" }), "forbidden");
  await rejects(saveTemplate(db, owner, src.id, { name: "weekly", category: "Cups" }), "template_exists");
  const [tpl] = await listTemplates(db, orgId);
  assert.deepEqual([tpl.name, tpl.category, tpl.format, tpl.created, tpl.completed, tpl.avg_entrants], ["Weekly", "Cups", "groups", 0, 0, null]);
  const draft = await createFromTemplate(db, owner, tpl.id, { name: "Weekly Cup #2", startsAt: "2030-02-01T12:00", timeZone: "UTC" });
  const [row] = await db.query<{ format: string; format_settings: Record<string, unknown>; approval_required: boolean; registration_closes_at: Date; no_show_minutes: number; registration_fields: unknown[]; template_id: string; status: string }>(
    "select format, format_settings, approval_required, registration_closes_at, no_show_minutes, registration_fields, template_id, status from tournaments where id = $1",
    [draft.id],
  );
  assert.equal(row.status, "DRAFT");
  assert.equal(row.format, "groups");
  assert.deepEqual(row.format_settings.groups, { count: 2, advance: 1 });
  assert.equal(row.approval_required, true);
  assert.equal(row.no_show_minutes, 10);
  assert.equal(row.registration_fields.length, 1);
  assert.equal(new Date(row.registration_closes_at).toISOString(), "2030-01-31T12:00:00.000Z", "the deadline keeps its distance to the start");
  assert.equal(row.template_id, tpl.id);
  assert.equal((await listTemplates(db, orgId))[0].created, 1);
  await deleteTemplate(db, owner, tpl.id);
  assert.equal((await listTemplates(db, orgId)).length, 0);
  const [unlinked] = await db.query<{ template_id: string | null }>("select template_id from tournaments where id = $1", [draft.id]);
  assert.equal(unlinked.template_id, null, "deleting a template keeps its tournaments");
});

test("schedule and no-show policy: a round moved at once, everything shifted, no-shows only after the grace period", async () => {
  const t = await open({ format: "round_robin", registration: { noShowMinutes: "15" } });
  const ps = await Promise.all([1, 2, 3, 4].map((i) => mk(`sc${seq}_${i}`)));
  for (const p of ps) await register(db, p, t.id);
  await rejects(reschedule(db, owner, t.id, { round: "1:RR:2", shiftMinutes: "30" }), "tournament_not_live");
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const moved = await reschedule(db, owner, t.id, { round: "1:RR:2", at: "2030-01-02T18:00", timeZone: "UTC" });
  assert.equal(moved, 2);
  const r2 = await db.query<{ scheduled_at: Date }>("select scheduled_at from matches where tournament_id = $1 and round = 2", [t.id]);
  assert.ok(r2.every((m) => new Date(m.scheduled_at).toISOString() === "2030-01-02T18:00:00.000Z"));
  const shifted = await reschedule(db, owner, t.id, { round: "all", shiftMinutes: "-60" });
  assert.equal(shifted, 4, "rounds 1 and 2 have times; round 3 has none");
  const [first] = await db.query<{ id: string; scheduled_at: Date }>("select id, scheduled_at from matches where tournament_id = $1 and round = 1 order by position limit 1", [t.id]);
  assert.equal(new Date(first.scheduled_at).toISOString(), "2030-01-01T11:00:00.000Z");
  await rejects(reschedule(db, ps[0], t.id, { round: "all", shiftMinutes: "10" }), "forbidden");
  await rejects(reschedule(db, owner, t.id, { round: "all", at: "2030-01-02T18:00", timeZone: "UTC" }), "invalid_input");
  // The match is scheduled in the future: the absent side still has its grace period.
  await rejects(markNoShow(db, owner, first.id, "a"), "no_show_too_early");
  await db.query("update matches set scheduled_at = now() - interval '20 minutes' where id = $1", [first.id]);
  await markNoShow(db, owner, first.id, "a");
  const [done] = await db.query<{ outcome: string }>("select outcome from matches where id = $1", [first.id]);
  assert.equal(done.outcome, "no_show");
});

const ffaBase = (over: Partial<TournamentInput> = {}) => base({ format: "ffa", game: "pubg", ...over });

async function ffaEvent(n: number, settings: Record<string, string>) {
  const t = await open(ffaBase({ maxParticipants: 64, settings }));
  const players = await Promise.all(Array.from({ length: n }, (_, i) => mk(`ff${seq}_${i}`)));
  for (const p of players) await register(db, p, t.id);
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const seeds = new Map((await regsOf(t.id)).map((r) => [r.id, r.seed!]));
  return { t, players, seeds };
}

type G = { id: string; lobby_id: string; game_no: number; status: string; round: number };
const gamesOf = (tid: string) =>
  db.query<G>("select g.id, g.lobby_id, g.game_no, g.status, l.round from ffa_games g join ffa_lobbies l on l.id = g.lobby_id where g.tournament_id = $1 order by l.round, l.lobby_no, g.game_no", [tid]);
const entrantsOf = async (lobbyId: string) => (await db.query<{ registration_id: string }>("select registration_id from ffa_entries where lobby_id = $1", [lobbyId])).map((r) => r.registration_id);

/** Records a game where entrants finish in seed order (better seed, better place), kills = 10 − place. */
async function playGame(g: G, seeds: Map<string, number>, user = owner, order?: (ids: string[]) => string[]) {
  const ids = (await entrantsOf(g.lobby_id)).sort((a, b) => seeds.get(a)! - seeds.get(b)!);
  const ranked = order ? order(ids) : ids;
  await recordGame(db, user, g.id, { lines: ranked.map((reg, i) => ({ reg, placement: String(i + 1), kills: String(Math.max(0, 10 - i)) })) });
}

test("ffa: one lobby, games scored by place and kills, the table decides the places, XP per game", async () => {
  await rejects(createTournament(db, owner, orgId, ffaBase({ maxParticipants: 120, settings: { lobbySize: "10", ffaAdvance: "9" } })), "invalid_ffa_settings");
  const { t, players, seeds } = await ffaEvent(6, { lobbySize: "8", ffaGames: "2", ffaPoints: "10, 6, 5, 4, 3, 2", killPoints: "1" });
  const games = await gamesOf(t.id);
  assert.equal(games.length, 2, "one lobby of six, two games");
  await rejects(recordGame(db, players[0], games[0].id, { lines: [] }), "forbidden");
  const ids = (await entrantsOf(games[0].lobby_id)).sort((a, b) => seeds.get(a)! - seeds.get(b)!);
  await rejects(recordGame(db, owner, games[0].id, { lines: ids.map((reg) => ({ reg, placement: "1", kills: "0" })) }), "invalid_ffa_results");
  await playGame(games[0], seeds);
  // Game 2: the last seed wins.
  await playGame(games[1], seeds, owner, (list) => [list[5], ...list.slice(0, 5)]);
  const [row] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
  assert.equal(row.status, "COMPLETED");
  const regs = await regsOf(t.id);
  const bySeed = Object.fromEntries(regs.map((r) => [r.seed, r.placement]));
  // Seed 1: 10 + 10 kills + 6 + 9 kills = 35; seed 6: 2 + 5 + 10 + 10 = 27; seed 2: 6 + 9 + 5 + 8 = 28.
  assert.deepEqual(bySeed, { 1: 1, 2: 2, 6: 3, 3: 4, 4: 5, 5: 6 });
  const [xp] = await db.query<{ wins: number; played: number }>(
    `select count(*) filter (where reason = 'match_win')::int as wins, count(*) filter (where reason = 'match_played')::int as played
       from xp_events where ref = any($1)`,
    [games.map((g) => g.id)],
  );
  assert.deepEqual(xp, { wins: 2, played: 10 });
  // A correction of the final after completion needs a reason and re-settles the places.
  await rejects(recordGame(db, owner, games[1].id, { lines: ids.map((reg, i) => ({ reg, placement: String(i + 1), kills: "0" })) }), "invalid_input");
  // Corrected game 2: reversed order, and the winner (seed 6) had 20 kills: 7 + 10 + 20 = 37 points.
  await recordGame(db, owner, games[1].id, { lines: ids.map((reg, i) => ({ reg, placement: String(6 - i), kills: i === 5 ? "20" : "0" })), note: "Wrong order entered" });
  const corrected = Object.fromEntries((await regsOf(t.id)).map((r) => [r.seed, r.placement]));
  assert.deepEqual(corrected, { 6: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6 });
  const [status] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
  assert.equal(status.status, "COMPLETED", "a correction after completion keeps the event completed");
  const [versions] = await db.query<{ n: number }>("select count(*)::int as n from ffa_result_versions where game_id = $1", [games[1].id]);
  assert.equal(versions.n, 2, "both versions are kept");
});

test("ffa: lobbies advance round by round to a final; the next round waits for disputes; earlier rounds lock", async () => {
  const { t, players, seeds } = await ffaEvent(20, { lobbySize: "8", ffaGames: "1", ffaAdvance: "3" });
  let games = await gamesOf(t.id);
  assert.equal(new Set(games.map((g) => g.lobby_id)).size, 3, "20 entrants, lobbies of at most 8: three lobbies");
  const leaderOf = new Map((await regsOf(t.id)).map((r) => [r.id, players.find((p) => p.id === r.user_id)!]));
  await playGame(games[0], seeds);
  // A dispute on a finished lobby holds the next round.
  const disputant = leaderOf.get((await entrantsOf(games[0].lobby_id)).sort((a, b) => seeds.get(b)! - seeds.get(a)!)[0])!;
  await rejects(fileFfaDispute(db, disputant, games[0].id, { reason: "short" }), "invalid_input");
  const dispute = await fileFfaDispute(db, disputant, games[0].id, { reason: "I was in the circle when the game ended" });
  await rejects(fileFfaDispute(db, disputant, games[0].id, { reason: "I was in the circle when the game ended" }), "dispute_exists");
  await playGame(games[1], seeds);
  await playGame(games[2], seeds);
  assert.equal((await db.query("select 1 from ffa_lobbies where tournament_id = $1 and round = 2", [t.id])).length, 0, "round 2 waits for the dispute");
  await upholdFfaDispute(db, owner, dispute, "Replay shows the zone closed first");
  games = await gamesOf(t.id);
  const round2 = games.filter((g) => g.round === 2);
  assert.equal(new Set(round2.map((g) => g.lobby_id)).size, 2, "nine qualifiers: two lobbies");
  const qualified = new Set((await db.query<{ registration_id: string }>("select registration_id from ffa_entries where tournament_id = $1 and round = 2", [t.id])).map((r) => r.registration_id));
  assert.equal(qualified.size, 9, "three from each lobby");
  for (const s of [1, 2, 3, 4, 5, 6, 7, 8, 9]) assert.ok([...qualified].some((id) => seeds.get(id) === s), `seed ${s} advanced`);
  assert.equal((await notes(leaderOf.get([...seeds.entries()].find(([, s]) => s === 20)![0])!.id, "ffa_eliminated")).length, 1);
  // Round 1 is now final.
  await rejects(recordGame(db, owner, games[0].id, { lines: [], note: "late fix" }), "stage_locked");
  await rejects(fileFfaDispute(db, disputant, games[0].id, { reason: "Another look at the replay please" }), "stage_locked");
  // Lobby details: code and time for the lobby's entrants.
  await setLobbyDetails(db, owner, round2[0].lobby_id, { roomCode: "PUBG-123", scheduledAt: "2030-01-01T15:00", timeZone: "UTC" });
  // A disqualified entrant keeps no rank and does not advance.
  const dqReg = [...qualified].find((id) => seeds.get(id) === 9)!;
  await disqualify(db, owner, t.id, dqReg, "Teaming");
  for (const g of round2) await playGame(g, seeds);
  const final = (await gamesOf(t.id)).filter((g) => g.round === 3);
  assert.equal(new Set(final.map((g) => g.lobby_id)).size, 1, "a single final lobby");
  const finalists = await entrantsOf(final[0].lobby_id);
  assert.equal(finalists.length, 6);
  assert.ok(!finalists.includes(dqReg));
  for (const g of final) await playGame(g, seeds);
  const [done] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
  assert.equal(done.status, "COMPLETED");
  const places = Object.fromEntries((await regsOf(t.id)).map((r) => [r.seed, r.placement]));
  assert.deepEqual([places[1], places[2], places[3], places[4], places[5], places[6]], [1, 2, 3, 4, 5, 6], "the final decides the top places");
  assert.equal(places[9], null, "disqualified: no place");
  assert.equal(places[7], 7, "eliminated in round 2 follow");
  assert.ok(Object.values(places).filter((p) => p === 10).length >= 2, "eliminated in round 1 share places by lobby place");
  const tables = await roundTables(db, (await db.query<{ id: string; format_settings: unknown }>("select id, format_settings from tournaments where id = $1", [t.id]))[0]);
  assert.equal(tables.length, 3 + 2 + 1);
  const [created] = await db.query<{ n: number }>("select count(*)::int as n from audit_log where entity_id = $1 and action = 'tournament.ffa_round_created'", [t.id]);
  assert.equal(created.n, 3, "each round created once");
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("ffa: regeneration only before results; a correction resolves the dispute about the game; copies keep the settings", async () => {
  const { t, players, seeds } = await ffaEvent(9, { lobbySize: "5", ffaGames: "1", ffaAdvance: "2" });
  const before = await gamesOf(t.id);
  await regenerateMatches(db, owner, t.id);
  const after = await gamesOf(t.id);
  assert.equal(after.length, before.length);
  assert.notEqual(after[0].id, before[0].id, "rebuilt");
  await playGame(after[0], seeds);
  await rejects(regenerateMatches(db, owner, t.id), "regeneration_blocked");
  const entrants = (await entrantsOf(after[0].lobby_id)).sort((a, b) => seeds.get(a)! - seeds.get(b)!);
  const [leader] = await db.query<{ user_id: string }>("select user_id from registrations where id = $1", [entrants[1]]);
  const user = players.find((p) => p.id === leader.user_id)!;
  const d = await fileFfaDispute(db, user, after[0].id, { reason: "Places two and one are swapped" });
  await recordGame(db, owner, after[0].id, { lines: [entrants[1], entrants[0], ...entrants.slice(2)].map((reg, i) => ({ reg, placement: String(i + 1), kills: "0" })), note: "Swapped per replay" });
  const [res] = await db.query<{ status: string; decision: string }>("select status, decision from ffa_disputes where id = $1", [d]);
  assert.deepEqual(res, { status: "resolved", decision: "corrected" });
  const copy = await cloneTournament(db, owner, t.id, { name: "FFA Copy" });
  const [c] = await db.query<{ format: string; format_settings: Record<string, unknown> }>("select format, format_settings from tournaments where id = $1", [copy.id]);
  assert.equal(c.format, "ffa");
  assert.deepEqual([c.format_settings.lobbySize, c.format_settings.games, c.format_settings.advance], [5, 1, 2]);
});
