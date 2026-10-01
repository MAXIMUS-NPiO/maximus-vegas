import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { deleteAccount, exportAccount, signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg, createTeam } from "../src/server/teams.ts";
import { cloneTournament, createTournament, register, transition, updateTournament, type TournamentInput } from "../src/server/tournaments.ts";
import { correctResult, officialResult, setMatchFormat, submitResult, updateMatchDetails } from "../src/server/matches.ts";
import { setRoster, substitute } from "../src/server/rosters.ts";
import { addVenue, removeVenue, reschedule, scheduleConflicts, scheduleWaves, venues } from "../src/server/schedule.ts";
import { groupStandings, roundStandings } from "../src/server/rounds.ts";
import { canRate, feedbackList, feedbackSummary, rateTournament } from "../src/server/feedback.ts";
import { createFromTemplate, listTemplates, saveTemplate } from "../src/server/templates.ts";
import { tournamentHistory } from "../src/server/queries.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
let seq = 0;
const PASSWORD = "correct horse battery";

async function mk(name: string): Promise<SessionUser> {
  const s = await signUp(db, { email: `${name}@example.com`, username: name, displayName: name.toUpperCase(), password: PASSWORD, adult: "on", terms: "on" });
  return (await sessionUser(db, s.token))!;
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}

const base = (over: Partial<TournamentInput> = {}): TournamentInput => ({
  name: `Release6 ${++seq}`,
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
let orgId: string;

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  owner = await mk("r6owner");
  orgId = (await createOrg(db, owner, { name: "Release Six", description: "" })).id;
});
test.after(async () => {
  await db.close();
});

type M = { id: string; stage: number; bracket: string; round: number; position: number; group_no: number; a_reg: string | null; b_reg: string | null; status: string; scheduled_at: Date | null; venue_id: string | null };
const matchesOf = (tid: string) =>
  db.query<M>("select id, stage, bracket, round, position, group_no, a_reg, b_reg, status, scheduled_at, venue_id from matches where tournament_id = $1 order by stage, bracket, round, position", [tid]);

/** Creates, opens and starts a tournament with `n` fresh solo players; returns it with the players. */
async function started(n: number, over: Partial<TournamentInput> = {}, prefix = `p${seq}`) {
  const t = await createTournament(db, owner, orgId, base(over));
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  const players: SessionUser[] = [];
  for (let i = 1; i <= n; i++) {
    const p = await mk(`${prefix}x${seq}n${i}`);
    players.push(p);
    await register(db, p, t.id);
  }
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  return { t, players };
}

const leaderOf = async (regId: string, players: SessionUser[]) => {
  const [r] = await db.query<{ user_id: string }>("select user_id from registrations where id = $1", [regId]);
  return players.find((p) => p.id === r.user_id)!;
};

test("series by level: a Bo3 final, a referee's Bo5 override, series scores enforced and frozen after a result", async () => {
  const { t, players } = await started(4, { series: { seriesBestOf: "1", seriesFinal: "3" } });
  const ms = await matchesOf(t.id);
  const [semi1, semi2] = ms.filter((m) => m.round === 1);
  const final = ms.find((m) => m.round === 2)!;
  // Best of 1: a free score.
  await officialResult(db, owner, semi1.id, { scoreA: 16, scoreB: 10, evidenceUrl: "", note: "" });
  // The second semi-final is set to Bo5 by the referee before anything is reported.
  await setMatchFormat(db, owner, semi2.id, { series: "5" });
  const a = await leaderOf(semi2.a_reg!, players);
  await rejects(submitResult(db, a, semi2.id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" }), "invalid_series_score");
  await submitResult(db, a, semi2.id, { scoreA: 3, scoreB: 1, evidenceUrl: "", note: "" });
  await rejects(setMatchFormat(db, owner, semi2.id, { series: "3" }), "not_editable");
  await officialResult(db, owner, semi2.id, { scoreA: 3, scoreB: 1, evidenceUrl: "", note: "" });
  // The final inherits the final rule: Bo3.
  await rejects(officialResult(db, owner, final.id, { scoreA: 16, scoreB: 10, evidenceUrl: "", note: "" }), "invalid_series_score");
  await rejects(officialResult(db, owner, final.id, { scoreA: 2, scoreB: 2, evidenceUrl: "", note: "" }), "invalid_series_score");
  await officialResult(db, owner, final.id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" });
  const [done] = await db.query<{ status: string }>("select status from tournaments where id = $1", [t.id]);
  assert.equal(done.status, "COMPLETED");
  // Corrections keep the series rule.
  await rejects(correctResult(db, owner, final.id, { scoreA: 1, scoreB: 0, evidenceUrl: "", note: "typo in the final" }), "invalid_series_score");
  await correctResult(db, owner, final.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "typo in the final" });
  // Only referees set a match format.
  await rejects(setMatchFormat(db, players[0], semi1.id, { series: "3" }), "forbidden");
  // A copy keeps the rules.
  const copy = await cloneTournament(db, owner, t.id, { name: "Copy with series" });
  const [c] = await db.query<{ series_rules: { final?: number } }>("select series_rules from tournaments where id = $1", [copy.id]);
  assert.equal(c.series_rules.final, 3);
});

test("points by level: a group's and a round's own points decide the group table", async () => {
  const { t } = await started(6, {
    format: "groups",
    settings: { groupCount: "2", groupAdvance: "1", playoffFormat: "single_elimination" },
    series: { seriesGroup1: "A", seriesGroup1Win: "2", seriesGroup1Draw: "1", seriesGroup1Loss: "0", seriesRound1: "3", seriesRound1Win: "5", seriesRound1Draw: "1", seriesRound1Loss: "0" },
  });
  const ms = (await matchesOf(t.id)).filter((m) => m.stage === 1);
  for (const m of ms) await officialResult(db, owner, m.id, { scoreA: 1, scoreB: 0, evidenceUrl: "", note: "" });
  const tables = await groupStandings(db, { id: t.id, format: "groups", format_settings: (await db.query<{ format_settings: unknown }>("select format_settings from tournaments where id = $1", [t.id]))[0].format_settings });
  const pointsOf = (m: M) => (m.round === 3 ? 5 : m.group_no === 1 ? 2 : 3);
  for (const table of tables) {
    const expected = new Map<string, number>();
    for (const m of ms.filter((x) => x.group_no === table.group)) expected.set(m.a_reg!, (expected.get(m.a_reg!) ?? 0) + pointsOf(m));
    for (const row of table.rows) assert.equal(row.points, expected.get(row.id) ?? 0, `group ${table.group}: ${row.id}`);
  }
  // The round-robin standings of a plain event follow a match override too.
  const rr = await started(3, { format: "round_robin" });
  const [first] = await matchesOf(rr.t.id);
  await setMatchFormat(db, owner, first.id, { pointsWin: "10", pointsDraw: "5", pointsLoss: "0" });
  await officialResult(db, owner, first.id, { scoreA: 1, scoreB: 0, evidenceUrl: "", note: "" });
  const table = await roundStandings(db, { id: rr.t.id, format: "round_robin", format_settings: null });
  assert.equal(table.find((r) => r.id === first.a_reg)!.points, 10);
});

test("admission criteria: email, account age, XP and matches in the game, for every roster player; frozen after an application", async () => {
  const t = await createTournament(db, owner, orgId, base({ admission: { emailVerified: "on", minAccountDays: "30", minXp: "100", minMatches: "2" } }));
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  const p = await mk(`adm${seq}`);
  await rejects(register(db, p, t.id), "admission_email");
  await db.query("update users set email_verified_at = now() where id = $1", [p.id]);
  await rejects(register(db, p, t.id), "admission_account_age");
  await db.query("update users set created_at = now() - interval '40 days' where id = $1", [p.id]);
  await rejects(register(db, p, t.id), "admission_xp");
  const xp = async (user: string, ref: string, amount: number, reason = "match_win", game = "cs2") =>
    db.query("insert into xp_events (user_id, amount, reason, game, ref, idem_key) values ($1, $2, $3, $4, $5, $6)", [user, amount, reason, game, ref, `${user}:${ref}:${reason}`]);
  await xp(p.id, "m1", 60);
  await xp(p.id, "m1", 20, "match_played");
  await xp(p.id, "other-game", 500, "match_win", "valorant");
  await rejects(register(db, p, t.id), "admission_xp");
  await xp(p.id, "bonus", 30, "objective");
  await rejects(register(db, p, t.id), "admission_matches");
  await xp(p.id, "m2", 50);
  const r = await register(db, p, t.id);
  assert.equal(r.status, "registered");
  // Frozen once anyone has applied.
  await rejects(updateTournament(db, owner, t.id, base({ name: "Changed", admission: { emailVerified: "on" } })), "not_editable");
  // Teams: every player of the event roster.
  const team = await createTournament(db, owner, orgId, base({ participantType: "team", teamSize: 2, admission: { emailVerified: "on" } }));
  await transition(db, owner, team.id, "PUBLISHED");
  await transition(db, owner, team.id, "REGISTRATION_OPEN");
  const cap = await mk(`cap${seq}`);
  const mate = await mk(`mate${seq}`);
  const spare = await mk(`spare${seq}`);
  const squad = await createTeam(db, cap, { name: `Squad ${seq}`, tag: "SQ", game: "cs2" });
  for (const u of [mate, spare]) await db.query("insert into team_members (team_id, user_id) values ($1, $2)", [squad.id, u.id]);
  await db.query("update users set email_verified_at = now() where id = any($1)", [[cap.id, mate.id]]);
  await rejects(register(db, cap, team.id, squad.id), "admission_email");
  await db.query("update users set email_verified_at = now() where id = $1", [spare.id]);
  const reg = await register(db, cap, team.id, squad.id);
  // A roster change may not bring in a player who misses a criterion.
  await setRoster(db, cap, team.id, reg.id, [cap.id, mate.id]);
  await db.query("update users set email_verified_at = null where id = $1", [spare.id]);
  await rejects(setRoster(db, cap, team.id, reg.id, [cap.id, mate.id, spare.id]), "admission_email");
  await transition(db, owner, team.id, "REGISTRATION_CLOSED");
  await rejects(substitute(db, owner, team.id, reg.id, mate.id, spare.id, "mate is ill today"), "admission_email");
});

test("venues and schedule: waves over venues, refused overlaps, confirmed overrides, other tournaments, removal", async () => {
  const { t, players } = await started(8, { matchMinutes: "60" });
  await addVenue(db, owner, t.id, { name: "Stage A", kind: "stage" });
  await addVenue(db, owner, t.id, { name: "Stage B", kind: "station" });
  await rejects(addVenue(db, owner, t.id, { name: "stage a", kind: "stage" }), "venue_exists");
  await rejects(addVenue(db, owner, t.id, { name: "Bad", kind: "bunker" }), "invalid_input");
  const list = await venues(db, t.id);
  const r = await scheduleWaves(db, owner, t.id, { round: "1:W:1", at: "2030-01-02T10:00", timeZone: "UTC" });
  assert.deepEqual(r, { matches: 4, waves: 2 });
  const round1 = (await matchesOf(t.id)).filter((m) => m.round === 1);
  assert.deepEqual(
    round1.map((m) => [new Date(m.scheduled_at!).toISOString().slice(11, 16), list.find((v) => v.id === m.venue_id)!.name]),
    [["10:00", "Stage A"], ["10:00", "Stage B"], ["11:00", "Stage A"], ["11:00", "Stage B"]],
  );
  assert.deepEqual(await scheduleConflicts(db, t), []);
  // Moving the third match onto the first one's slot at the same venue is refused unless confirmed.
  await rejects(updateMatchDetails(db, owner, round1[2].id, { scheduledAt: "2030-01-02T10:30", timeZone: "UTC" }), "schedule_conflict");
  await updateMatchDetails(db, owner, round1[2].id, { scheduledAt: "2030-01-02T10:30", timeZone: "UTC", force: "1" });
  const after = await scheduleConflicts(db, t);
  assert.deepEqual(after.map((c) => c.kind), ["venue"]);
  // Shifting everything keeps the known overlap and creates no new one: allowed.
  await reschedule(db, owner, t.id, { round: "all", shiftMinutes: "30" });
  // Stage B hosts match 2 until 11:30: moving match 3 there creates a new overlap.
  await rejects(updateMatchDetails(db, owner, round1[2].id, { venueId: list[1].id }), "schedule_conflict");
  await updateMatchDetails(db, owner, round1[2].id, { venueId: "", scheduledAt: "2030-01-02T12:30", timeZone: "UTC" });
  assert.deepEqual(await scheduleConflicts(db, t), []);
  // A player of this event plays in another tournament at the same time.
  const other = await createTournament(db, owner, orgId, base({ game: "cs2" }));
  await transition(db, owner, other.id, "PUBLISHED");
  await transition(db, owner, other.id, "REGISTRATION_OPEN");
  const busy = await leaderOf(round1[0].a_reg!, players);
  await register(db, busy, other.id);
  await register(db, await mk(`solo${seq}`), other.id);
  await transition(db, owner, other.id, "REGISTRATION_CLOSED");
  await transition(db, owner, other.id, "IN_PROGRESS");
  const [om] = await matchesOf(other.id);
  await rejects(updateMatchDetails(db, owner, om.id, { scheduledAt: "2030-01-02T10:45", timeZone: "UTC" }), "schedule_conflict");
  await updateMatchDetails(db, owner, om.id, { scheduledAt: "2030-01-02T13:00", timeZone: "UTC" });
  // A venue with unplayed matches stays.
  await rejects(removeVenue(db, owner, t.id, list[0].id), "venue_in_use");
  const history = await tournamentHistory(db, t.id);
  const actions = history.map((h) => h.action);
  for (const a of ["tournament.venue_added", "tournament.waves_scheduled", "match.schedule_override", "tournament.rescheduled"]) assert.ok(actions.includes(a), a);
  assert.ok((await verifyAuditChain(db)).valid);
});

test("ratings: participants only, within 30 days, one per player; templates show the ratings of their tournaments; erased with the account", async () => {
  const src = await createTournament(db, owner, orgId, base({ maxParticipants: 2, series: { seriesFinal: "3" }, admission: { minAccountDays: "1" }, matchMinutes: "45" }));
  await addVenue(db, owner, src.id, { name: "Main stage", kind: "stage" });
  const tpl = await saveTemplate(db, owner, src.id, { name: `Rated cup ${seq}`, category: "Cups" });
  const t = await createFromTemplate(db, owner, tpl.id, { name: "From template", startsAt: "2030-02-01T12:00", timeZone: "UTC" });
  const [fresh] = await db.query<{ series_rules: { final?: number }; admission: { minAccountDays?: number }; match_minutes: number }>(
    "select series_rules, admission, match_minutes from tournaments where id = $1",
    [t.id],
  );
  assert.equal(fresh.series_rules.final, 3);
  assert.equal(fresh.admission.minAccountDays, 1);
  assert.equal(fresh.match_minutes, 45);
  assert.deepEqual((await venues(db, t.id)).map((v) => v.name), ["Main stage"]);
  await db.query("update tournaments set admission = null where id = $1", [t.id]);
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  const a = await mk(`ra${seq}`);
  const b = await mk(`rb${seq}`);
  const outsider = await mk(`ro${seq}`);
  await register(db, a, t.id);
  await register(db, b, t.id);
  await rejects(rateTournament(db, a, t.id, { rating: "5" }), "feedback_closed");
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const [final] = await matchesOf(t.id);
  await officialResult(db, owner, final.id, { scoreA: 2, scoreB: 0, evidenceUrl: "", note: "" });
  assert.equal(await canRate(db, t.id, a.id), true);
  assert.equal(await canRate(db, t.id, outsider.id), false);
  await rejects(rateTournament(db, outsider, t.id, { rating: "1" }), "feedback_closed");
  await rejects(rateTournament(db, a, t.id, { rating: "6" }), "invalid_input");
  await rateTournament(db, a, t.id, { rating: "4", comment: "Well run" });
  await rateTournament(db, a, t.id, { rating: "5", comment: "Well run, fast decisions" });
  await rateTournament(db, b, t.id, { rating: "2" });
  assert.deepEqual(await feedbackSummary(db, t.id), { average: 3.5, count: 2 });
  assert.equal((await feedbackList(db, t.id)).find((f) => f.rating === 5)!.comment, "Well run, fast decisions");
  const summary = (await listTemplates(db, orgId)).find((x) => x.id === tpl.id)!;
  assert.equal(summary.ratings, 2);
  assert.equal(summary.avg_rating, 3.5);
  assert.equal(summary.completed, 1);
  // The window closes 30 days after completion.
  await db.query("update tournaments set completed_at = now() - interval '31 days' where id = $1", [t.id]);
  await rejects(rateTournament(db, b, t.id, { rating: "3" }), "feedback_closed");
  // A rating is the player's data: exported, and erased with the account.
  const exported = (await exportAccount(db, a)) as unknown as { tournamentFeedback: Array<{ rating: number }> };
  assert.equal(exported.tournamentFeedback[0].rating, 5);
  await deleteAccount(db, a, PASSWORD);
  assert.deepEqual(await feedbackSummary(db, t.id), { average: 2, count: 1 });
});
