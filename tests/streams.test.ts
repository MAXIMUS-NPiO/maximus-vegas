import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { createTournament, register, transition, type TournamentInput } from "../src/server/tournaments.ts";
import { confirmResult, submitResult } from "../src/server/matches.ts";
import { addStream, matchStreams, mediaCentre, overlayData, removeStream, STREAM_LIMIT, tournamentStreams } from "../src/server/streams.ts";
import { embedSrc, parseStreamUrl } from "../src/lib/streams.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
let seq = 0;
const tokens = new Map<string, string>();
async function mk(name: string): Promise<SessionUser> {
  const s = await signUp(db, { email: `${name}@example.com`, username: name, displayName: name.toUpperCase(), password: "correct horse battery", adult: "on", terms: "on" });
  tokens.set(name, s.token);
  return (await sessionUser(db, s.token))!;
}
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}
const base = (over: Partial<TournamentInput> = {}): TournamentInput => ({
  name: `Stream Cup ${++seq}`,
  game: "cs2",
  participantType: "solo",
  teamSize: 1,
  maxParticipants: 8,
  checkInRequired: "",
  region: "",
  startsAt: "2030-01-01T12:00",
  timeZone: "UTC",
  description: "",
  rules: "",
  ...over,
});
const input = (over: Record<string, unknown> = {}) => ({
  url: "https://www.twitch.tv/maximus_cast",
  title: "Основной эфир",
  kind: "live",
  match: "",
  language: "ru",
  startsAt: "",
  tz: "UTC",
  rights: "1",
  ...over,
});

let owner: SessionUser;
let orgId: string;
test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  owner = await mk("st_owner");
  orgId = (await createOrg(db, owner, { name: "Stream Space", description: "" })).id;
});
test.after(async () => {
  await db.close();
});

test("stream links: https only, platform recognised, Twitch channels and YouTube videos playable on the portal", () => {
  assert.deepEqual(parseStreamUrl("https://www.twitch.tv/Alpha_Cast"), { url: "https://www.twitch.tv/Alpha_Cast", platform: "twitch", embed: { kind: "twitch", channel: "alpha_cast" } });
  assert.equal(parseStreamUrl("https://twitch.tv/videos/123456")?.embed, null);
  assert.equal(parseStreamUrl("https://www.twitch.tv/directory")?.embed, null);
  assert.equal(parseStreamUrl("https://clips.twitch.tv/SomeClip")?.platform, "twitch");
  for (const url of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/live/dQw4w9WgXcQ?si=x", "https://m.youtube.com/shorts/dQw4w9WgXcQ"])
    assert.deepEqual(parseStreamUrl(url)?.embed, { kind: "youtube", id: "dQw4w9WgXcQ" }, url);
  assert.equal(parseStreamUrl("https://www.youtube.com/@maximus")?.embed, null, "a channel page is a link only");
  assert.equal(parseStreamUrl("https://kick.com/maximus")?.platform, "kick");
  assert.equal(parseStreamUrl("https://vkvideo.ru/video-1_2")?.platform, "vk");
  assert.equal(parseStreamUrl("https://example.org/stream")?.platform, "other");
  for (const bad of ["http://twitch.tv/a", "javascript:alert(1)", "https://user:pw@twitch.tv/abc", "https://twitch.tv:8443/abc", "not a url", "", `https://example.org/${"x".repeat(500)}`, 42])
    assert.equal(parseStreamUrl(bad), null, String(bad).slice(0, 40));
  assert.equal(embedSrc({ kind: "twitch", channel: "alpha_cast" }, "www.maximus.vegas"), "https://player.twitch.tv/?channel=alpha_cast&parent=www.maximus.vegas&autoplay=true");
  assert.equal(embedSrc({ kind: "youtube", id: "dQw4w9WgXcQ" }, "x"), "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1");
});

test("organisers assign streams to the event and a match with rights confirmed; players are told; media lists only public events", async () => {
  const outsider = await mk("st_out");
  const [p1, p2] = [await mk("st_p1"), await mk("st_p2")];
  const t = await createTournament(db, owner, orgId, base());
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  await register(db, p1, t.id);
  await register(db, p2, t.id);
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const [m] = await db.query<{ id: string; a_reg: string; b_reg: string }>("select id, a_reg, b_reg from matches where tournament_id = $1 and a_reg is not null and b_reg is not null", [t.id]);
  const other = await createTournament(db, owner, orgId, base());
  const [foreign] = await db.query<{ id: string }>("select id from matches where tournament_id = $1 limit 1", [t.id]);
  // Rights, links and permissions are checked before anything is stored.
  await rejects(addStream(db, outsider, t.id, input()), "forbidden");
  await rejects(addStream(db, owner, t.id, input({ rights: "" })), "stream_rights");
  await rejects(addStream(db, owner, t.id, input({ url: "http://www.twitch.tv/maximus_cast" })), "stream_url");
  await rejects(addStream(db, owner, other.id, input({ match: foreign.id })), "stream_match");
  // The event stream without a start time is "under way" while the tournament runs; a later one is scheduled.
  const event = await addStream(db, owner, t.id, input());
  await rejects(addStream(db, owner, t.id, input()), "stream_exists");
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
  await addStream(db, owner, t.id, input({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "День 2", startsAt: tomorrow }));
  const matchLive = await addStream(db, owner, t.id, input({ url: "https://www.twitch.tv/maximus_match", match: m.id }));
  const vod = await addStream(db, owner, t.id, input({ url: "https://youtu.be/dQw4w9WgXcQ", kind: "vod", match: m.id, title: "Запись матча" }));
  const told = await db.query<{ user_id: string; data: Record<string, string> }>("select user_id, data from notifications where kind = 'match_streamed'");
  assert.deepEqual(told.map((n) => n.user_id).sort(), [p1.id, p2.id].sort(), "both players of the streamed match are told, once");
  assert.equal(told[0].data.matchId, m.id);
  assert.equal((await tournamentStreams(db, t.id)).length, 4);
  const forMatch = await matchStreams(db, m.id, t.id);
  assert.deepEqual(forMatch.match.map((s) => s.id).sort(), [matchLive.id, vod.id].sort());
  assert.equal(forMatch.event.length, 2);
  // A ready match due later (a later wave) is scheduled, not under way.
  const later = await mediaCentre(db);
  assert.deepEqual(later.live.map((s) => s.id), [event.id]);
  assert.deepEqual(later.upcoming.map((s) => s.title).sort(), ["Основной эфир", "День 2"].sort());
  await db.query("update matches set scheduled_at = now() where id = $1", [m.id]);
  const centre = await mediaCentre(db);
  assert.deepEqual(centre.live.map((s) => s.id).sort(), [event.id, matchLive.id].sort(), "under way: the event stream and the due match's stream");
  assert.deepEqual(centre.upcoming.map((s) => s.title), ["День 2"]);
  assert.deepEqual(centre.vods.map((s) => s.id), [vod.id]);
  assert.equal((await mediaCentre(db, "dota2")).live.length, 0, "the game filter applies");
  // A draft's streams are never public.
  const draft = await createTournament(db, owner, orgId, base());
  await addStream(db, owner, draft.id, input({ url: "https://www.twitch.tv/draft_cast" }));
  const all = await mediaCentre(db);
  assert.ok(![...all.live, ...all.upcoming, ...all.vods].some((s) => s.tournament_id === draft.id));
  // At most STREAM_LIMIT links per tournament.
  for (let i = (await tournamentStreams(db, t.id)).length; i < STREAM_LIMIT; i++)
    await db.query("insert into streams (tournament_id, kind, platform, url, rights_confirmed_by) values ($1, 'vod', 'other', $2, $3)", [t.id, `https://example.org/v/${i}`, owner.id]);
  await rejects(addStream(db, owner, t.id, input({ url: "https://www.twitch.tv/one_more" })), "stream_limit");
  // Managers remove links; so does portal moderation; nobody else.
  await rejects(removeStream(db, outsider, event.id), "forbidden");
  const moderator = await mk("st_mod");
  await db.query("insert into user_roles (user_id, role) values ($1, 'moderation')", [moderator.id]);
  await removeStream(db, (await sessionUser(db, tokens.get("st_mod")))!, event.id);
  await removeStream(db, owner, matchLive.id);
  assert.equal((await matchStreams(db, m.id, t.id)).match.length, 1);
  // A cancelled tournament takes no new links.
  await transition(db, owner, other.id, "CANCELLED");
  await rejects(addStream(db, owner, other.id, input()), "not_editable");
  const log = await db.query<{ action: string }>("select action from audit_log where action like 'stream.%' order by id");
  assert.ok(log.filter((r) => r.action === "stream.added").length >= 5 && log.filter((r) => r.action === "stream.removed").length === 2);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("overlay data comes from the match record: nothing, then the reported score, then the official one", async () => {
  const [a1, a2] = [await mk("ov_p1"), await mk("ov_p2")];
  const t = await createTournament(db, owner, orgId, base({ name: "Overlay Cup" }));
  const [none] = await db.query<{ id: string }>("select gen_random_uuid()::text as id");
  assert.equal(await overlayData(db, none.id), null);
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  await register(db, a1, t.id);
  await register(db, a2, t.id);
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const [m] = await db.query<{ id: string; a_user: string }>(
    "select m.id, r.user_id as a_user from matches m join registrations r on r.id = m.a_reg where m.tournament_id = $1 and m.b_reg is not null",
    [t.id],
  );
  const [sideA, sideB] = m.a_user === a1.id ? [a1, a2] : [a2, a1];
  const before = await overlayData(db, m.id);
  assert.deepEqual(before?.score, { a: null, b: null, state: "none" });
  assert.equal(before?.a, sideA.displayName);
  assert.equal(before?.bestOf, 1);
  await submitResult(db, sideA, m.id, { scoreA: 2, scoreB: 1, evidenceUrl: "", note: "" });
  assert.deepEqual((await overlayData(db, m.id))?.score, { a: 2, b: 1, state: "reported" });
  assert.equal((await overlayData(db, m.id))?.winner, null, "no winner before confirmation");
  await confirmResult(db, sideB, m.id);
  const after = await overlayData(db, m.id);
  assert.deepEqual(after?.score, { a: 2, b: 1, state: "official" });
  assert.equal(after?.winner, "a");
  // A draft's match has no public overlay.
  await db.query("update tournaments set status = 'DRAFT' where id = $1", [t.id]);
  assert.equal(await overlayData(db, m.id), null);
});
