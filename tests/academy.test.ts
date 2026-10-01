import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { deleteAccount, exportAccount, signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import {
  addProgress,
  answerRequest,
  cancelRequest,
  coachByUsername,
  coachDirectory,
  coachQueue,
  completeRequest,
  engagement,
  programmeCatalogue,
  requestTraining,
  reviewCoach,
  saveCoachProfile,
  saveProgramme,
  scheduleSession,
  setProgrammeStatus,
  setSessionStatus,
  studentRequests,
  submitCoach,
  upcomingSessions,
  type CoachInput,
} from "../src/server/academy.ts";
import { gate, setFlag } from "../src/server/system.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
const PASSWORD = "correct horse battery";
const tokens = new Map<string, string>();
async function mk(name: string): Promise<SessionUser> {
  const s = await signUp(db, { email: `${name}@example.com`, username: name, displayName: name.toUpperCase(), password: PASSWORD, adult: "on", terms: "on" });
  tokens.set(name, s.token);
  return (await sessionUser(db, s.token))!;
}
async function staffUser(name: string, role: string): Promise<SessionUser> {
  const u = await mk(name);
  await db.query("insert into user_roles (user_id, role) values ($1, $2)", [u.id, role]);
  return { ...(await sessionUser(db, tokens.get(name)))!, mfaAt: new Date() };
}
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}
const profile = (over: Partial<Record<keyof CoachInput, unknown>> = {}): CoachInput => ({
  headline: "Тренер по CS2, роль IGL",
  bio: "Разбираю демо и тактику.",
  experience: "Капитан команды Alpha в лиге X 2024–2025, 3000+ часов, тренер академии с 2023 года.",
  games: ["cs2"],
  languages: ["ru", "en"],
  formats: ["online"],
  city: "",
  accepting: "1",
  ...over,
});
const programme = (over: Record<string, unknown> = {}) => ({ title: "Основы раскидок", game: "cs2", level: "beginner", format: "online", description: "Четыре занятия.", sessions: "4", minutes: "60", ...over });
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().slice(0, 16);

let support: SessionUser;
test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  support = await staffUser("ac_support", "support");
});
test.after(async () => {
  await db.close();
});

test("coach profiles are public only once verified; changed experience goes back for review", async () => {
  const coach = await mk("ac_coach1");
  await rejects(saveCoachProfile(db, coach, profile({ experience: "коротко" })), "coach_experience");
  await rejects(saveCoachProfile(db, coach, profile({ games: ["chess960"] })), "invalid_game");
  await rejects(saveCoachProfile(db, coach, profile({ languages: [] })), "invalid_input");
  assert.deepEqual(await saveCoachProfile(db, coach, profile()), { resubmitted: false });
  assert.equal(await coachByUsername(db, coach.username, null), null, "a draft is not public");
  assert.equal((await coachByUsername(db, coach.username, coach))?.own, true);
  // Programmes can be prepared but not published before verification.
  const p = await saveProgramme(db, coach, null, programme());
  await rejects(setProgrammeStatus(db, coach, p.id, "published"), "coach_not_verified");
  await rejects(saveProgramme(db, coach, null, programme({ game: "dota2" })), "invalid_game");
  await rejects(reviewCoach(db, support, coach.id, "verify", ""), "coach_state");
  await submitCoach(db, coach);
  const marketer = await staffUser("ac_marketing", "marketing");
  await rejects(reviewCoach(db, marketer, coach.id, "verify", ""), "forbidden");
  await rejects(reviewCoach(db, support, coach.id, "reject", "нет"), "invalid_input");
  await reviewCoach(db, support, coach.id, "reject", "Нужна ссылка на результаты лиги.");
  await submitCoach(db, coach);
  await reviewCoach(db, support, coach.id, "verify", "");
  assert.ok(await coachByUsername(db, coach.username, null));
  assert.ok((await coachDirectory(db, { game: "cs2" })).some((c) => c.user_id === coach.id));
  assert.equal((await coachDirectory(db, { game: "dota2" })).length, 0);
  await setProgrammeStatus(db, coach, p.id, "published");
  assert.deepEqual((await programmeCatalogue(db, { level: "beginner" })).map((x) => x.id), [p.id]);
  // A new bio keeps the verification; new experience sends the profile back and hides it.
  assert.deepEqual(await saveCoachProfile(db, coach, profile({ bio: "Новое описание." })), { resubmitted: false });
  assert.deepEqual(await saveCoachProfile(db, coach, profile({ experience: "Капитан команды Alpha и Beta, 4000+ часов, тренер академии с 2022 года." })), { resubmitted: true });
  assert.equal(await coachByUsername(db, coach.username, null), null);
  assert.equal((await programmeCatalogue(db)).length, 0, "programmes of an unverified coach are hidden");
  await reviewCoach(db, support, coach.id, "verify", "");
  for (let i = 1; i < 10; i++) await saveProgramme(db, coach, null, programme({ title: `Программа ${i}` }));
  await rejects(saveProgramme(db, coach, null, programme({ title: "Одиннадцатая" })), "programme_limit");
  await setProgrammeStatus(db, coach, p.id, "archived");
  assert.equal((await programmeCatalogue(db)).length, 0);
});

test("a training request reaches the coach's queue; sessions never overlap; progress keeps fact, recommendation and measure apart", async () => {
  const coach = await mk("ac_coach2");
  await saveCoachProfile(db, coach, profile());
  await submitCoach(db, coach);
  const [student, other, outsider] = [await mk("ac_student"), await mk("ac_other"), await mk("ac_out")];
  await rejects(requestTraining(db, student, coach.id, { programme: "", game: "cs2", goal: "Хочу улучшить раскидки", availability: "" }), "not_found");
  await reviewCoach(db, support, coach.id, "verify", "");
  await rejects(requestTraining(db, coach, coach.id, { programme: "", game: "cs2", goal: "Сам себе тренер", availability: "" }), "coach_self");
  await rejects(requestTraining(db, student, coach.id, { programme: "", game: "dota2", goal: "Хочу улучшить раскидки", availability: "" }), "invalid_game");
  await rejects(requestTraining(db, student, coach.id, { programme: "", game: "cs2", goal: "коротко", availability: "" }), "invalid_input");
  const req = await requestTraining(db, student, coach.id, { programme: "", game: "cs2", goal: "Хочу улучшить раскидки и тайминги", availability: "Вечера по будням" });
  await rejects(requestTraining(db, student, coach.id, { programme: "", game: "cs2", goal: "Ещё одна заявка тому же тренеру", availability: "" }), "request_exists");
  // The acceptance criterion: the request is in the coach's queue, and the coach is told.
  const queue = await coachQueue(db, coach.id);
  assert.deepEqual(
    queue.pending.map((r) => r.id),
    [req.id],
  );
  const [told] = await db.query<{ kind: string }>("select kind from notifications where user_id = $1 order by created_at desc limit 1", [coach.id]);
  assert.equal(told.kind, "coaching_request");
  await rejects(answerRequest(db, outsider, req.id, true, ""), "forbidden");
  await answerRequest(db, coach, req.id, true, "Начнём с демо");
  await rejects(answerRequest(db, coach, req.id, false, ""), "request_state");
  assert.equal((await studentRequests(db, student.id))[0].status, "accepted");
  // Sessions: future only, never two at once for the coach.
  await rejects(scheduleSession(db, coach, req.id, { startsAt: at(-120), tz: "UTC", minutes: "60", place: "" }), "session_time");
  await rejects(scheduleSession(db, student, req.id, { startsAt: at(120), tz: "UTC", minutes: "60", place: "" }), "forbidden");
  const s1 = await scheduleSession(db, coach, req.id, { startsAt: at(120), tz: "UTC", minutes: "60", place: "https://meet.example.org/abc" });
  const req2 = await requestTraining(db, other, coach.id, { programme: "", game: "cs2", goal: "Нужна работа над стрельбой", availability: "" });
  await answerRequest(db, coach, req2.id, true, "");
  await rejects(scheduleSession(db, coach, req2.id, { startsAt: at(150), tz: "UTC", minutes: "60", place: "" }), "session_overlap");
  const s2 = await scheduleSession(db, coach, req2.id, { startsAt: at(181), tz: "UTC", minutes: "45", place: "" });
  assert.equal((await upcomingSessions(db, coach.id)).length, 2);
  assert.equal((await upcomingSessions(db, student.id)).length, 1);
  await rejects(setSessionStatus(db, coach, s1.id, "done"), "session_time");
  await setSessionStatus(db, other, s2.id, "cancelled");
  await rejects(setSessionStatus(db, other, s2.id, "cancelled"), "session_state");
  await db.query("update coaching_sessions set starts_at = now() - interval '2 hours' where id = $1", [s1.id]);
  await rejects(setSessionStatus(db, student, s1.id, "done"), "forbidden");
  await setSessionStatus(db, coach, s1.id, "done");
  // Progress: only the coach writes; each kind validated.
  await rejects(addProgress(db, student, req.id, { kind: "observation", body: "Сам о себе", evidence: "", timeMark: "", metric: "", value: "", session: "" }), "forbidden");
  await rejects(addProgress(db, coach, req.id, { kind: "observation", body: "Пик на мид", evidence: "", timeMark: "99", metric: "", value: "", session: "" }), "progress_time_mark");
  await rejects(addProgress(db, coach, req.id, { kind: "measure", body: "Точность", evidence: "", timeMark: "", metric: "Точность, %", value: "", session: "" }), "progress_measure");
  await rejects(addProgress(db, coach, req.id, { kind: "observation", body: "Пик на мид", evidence: "http://example.org/demo", timeMark: "", metric: "", value: "", session: "" }), "invalid_url");
  await addProgress(db, coach, req.id, { kind: "observation", body: "Ранний пик на мид без поддержки", evidence: "https://example.org/demo/1", timeMark: "12:34", metric: "", value: "", session: s1.id });
  await addProgress(db, coach, req.id, { kind: "exercise", body: "20 минут префайра углов на карте Mirage", evidence: "", timeMark: "", metric: "", value: "", session: "" });
  await addProgress(db, coach, req.id, { kind: "measure", body: "Карта aim_botz, 100 целей", evidence: "", timeMark: "", metric: "Точность, %", value: "42,5", session: "" });
  const view = await engagement(db, req.id, student);
  assert.equal(view?.role, "student");
  assert.deepEqual(
    view?.progress.map((p) => p.kind),
    ["observation", "exercise", "measure"],
  );
  assert.equal(Number(view?.progress[2].value), 42.5);
  assert.equal(await engagement(db, req.id, outsider), null, "an outsider cannot open it");
  assert.equal((await engagement(db, req.id, support))?.role, "staff");
  // Completing cancels later sessions; the student can no longer cancel.
  const later = await scheduleSession(db, coach, req.id, { startsAt: at(60 * 24), tz: "UTC", minutes: "60", place: "" });
  await completeRequest(db, coach, req.id);
  const [laterRow] = await db.query<{ status: string }>("select status from coaching_sessions where id = $1", [later.id]);
  assert.equal(laterRow.status, "cancelled");
  await rejects(cancelRequest(db, student, req.id), "request_state");
  await cancelRequest(db, other, req2.id);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("limits, suspension, feature switch, export and deletion", async () => {
  const coach = await mk("ac_coach3");
  await saveCoachProfile(db, coach, profile({ games: ["cs2", "valorant"] }));
  await submitCoach(db, coach);
  await reviewCoach(db, support, coach.id, "verify", "");
  const busy = await mk("ac_busy");
  // Five unanswered requests at most.
  for (let i = 0; i < 5; i++) {
    const c = await mk(`ac_c${i}`);
    await saveCoachProfile(db, c, profile());
    await db.query("update coaches set status = 'verified' where user_id = $1", [c.id]);
    await requestTraining(db, busy, c.id, { programme: "", game: "cs2", goal: "Цель для лимита заявок", availability: "" });
  }
  await rejects(requestTraining(db, busy, coach.id, { programme: "", game: "cs2", goal: "Шестая заявка без ответа", availability: "" }), "request_limit");
  // A coach who is not taking requests.
  await saveCoachProfile(db, coach, profile({ games: ["cs2", "valorant"], accepting: "" }));
  const player = await mk("ac_player");
  await rejects(requestTraining(db, player, coach.id, { programme: "", game: "cs2", goal: "Хочу тренироваться", availability: "" }), "coach_unavailable");
  await saveCoachProfile(db, coach, profile({ games: ["cs2", "valorant"] }));
  const pending = await requestTraining(db, player, coach.id, { programme: "", game: "valorant", goal: "Хочу тренироваться в Valorant", availability: "" });
  // Suspension hides the coach and declines pending requests.
  await reviewCoach(db, support, coach.id, "suspend", "Жалобы на поведение на занятиях.");
  assert.equal(await coachByUsername(db, coach.username, null), null);
  assert.equal((await studentRequests(db, player.id)).find((r) => r.id === pending.id)?.status, "declined");
  // The academy switch stops new requests for players; staff keep working.
  const infra = await staffUser("ac_infra", "infrastructure");
  await setFlag(db, infra, "academy", false, "");
  await rejects(gate(db, "training.request", player), "feature_disabled");
  await gate(db, "training.answer", player);
  await setFlag(db, infra, "academy", true, "");
  // Export and deletion.
  const coach4 = await mk("ac_coach4");
  await saveCoachProfile(db, coach4, profile());
  await submitCoach(db, coach4);
  await reviewCoach(db, support, coach4.id, "verify", "");
  const learner = await mk("ac_learner");
  const done = await requestTraining(db, learner, coach4.id, { programme: "", game: "cs2", goal: "Завершённое обучение", availability: "" });
  await answerRequest(db, coach4, done.id, true, "");
  await completeRequest(db, coach4, done.id);
  const open = await requestTraining(db, player, coach4.id, { programme: "", game: "cs2", goal: "Открытая заявка до удаления", availability: "" });
  const data = (await exportAccount(db, learner)) as unknown as { academy: { trainingRequests: unknown[] } };
  assert.equal(data.academy.trainingRequests.length, 1);
  await deleteAccount(db, coach4, PASSWORD);
  assert.equal((await studentRequests(db, player.id)).find((r) => r.id === open.id)?.status, "cancelled", "a deleted coach's open requests are cancelled");
  assert.equal((await studentRequests(db, learner.id)).find((r) => r.id === done.id)?.status, "completed", "a closed engagement stays for its student");
  assert.equal((await db.query("select 1 from coaches where user_id = $1", [coach4.id])).length, 0, "the profile goes");
  await deleteAccount(db, learner, PASSWORD);
  assert.equal((await db.query("select 1 from coaching_requests where student_id = $1", [learner.id])).length, 0, "the student's records go");
  assert.equal((await verifyAuditChain(db)).valid, true);
});
