/**
 * MV-ACADEMY-1: coaches, programmes, training requests, sessions and progress.
 *
 * A coach profile is public only once portal staff verify the stated experience; a later change of
 * experience or games sends it back for review. Programmes of a verified coach can be published. A
 * signed-in player sends a training request to a verified coach who accepts requests; it lands in the
 * coach's queue, and the coach accepts or declines it. An accepted request is the engagement: the coach
 * schedules sessions (never two at once) and records progress, keeping apart the observation (a fact,
 * with a time mark in the replay or video), the recommendation (an exercise) and measurements. Every
 * account is adult (sign-up confirms it); work with minors is not offered. The portal takes no payment
 * for training and promises no result.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { canStaff, notify, requireSection, staffWith } from "./access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import * as v from "./validate.ts";
import { isGame } from "../lib/games.ts";

export const COACH_LANGUAGES = ["ru", "en", "other"] as const;
export const COACH_FORMATS = ["online", "offline"] as const;
export const LEVELS = ["beginner", "intermediate", "advanced"] as const;
export const PROGRESS_KINDS = ["observation", "exercise", "measure"] as const;
export type ProgressKind = (typeof PROGRESS_KINDS)[number];
export const PROGRAMME_LIMIT = 10;
export const PENDING_LIMIT = 5;
export const SESSION_LIMIT = 50;

const isId = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x);
const list = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : typeof x === "string" && x ? [x] : []);
const pick = <T extends string>(x: unknown, allowed: readonly T[], min: number, max: number): T[] => {
  const out = [...new Set(list(x))].filter((s): s is T => (allowed as readonly string[]).includes(s));
  if (out.length < min || out.length > max) fail("invalid_input");
  return out;
};

export type Coach = {
  user_id: string;
  username: string;
  display_name: string;
  headline: string;
  bio: string;
  experience: string;
  games: string[];
  languages: string[];
  formats: string[];
  city: string;
  accepting: boolean;
  status: "draft" | "submitted" | "verified" | "rejected" | "suspended";
  review_note: string;
  verified_at: Date | null;
  updated_at: Date;
};
export type Programme = {
  id: string;
  coach_id: string;
  title: string;
  game: string;
  level: (typeof LEVELS)[number];
  format: (typeof COACH_FORMATS)[number];
  description: string;
  sessions: number;
  session_minutes: number;
  status: "draft" | "published" | "archived";
};

const COACH = `select c.*, u.username, u.display_name from coaches c join users u on u.id = c.user_id`;

async function lockCoach(q: Queryable, userId: string) {
  const [c] = await q.query<Coach>(`${COACH} where c.user_id = $1 for update of c`, [userId]);
  return c ?? null;
}

// ---------- Coach profile ----------

export type CoachInput = { headline: unknown; bio: unknown; experience: unknown; games: unknown; languages: unknown; formats: unknown; city: unknown; accepting: unknown };

function coachFields(input: CoachInput) {
  const headline = v.oneLine(input.headline, 80);
  if (headline.length < 3) fail("invalid_input");
  const experience = v.clean(input.experience, 1000);
  if (experience.length < 20) fail("coach_experience");
  const games = [...new Set(list(input.games))];
  if (!games.length || games.length > 5 || !games.every((g) => isGame(g))) fail("invalid_game");
  return {
    headline,
    bio: v.clean(input.bio, 1500),
    experience,
    games,
    languages: pick(input.languages, COACH_LANGUAGES, 1, 3),
    formats: pick(input.formats, COACH_FORMATS, 1, 2),
    city: v.oneLine(input.city, 80),
    accepting: v.bool(input.accepting),
  };
}

/** Creates or edits the caller's coach profile; new experience or games of a verified profile go back for review. */
export async function saveCoachProfile(db: Database, user: SessionUser, input: CoachInput): Promise<{ resubmitted: boolean }> {
  const f = coachFields(input);
  return db.tx(async (q) => {
    const c = await lockCoach(q, user.id);
    if (!c) {
      await q.query(
        `insert into coaches (user_id, headline, bio, experience, games, languages, formats, city, accepting)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [user.id, f.headline, f.bio, f.experience, f.games, f.languages, f.formats, f.city, f.accepting],
      );
      await audit(q, { actorId: user.id, action: "coach.created", entity: "user", entityId: user.id });
      return { resubmitted: false };
    }
    const claims = c.experience !== f.experience || [...c.games].sort().join() !== [...f.games].sort().join();
    const resubmitted = c.status === "verified" && claims;
    await q.query(
      `update coaches set headline = $2, bio = $3, experience = $4, games = $5, languages = $6, formats = $7, city = $8, accepting = $9,
              status = case when $10::boolean then 'submitted' else status end, updated_at = now() where user_id = $1`,
      [user.id, f.headline, f.bio, f.experience, f.games, f.languages, f.formats, f.city, f.accepting, resubmitted],
    );
    if (resubmitted) await notify(q, await staffWith(q, "academy"), "coach_submitted", { coach: user.username, adminTab: "academy" });
    await audit(q, { actorId: user.id, action: resubmitted ? "coach.resubmitted" : "coach.updated", entity: "user", entityId: user.id });
    return { resubmitted };
  });
}

export async function submitCoach(db: Database, user: SessionUser) {
  await db.tx(async (q) => {
    const c = await lockCoach(q, user.id);
    if (!c) fail("not_found");
    if (!["draft", "rejected", "suspended"].includes(c!.status)) fail("coach_state");
    await q.query("update coaches set status = 'submitted', updated_at = now() where user_id = $1", [user.id]);
    await notify(q, await staffWith(q, "academy"), "coach_submitted", { coach: user.username, adminTab: "academy" });
    await audit(q, { actorId: user.id, action: "coach.submitted", entity: "user", entityId: user.id });
  });
}

/** Staff of the academy section verify, reject or suspend a coach; a suspension declines the coach's pending requests. */
export async function reviewCoach(db: Database, staff: SessionUser, coachId: unknown, decision: unknown, noteInput: unknown) {
  requireSection(staff, "academy");
  if (!isId(coachId)) fail("not_found");
  const note = v.clean(noteInput, 500);
  await db.tx(async (q) => {
    const c = await lockCoach(q, coachId as string);
    if (!c) fail("not_found");
    let status: Coach["status"];
    if (decision === "verify" && c!.status === "submitted") status = "verified";
    else if (decision === "reject" && c!.status === "submitted") status = "rejected";
    else if (decision === "suspend" && c!.status === "verified") status = "suspended";
    else return fail("coach_state");
    if (status !== "verified" && note.length < 10) fail("invalid_input");
    await q.query(
      `update coaches set status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now(),
              verified_at = case when $2 = 'verified' then now() else verified_at end, updated_at = now() where user_id = $1`,
      [c!.user_id, status, note, staff.id],
    );
    if (status === "suspended") {
      const declined = await q.query<{ id: string; student_id: string }>(
        "update coaching_requests set status = 'declined', decided_at = now(), closed_at = now() where coach_id = $1 and status = 'pending' returning id, student_id",
        [c!.user_id],
      );
      for (const r of declined) await notify(q, [r.student_id], "coaching_declined", { coach: c!.username, trainingId: r.id });
    }
    await notify(q, [c!.user_id], `coach_${status}`, { coachWorkspace: "1" });
    await audit(q, { actorId: staff.id, action: `coach.${status}`, entity: "user", entityId: c!.user_id, data: { note } });
  });
}

/** A coach's public page: verified profiles for everyone; the owner and academy staff see any status. */
export async function coachByUsername(q: Queryable, username: string, viewer: SessionUser | null) {
  const [c] = await q.query<Coach>(`${COACH} where u.username = $1 and u.status = 'active'`, [username.toLowerCase()]);
  if (!c) return null;
  const own = viewer?.id === c.user_id;
  if (c.status !== "verified" && !own && !canStaff(viewer, "academy")) return null;
  const programmes = await q.query<Programme>(
    `select * from academy_programmes where coach_id = $1 and (status = 'published' or $2::boolean) order by status, created_at`,
    [c.user_id, own],
  );
  return { coach: c, programmes, own };
}

export async function myCoach(q: Queryable, userId: string) {
  const [c] = await q.query<Coach>(`${COACH} where c.user_id = $1`, [userId]);
  if (!c) return null;
  const programmes = await q.query<Programme>("select * from academy_programmes where coach_id = $1 order by status, created_at", [userId]);
  return { coach: c, programmes };
}

/** Verified coaches, optionally by game, language and format. */
export async function coachDirectory(q: Queryable, filter: { game?: string; language?: string; format?: string } = {}) {
  const params: unknown[] = [];
  const where = ["c.status = 'verified'", "u.status = 'active'"];
  if (filter.game) {
    params.push(filter.game);
    where.push(`$${params.length} = any(c.games)`);
  }
  if (filter.language) {
    params.push(filter.language);
    where.push(`$${params.length} = any(c.languages)`);
  }
  if (filter.format) {
    params.push(filter.format);
    where.push(`$${params.length} = any(c.formats)`);
  }
  return q.query<Coach & { programmes: number }>(
    `${COACH.replace("select c.*,", "select c.*, (select count(*)::int from academy_programmes p where p.coach_id = c.user_id and p.status = 'published') as programmes,")}
      where ${where.join(" and ")} order by c.accepting desc, c.verified_at desc limit 100`,
    params,
  );
}

/** Published programmes of verified coaches. */
export async function programmeCatalogue(q: Queryable, filter: { game?: string; level?: string; format?: string } = {}) {
  const params: unknown[] = [];
  const where = ["p.status = 'published'", "c.status = 'verified'", "u.status = 'active'"];
  for (const [key, col] of [
    ["game", "p.game"],
    ["level", "p.level"],
    ["format", "p.format"],
  ] as const) {
    const value = filter[key];
    if (value) {
      params.push(value);
      where.push(`${col} = $${params.length}`);
    }
  }
  return q.query<Programme & { username: string; display_name: string; accepting: boolean }>(
    `select p.*, u.username, u.display_name, c.accepting
       from academy_programmes p join coaches c on c.user_id = p.coach_id join users u on u.id = c.user_id
      where ${where.join(" and ")} order by p.updated_at desc limit 100`,
    params,
  );
}

// ---------- Programmes ----------

export type ProgrammeInput = { title: unknown; game: unknown; level: unknown; format: unknown; description: unknown; sessions: unknown; minutes: unknown };

export async function saveProgramme(db: Database, user: SessionUser, programmeId: unknown, input: ProgrammeInput): Promise<{ id: string }> {
  const title = v.oneLine(input.title, 80);
  if (title.length < 3) fail("invalid_input");
  const level = (LEVELS as readonly string[]).includes(String(input.level)) ? String(input.level) : fail("invalid_input");
  const format = (COACH_FORMATS as readonly string[]).includes(String(input.format)) ? String(input.format) : fail("invalid_input");
  const description = v.clean(input.description, 2000);
  const sessions = v.intIn(input.sessions, 1, 50);
  const minutes = v.intIn(input.minutes, 30, 240);
  return db.tx(async (q) => {
    const c = await lockCoach(q, user.id);
    if (!c) fail("not_found");
    const game = typeof input.game === "string" && c!.games.includes(input.game) ? input.game : fail("invalid_game");
    if (programmeId) {
      if (!isId(programmeId)) fail("not_found");
      const rows = await q.query<{ id: string }>(
        `update academy_programmes set title = $3, game = $4, level = $5, format = $6, description = $7, sessions = $8, session_minutes = $9, updated_at = now()
          where id = $1 and coach_id = $2 returning id`,
        [programmeId, user.id, title, game, level, format, description, sessions, minutes],
      );
      if (!rows.length) fail("not_found");
      await audit(q, { actorId: user.id, action: "programme.updated", entity: "programme", entityId: programmeId as string });
      return rows[0];
    }
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from academy_programmes where coach_id = $1 and status <> 'archived'", [user.id]);
    if ((n?.n ?? 0) >= PROGRAMME_LIMIT) fail("programme_limit");
    const [row] = await q.query<{ id: string }>(
      `insert into academy_programmes (coach_id, title, game, level, format, description, sessions, session_minutes)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [user.id, title, game, level, format, description, sessions, minutes],
    );
    await audit(q, { actorId: user.id, action: "programme.created", entity: "programme", entityId: row.id });
    return row;
  });
}

/** Publish, archive or return to draft; only a verified coach publishes. */
export async function setProgrammeStatus(db: Database, user: SessionUser, programmeId: unknown, statusInput: unknown) {
  if (!isId(programmeId)) fail("not_found");
  const status = ["draft", "published", "archived"].includes(String(statusInput)) ? String(statusInput) : fail("invalid_input");
  await db.tx(async (q) => {
    const c = await lockCoach(q, user.id);
    if (!c) fail("not_found");
    if (status === "published" && c!.status !== "verified") fail("coach_not_verified");
    const rows = await q.query("update academy_programmes set status = $3, updated_at = now() where id = $1 and coach_id = $2 returning id", [programmeId, user.id, status]);
    if (!rows.length) fail("not_found");
    await audit(q, { actorId: user.id, action: `programme.${status}`, entity: "programme", entityId: programmeId as string });
  });
}

// ---------- Training requests ----------

export type RequestInput = { programme: unknown; game: unknown; goal: unknown; availability: unknown };

/** A player's request to a verified coach who accepts requests; it lands in the coach's queue. */
export async function requestTraining(db: Database, user: SessionUser, coachId: unknown, input: RequestInput): Promise<{ id: string }> {
  if (!isId(coachId)) fail("not_found");
  if (coachId === user.id) fail("coach_self");
  const goal = v.clean(input.goal, 1000);
  if (goal.length < 10) fail("invalid_input");
  const availability = v.oneLine(input.availability, 300);
  return db.tx(async (q) => {
    const c = await lockCoach(q, coachId as string);
    if (!c || c.status !== "verified") fail("not_found");
    if (!c!.accepting) fail("coach_unavailable");
    let game = typeof input.game === "string" ? input.game : "";
    let programmeId: string | null = null;
    if (input.programme) {
      const [p] = isId(input.programme)
        ? await q.query<{ id: string; game: string }>("select id, game from academy_programmes where id = $1 and coach_id = $2 and status = 'published'", [input.programme, c!.user_id])
        : [];
      if (!p) fail("not_found");
      programmeId = p!.id;
      game = p!.game;
    }
    if (!c!.games.includes(game)) fail("invalid_game");
    const [pending] = await q.query<{ n: number }>("select count(*)::int as n from coaching_requests where student_id = $1 and status = 'pending'", [user.id]);
    if ((pending?.n ?? 0) >= PENDING_LIMIT) fail("request_limit");
    const [open] = await q.query("select 1 from coaching_requests where coach_id = $1 and student_id = $2 and status in ('pending','accepted')", [c!.user_id, user.id]);
    if (open) fail("request_exists");
    let row: { id: string };
    try {
      [row] = await q.query<{ id: string }>(
        `insert into coaching_requests (coach_id, student_id, programme_id, game, goal, availability) values ($1, $2, $3, $4, $5, $6) returning id`,
        [c!.user_id, user.id, programmeId, game, goal, availability],
      );
    } catch (error) {
      if (isUniqueViolation(error, "coaching_requests_open")) fail("request_exists");
      throw error;
    }
    await notify(q, [c!.user_id], "coaching_request", { student: user.username, coachWorkspace: "1" });
    await audit(q, { actorId: user.id, action: "coaching.requested", entity: "coaching_request", entityId: row.id, data: { coach: c!.user_id, game } });
    return row;
  });
}

type RequestRow = { id: string; coach_id: string; student_id: string; status: string; game: string };

async function lockRequest(q: Queryable, requestId: unknown): Promise<RequestRow> {
  if (!isId(requestId)) fail("not_found");
  const [r] = await q.query<RequestRow>("select id, coach_id, student_id, status, game from coaching_requests where id = $1 for update", [requestId]);
  if (!r) fail("not_found");
  return r;
}

export async function answerRequest(db: Database, coach: SessionUser, requestId: unknown, accept: boolean, noteInput: unknown) {
  const note = v.clean(noteInput, 500);
  await db.tx(async (q) => {
    const r = await lockRequest(q, requestId);
    if (r.coach_id !== coach.id) fail("forbidden");
    if (r.status !== "pending") fail("request_state");
    const status = accept ? "accepted" : "declined";
    await q.query(`update coaching_requests set status = $2, coach_note = $3, decided_at = now(), closed_at = case when $2 = 'declined' then now() end where id = $1`, [r.id, status, note]);
    await notify(q, [r.student_id], `coaching_${status}`, { coach: coach.username, trainingId: r.id });
    await audit(q, { actorId: coach.id, action: `coaching.${status}`, entity: "coaching_request", entityId: r.id });
  });
}

/** The student withdraws a pending request or ends an accepted one; scheduled sessions are cancelled. */
export async function cancelRequest(db: Database, student: SessionUser, requestId: unknown) {
  await db.tx(async (q) => {
    const r = await lockRequest(q, requestId);
    if (r.student_id !== student.id) fail("forbidden");
    if (!["pending", "accepted"].includes(r.status)) fail("request_state");
    await q.query("update coaching_requests set status = 'cancelled', closed_at = now() where id = $1", [r.id]);
    await q.query("update coaching_sessions set status = 'cancelled', updated_at = now() where request_id = $1 and status = 'scheduled'", [r.id]);
    await notify(q, [r.coach_id], "coaching_cancelled", { student: student.username, coachWorkspace: "1" });
    await audit(q, { actorId: student.id, action: "coaching.cancelled", entity: "coaching_request", entityId: r.id });
  });
}

/** The coach closes an engagement as completed; later sessions still scheduled are cancelled. */
export async function completeRequest(db: Database, coach: SessionUser, requestId: unknown) {
  await db.tx(async (q) => {
    const r = await lockRequest(q, requestId);
    if (r.coach_id !== coach.id) fail("forbidden");
    if (r.status !== "accepted") fail("request_state");
    await q.query("update coaching_requests set status = 'completed', closed_at = now() where id = $1", [r.id]);
    await q.query("update coaching_sessions set status = 'cancelled', updated_at = now() where request_id = $1 and status = 'scheduled' and starts_at > now()", [r.id]);
    await notify(q, [r.student_id], "coaching_completed", { coach: coach.username, trainingId: r.id });
    await audit(q, { actorId: coach.id, action: "coaching.completed", entity: "coaching_request", entityId: r.id });
  });
}

// ---------- Sessions ----------

export type SessionInput = { startsAt: unknown; tz: unknown; minutes: unknown; place: unknown };

/** The coach books a session of an accepted request; the coach never has two sessions at once. */
export async function scheduleSession(db: Database, coach: SessionUser, requestId: unknown, input: SessionInput): Promise<{ id: string }> {
  const startsAt = v.zonedToUtc(input.startsAt, input.tz);
  if (startsAt.getTime() < Date.now() - 5 * 60_000) fail("session_time");
  const minutes = v.intIn(input.minutes, 30, 240);
  const place = v.oneLine(input.place, 300);
  return db.tx(async (q) => {
    const r = await lockRequest(q, requestId);
    if (r.coach_id !== coach.id) fail("forbidden");
    if (r.status !== "accepted") fail("request_state");
    // One booking at a time per coach: the coach row serialises the overlap check.
    await q.query("select 1 from coaches where user_id = $1 for update", [coach.id]);
    const [count] = await q.query<{ n: number }>("select count(*)::int as n from coaching_sessions where request_id = $1", [r.id]);
    if ((count?.n ?? 0) >= SESSION_LIMIT) fail("session_limit");
    const [clash] = await q.query(
      `select 1 from coaching_sessions s join coaching_requests cr on cr.id = s.request_id
        where cr.coach_id = $1 and s.status = 'scheduled'
          and s.starts_at < $2::timestamptz + make_interval(mins => $3::int) and $2::timestamptz < s.starts_at + make_interval(mins => s.minutes) limit 1`,
      [coach.id, startsAt.toISOString(), minutes],
    );
    if (clash) fail("session_overlap");
    const [row] = await q.query<{ id: string }>("insert into coaching_sessions (request_id, starts_at, minutes, place) values ($1, $2, $3, $4) returning id", [
      r.id,
      startsAt.toISOString(),
      minutes,
      place,
    ]);
    await notify(q, [r.student_id], "coaching_session", { coach: coach.username, trainingId: r.id, at: startsAt.toISOString() });
    await audit(q, { actorId: coach.id, action: "coaching.session_scheduled", entity: "coaching_request", entityId: r.id, data: { sessionId: row.id, startsAt: startsAt.toISOString(), minutes } });
    return row;
  });
}

/** The coach marks a session done, missed or cancelled; the student may cancel a future one. */
export async function setSessionStatus(db: Database, user: SessionUser, sessionId: unknown, statusInput: unknown) {
  if (!isId(sessionId)) fail("not_found");
  const status = ["done", "no_show", "cancelled"].includes(String(statusInput)) ? String(statusInput) : fail("invalid_input");
  await db.tx(async (q) => {
    const [s] = await q.query<{ id: string; request_id: string; status: string; starts_at: Date }>(
      "select id, request_id, status, starts_at from coaching_sessions where id = $1 for update",
      [sessionId],
    );
    if (!s) fail("not_found");
    const r = await lockRequest(q, s.request_id);
    const coach = r.coach_id === user.id;
    const student = r.student_id === user.id;
    if (!coach && !(student && status === "cancelled")) fail("forbidden");
    if (s.status !== "scheduled") fail("session_state");
    if (status !== "cancelled" && new Date(s.starts_at).getTime() > Date.now()) fail("session_time");
    if (student && new Date(s.starts_at).getTime() <= Date.now()) fail("session_time");
    await q.query("update coaching_sessions set status = $2, updated_at = now() where id = $1", [s.id, status]);
    if (status === "cancelled") await notify(q, [coach ? r.student_id : r.coach_id], "coaching_session_cancelled", { trainingId: r.id, at: new Date(s.starts_at).toISOString() });
    await audit(q, { actorId: user.id, action: `coaching.session_${status}`, entity: "coaching_request", entityId: r.id, data: { sessionId: s.id } });
  });
}

// ---------- Progress ----------

export type ProgressInput = { kind: unknown; body: unknown; evidence: unknown; timeMark: unknown; metric: unknown; value: unknown; session: unknown };

/** The coach records an observation (a fact, with a time mark), an exercise (a recommendation) or a measurement. */
export async function addProgress(db: Database, coach: SessionUser, requestId: unknown, input: ProgressInput): Promise<{ id: string }> {
  const kind = (PROGRESS_KINDS as readonly string[]).includes(String(input.kind)) ? (String(input.kind) as ProgressKind) : fail("invalid_input");
  const body = v.clean(input.body, 1000);
  if (body.length < 3) fail("invalid_input");
  const evidence = v.oneLine(input.evidence, 500);
  if (evidence && !/^https:\/\//.test(evidence)) fail("invalid_url");
  if (evidence) v.optionalUrl(evidence);
  const timeMark = v.oneLine(input.timeMark, 8);
  if (timeMark && !/^([0-9]{1,2}:)?[0-9]{1,2}:[0-9]{2}$/.test(timeMark)) fail("progress_time_mark");
  let metric = "";
  let value: number | null = null;
  if (kind === "measure") {
    metric = v.oneLine(input.metric, 60);
    value = Number(String(input.value ?? "").replace(",", "."));
    if (!metric || !Number.isFinite(value) || Math.abs(value) > 1e9 || String(input.value ?? "").trim() === "") fail("progress_measure");
  }
  return db.tx(async (q) => {
    const r = await lockRequest(q, requestId);
    if (r.coach_id !== coach.id) fail("forbidden");
    if (!["accepted", "completed"].includes(r.status)) fail("request_state");
    let sessionId: string | null = null;
    if (input.session) {
      const [s] = isId(input.session) ? await q.query<{ id: string }>("select id from coaching_sessions where id = $1 and request_id = $2", [input.session, r.id]) : [];
      if (!s) fail("not_found");
      sessionId = s.id;
    }
    const [row] = await q.query<{ id: string }>(
      `insert into progress_records (request_id, session_id, author_id, kind, body, evidence_url, time_mark, metric, value)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [r.id, sessionId, coach.id, kind, body, evidence, timeMark, metric, value],
    );
    await notify(q, [r.student_id], "coaching_progress", { coach: coach.username, trainingId: r.id });
    await audit(q, { actorId: coach.id, action: "coaching.progress_added", entity: "coaching_request", entityId: r.id, data: { recordId: row.id, kind } });
    return row;
  });
}

// ---------- Views ----------

export type Engagement = {
  id: string;
  coach_id: string;
  student_id: string;
  coach_username: string;
  coach_name: string;
  student_username: string;
  student_name: string;
  programme_title: string | null;
  programme_sessions: number | null;
  game: string;
  goal: string;
  availability: string;
  status: "pending" | "accepted" | "declined" | "cancelled" | "completed";
  coach_note: string;
  created_at: Date;
  decided_at: Date | null;
  closed_at: Date | null;
};

const ENGAGEMENT = `select r.*, cu.username as coach_username, cu.display_name as coach_name, su.username as student_username, su.display_name as student_name,
       p.title as programme_title, p.sessions as programme_sessions
  from coaching_requests r join users cu on cu.id = r.coach_id join users su on su.id = r.student_id
  left join academy_programmes p on p.id = r.programme_id`;

export type SessionRow = { id: string; request_id: string; starts_at: Date; minutes: number; place: string; status: string };
export type ProgressRow = {
  id: string;
  kind: ProgressKind;
  body: string;
  evidence_url: string;
  time_mark: string;
  metric: string;
  value: string | null;
  session_id: string | null;
  author: string;
  created_at: Date;
};

/** An engagement for its coach, its student, or academy staff (whose view the page records). */
export async function engagement(q: Queryable, requestId: string, viewer: SessionUser | null) {
  if (!viewer || !isId(requestId)) return null;
  const [r] = await q.query<Engagement>(`${ENGAGEMENT} where r.id = $1`, [requestId]);
  if (!r) return null;
  const role = r.coach_id === viewer.id ? "coach" : r.student_id === viewer.id ? "student" : canStaff(viewer, "academy") ? "staff" : null;
  if (!role) return null;
  const [sessions, progress] = await Promise.all([
    q.query<SessionRow>("select id, request_id, starts_at, minutes, place, status from coaching_sessions where request_id = $1 order by starts_at", [r.id]),
    q.query<ProgressRow>(
      `select p.id, p.kind, p.body, p.evidence_url, p.time_mark, p.metric, p.value::text as value, p.session_id, u.username as author, p.created_at
         from progress_records p join users u on u.id = p.author_id where p.request_id = $1 order by p.created_at`,
      [r.id],
    ),
  ]);
  return { request: r, sessions, progress, role: role as "coach" | "student" | "staff" };
}

/** The coach's queue: pending requests first, then active engagements, then recent closed ones. */
export async function coachQueue(q: Queryable, coachId: string) {
  const rows = await q.query<Engagement>(
    `${ENGAGEMENT} where r.coach_id = $1 and su.status <> 'deleted'
      order by case r.status when 'pending' then 0 when 'accepted' then 1 else 2 end, r.created_at desc limit 60`,
    [coachId],
  );
  return { pending: rows.filter((r) => r.status === "pending"), active: rows.filter((r) => r.status === "accepted"), closed: rows.filter((r) => !["pending", "accepted"].includes(r.status)).slice(0, 20) };
}

export async function studentRequests(q: Queryable, userId: string) {
  return q.query<Engagement>(`${ENGAGEMENT} where r.student_id = $1 order by r.created_at desc limit 50`, [userId]);
}

/** Scheduled sessions of a user as coach or student, from an hour ago on (the calendar). */
export async function upcomingSessions(q: Queryable, userId: string) {
  return q.query<SessionRow & { coach_username: string; student_username: string; coach_id: string }>(
    `select s.id, s.request_id, s.starts_at, s.minutes, s.place, s.status, cu.username as coach_username, su.username as student_username, r.coach_id
       from coaching_sessions s join coaching_requests r on r.id = s.request_id join users cu on cu.id = r.coach_id join users su on su.id = r.student_id
      where (r.coach_id = $1 or r.student_id = $1) and s.status = 'scheduled' and s.starts_at > now() - interval '1 hour'
      order by s.starts_at limit 50`,
    [userId],
  );
}

/** Control-centre queue: coaches waiting for verification first, then verified and suspended ones. */
export async function coachReviewQueue(q: Queryable) {
  return q.query<Coach>(
    `${COACH} where c.status in ('submitted','verified','suspended')
      order by case c.status when 'submitted' then 0 when 'verified' then 1 else 2 end, c.updated_at desc limit 100`,
  );
}

// ---------- Account data ----------

export async function academyExport(q: Queryable, userId: string) {
  return {
    coachProfile: (await q.query("select headline, bio, experience, games, languages, formats, city, accepting, status, created_at, verified_at from coaches where user_id = $1", [userId]))[0] ?? null,
    programmes: await q.query("select title, game, level, format, description, sessions, session_minutes, status, created_at from academy_programmes where coach_id = $1 order by created_at", [userId]),
    trainingRequests: await q.query(
      `select u.username as coach, r.game, r.goal, r.availability, r.status, r.coach_note, r.created_at, r.closed_at
         from coaching_requests r join users u on u.id = r.coach_id where r.student_id = $1 order by r.created_at`,
      [userId],
    ),
    coachingRequests: await q.query(
      `select u.username as student, r.game, r.status, r.created_at, r.closed_at
         from coaching_requests r join users u on u.id = r.student_id where r.coach_id = $1 order by r.created_at`,
      [userId],
    ),
    trainingSessions: await q.query(
      `select s.starts_at, s.minutes, s.status from coaching_sessions s join coaching_requests r on r.id = s.request_id where r.student_id = $1 or r.coach_id = $1 order by s.starts_at`,
      [userId],
    ),
    progressRecords: await q.query(
      `select p.kind, p.body, p.evidence_url, p.time_mark, p.metric, p.value, p.created_at
         from progress_records p join coaching_requests r on r.id = p.request_id where r.student_id = $1 order by p.created_at`,
      [userId],
    ),
  };
}

/**
 * Account deletion: the student's requests, sessions and progress records go; a coach's open requests are
 * cancelled and the profile and programmes go, while closed engagements stay for their students.
 */
export async function eraseAcademyData(q: Queryable, userId: string) {
  await q.query("delete from coaching_requests where student_id = $1", [userId]);
  const open = await q.query<{ id: string; student_id: string }>(
    "update coaching_requests set status = 'cancelled', closed_at = now() where coach_id = $1 and status in ('pending','accepted') returning id, student_id",
    [userId],
  );
  for (const r of open) await notify(q, [r.student_id], "coaching_coach_left", { trainingId: r.id });
  await q.query("update coaching_sessions set status = 'cancelled', updated_at = now() where status = 'scheduled' and request_id in (select id from coaching_requests where coach_id = $1)", [userId]);
  await q.query("delete from coaches where user_id = $1", [userId]);
}
