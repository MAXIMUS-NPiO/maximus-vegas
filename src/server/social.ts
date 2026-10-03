/** Opt-in discovery. No public-profile or scouting data is repurposed for dating. */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { activeAccount } from "./product-access.ts";
import { requireSection } from "./access.ts";
import { fail } from "./errors.ts";
import { audit } from "./audit.ts";
import * as v from "./validate.ts";
import { isGame } from "../lib/games.ts";

export const SOCIAL_CONSENT = "MV-DISCOVERY-1";
export type SocialProfile = { user_id: string; visible: boolean; intent: string; age: number; city: string; game: string; languages: string; gaming_preferences: string; relationship_preferences: string; bio: string; display_name: string; username: string };
const uuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
async function lockPair(q: Queryable, a: string, b: string) {
  if (!uuid(a) || !uuid(b) || a === b) fail("invalid_input");
  // Every pair mutation takes the same ordered locks: concurrent reciprocal likes/block/withdraw are safe.
  return q.query<{ id: string; status: string }>("select id,status from users where id=any($1::uuid[]) order by id for update", [[a, b].sort()]);
}
const blocked = async (q: Queryable, a: string, b: string) => Boolean((await q.query("select 1 from social_blocks where (user_id=$1 and subject_id=$2) or (user_id=$2 and subject_id=$1)", [a, b]))[0]);
export async function socialProfile(q: Queryable, userId: string) {
  return (await q.query<SocialProfile>("select p.*,u.display_name,u.username from social_profiles p join users u on u.id=p.user_id where p.user_id=$1", [userId]))[0] ?? null;
}
export async function saveSocialProfile(db: Database, user: SessionUser, input: Record<string, unknown>) {
  if (!v.bool(input.consent)) fail("consent_required");
  const intent = v.oneLine(input.intent, 20);
  if (!["gaming", "friendship", "dating"].includes(intent)) fail("invalid_input");
  const game = v.oneLine(input.game, 40);
  if (game && !isGame(game)) fail("invalid_game");
  const age = v.intIn(input.age, 18, 100), bio = v.clean(input.bio, 600);
  if (bio.length < 10) fail("invalid_input");
  await db.tx(async q => {
    await q.query("select id from users where id=$1 for update", [user.id]);
    await activeAccount(q, user);
    if ((await q.query("select 1 from social_profiles where user_id=$1 and suspended", [user.id]))[0]) fail("account_restricted");
    await q.query(`insert into social_profiles(user_id,visible,intent,age,city,game,languages,gaming_preferences,relationship_preferences,bio,consent_version)
      values($1,true,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(user_id) do update set visible=true,intent=excluded.intent,age=excluded.age,
      city=excluded.city,game=excluded.game,languages=excluded.languages,gaming_preferences=excluded.gaming_preferences,
      relationship_preferences=excluded.relationship_preferences,bio=excluded.bio,consent_version=excluded.consent_version,consented_at=now(),updated_at=now()`,
      [user.id, intent, age, v.oneLine(input.city, 80), game, v.oneLine(input.languages, 100), v.clean(input.gamingPreferences, 400), v.clean(input.relationshipPreferences, 400), bio, SOCIAL_CONSENT]);
    await audit(q, { actorId: user.id, action: "social.consent_granted", entity: "user", entityId: user.id, data: { version: SOCIAL_CONSENT } });
  });
}
export async function withdrawSocialProfile(db: Database, user: SessionUser) {
  await db.tx(async q => {
    await q.query("select id from users where id=$1 for update", [user.id]);
    await q.query("update social_profiles set visible=false,updated_at=now() where user_id=$1", [user.id]);
    await q.query("delete from social_likes where sender_id=$1 or recipient_id=$1", [user.id]);
    await q.query("update social_matches set status='closed' where user_a=$1 or user_b=$1", [user.id]);
    await audit(q, { actorId: user.id, action: "social.consent_withdrawn", entity: "user", entityId: user.id });
  });
}
export async function discover(q: Queryable, user: SessionUser, filters: Record<string, string> = {}) {
  await activeAccount(q, user);
  const me = await socialProfile(q, user.id);
  if (!me?.visible) return [];
  const minAge = v.intIn(filters.minAge || "18", 18, 100), maxAge = v.intIn(filters.maxAge || "100", minAge, 100);
  return q.query<SocialProfile>(`select p.user_id,p.intent,p.age,p.city,p.game,p.languages,p.gaming_preferences,p.relationship_preferences,p.bio,u.display_name,u.username
    from social_profiles p join users u on u.id=p.user_id
    where p.visible and u.status='active' and p.user_id<>$1 and p.intent=$2 and p.age between $3 and $4
      and ($5='' or p.city ilike $5) and ($6='' or p.game=$6)
      and not exists(select 1 from social_blocks b where (b.user_id=$1 and b.subject_id=p.user_id) or (b.subject_id=$1 and b.user_id=p.user_id))
      and not exists(select 1 from social_likes l where l.sender_id=$1 and l.recipient_id=p.user_id)
      and not exists(select 1 from social_matches m where m.status='active' and $1 in(m.user_a,m.user_b) and p.user_id in(m.user_a,m.user_b))
    order by p.updated_at desc,p.user_id limit 40`, [user.id, me.intent, minAge, maxAge, v.oneLine(filters.city, 80), v.oneLine(filters.game, 40)]);
}
export async function likeProfile(db: Database, user: SessionUser, otherId: string) {
  return db.tx(async q => {
    const users = await lockPair(q, user.id, otherId); await activeAccount(q, user);
    if (users.length !== 2 || users.some(u => u.status !== "active") || await blocked(q, user.id, otherId)) fail("not_found");
    const profiles = await q.query<{ intent: string }>("select intent from social_profiles where user_id=any($1::uuid[]) and visible", [[user.id, otherId]]);
    if (profiles.length !== 2 || profiles[0].intent !== profiles[1].intent) fail("consent_required");
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from social_likes where sender_id=$1 and created_at>now()-interval '1 day'", [user.id]);
    if (n.n >= 50) fail("request_limit");
    await q.query("insert into social_likes(sender_id,recipient_id) values($1,$2) on conflict do nothing", [user.id, otherId]);
    if (!(await q.query("select 1 from social_likes where sender_id=$1 and recipient_id=$2", [otherId, user.id]))[0]) return null;
    const [a, b] = [user.id, otherId].sort();
    const [m] = await q.query<{ id: string }>(`insert into social_matches(user_a,user_b) values($1,$2) on conflict(user_a,user_b)
      do update set status='active' returning id`, [a, b]);
    return m.id;
  });
}
export async function myMatches(q: Queryable, userId: string) {
  return q.query<{ id: string; status: string; other_id: string; display_name: string; unread: number }>(`select m.id,m.status,u.id as other_id,u.display_name,
    (select count(*)::int from social_messages s where s.match_id=m.id and s.sender_id<>$1 and s.created_at>coalesce(case when m.user_a=$1 then m.read_a else m.read_b end,'epoch')) as unread
    from social_matches m join users u on u.id=case when m.user_a=$1 then m.user_b else m.user_a end
    where $1 in(m.user_a,m.user_b) order by m.created_at desc limit 100`, [userId]);
}
async function matchFor(q: Queryable, userId: string, matchId: string, lock = false) {
  const [m] = await q.query<{ id: string; user_a: string; user_b: string; status: string }>(`select * from social_matches where id=$1 and $2 in(user_a,user_b) ${lock ? "for update" : ""}`, [matchId, userId]);
  if (!m) fail("not_found"); return m;
}
export async function conversation(db: Database, user: SessionUser, matchId: string, before = 0) {
  return db.tx(async q => {
    const m = await matchFor(q, user.id, matchId);
    const messages = await q.query<{ id: string; sender_id: string; body: string; created_at: Date }>("select id,sender_id,body,created_at from social_messages where match_id=$1 and ($2::bigint=0 or id<$2) order by id desc limit 50", [matchId, before]);
    await q.query(`update social_matches set ${m.user_a === user.id ? "read_a" : "read_b"}=now() where id=$1`, [matchId]);
    return { match: m, messages: messages.reverse() };
  });
}
export async function sendSocialMessage(db: Database, user: SessionUser, matchId: string, bodyInput: unknown, clientId: string) {
  const body = v.clean(bodyInput, 1001);
  if (!body || body.length > 1000 || !uuid(clientId)) fail("invalid_input");
  return db.tx(async q => {
    const initial = await matchFor(q, user.id, matchId);
    await lockPair(q, initial.user_a, initial.user_b); await activeAccount(q, user);
    const m = await matchFor(q, user.id, matchId, true);
    if (m.status !== "active" || await blocked(q, m.user_a, m.user_b)) fail("request_state");
    const [count] = await q.query<{ n: number }>("select count(*)::int as n from social_profiles p join users u on u.id=p.user_id where p.user_id=any($1::uuid[]) and p.visible and u.status='active'", [[m.user_a, m.user_b]]);
    if (count.n !== 2) fail("consent_required");
    const [old] = await q.query<{ id: string }>("select id from social_messages where sender_id=$1 and client_id=$2", [user.id, clientId]);
    if (old) return old.id;
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from social_messages where sender_id=$1 and created_at>now()-interval '1 minute'", [user.id]);
    if (n.n >= 10) fail("request_limit");
    const [r] = await q.query<{ id: string }>("insert into social_messages(match_id,sender_id,body,client_id) values($1,$2,$3,$4) returning id", [matchId, user.id, body, clientId]);
    return r.id;
  });
}
export async function closeMatch(db: Database, user: SessionUser, matchId: string) {
  await db.tx(async q => {
    const m = await matchFor(q, user.id, matchId);
    await lockPair(q, m.user_a, m.user_b);
    await q.query("update social_matches set status='closed' where id=$1", [matchId]);
    await q.query("delete from social_likes where (sender_id=$1 and recipient_id=$2) or (sender_id=$2 and recipient_id=$1)", [m.user_a, m.user_b]);
  });
}
async function block(q: Queryable, userId: string, subjectId: string) {
  await q.query("insert into social_blocks(user_id,subject_id) values($1,$2) on conflict do nothing", [userId, subjectId]);
  await q.query("delete from social_likes where (sender_id=$1 and recipient_id=$2) or (sender_id=$2 and recipient_id=$1)", [userId, subjectId]);
  await q.query("update social_matches set status='closed' where $1 in(user_a,user_b) and $2 in(user_a,user_b)", [userId, subjectId]);
}
export async function blockProfile(db: Database, user: SessionUser, subjectId: string, unblock = false) {
  await db.tx(async q => {
    const rows = await lockPair(q, user.id, subjectId); if (rows.length !== 2) fail("not_found");
    if (unblock) await q.query("delete from social_blocks where user_id=$1 and subject_id=$2", [user.id, subjectId]);
    else await block(q, user.id, subjectId);
  });
}
export async function reportSocialProfile(db: Database, user: SessionUser, subjectId: string, reasonInput: unknown, messageId: string) {
  const reason = v.clean(reasonInput, 1200); if (reason.length < 10) fail("invalid_input");
  await db.tx(async q => {
    const users = await lockPair(q, user.id, subjectId); if (users.length !== 2) fail("not_found");
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from social_reports where reporter_id=$1 and created_at>now()-interval '1 day'", [user.id]);
    if (n.n >= 10) fail("report_limit");
    let excerpt = "";
    if (messageId) {
      if (!/^\d+$/.test(messageId)) fail("invalid_input");
      const [m] = await q.query<{ body: string }>("select s.body from social_messages s join social_matches m on m.id=s.match_id where s.id=$1 and s.sender_id=$2 and $3 in(m.user_a,m.user_b)", [messageId, subjectId, user.id]);
      if (!m) fail("not_found"); excerpt = m.body;
    }
    await q.query("insert into social_reports(reporter_id,subject_id,reason,message_id,excerpt) values($1,$2,$3,$4,$5)", [user.id, subjectId, reason, messageId || null, excerpt]);
    await block(q, user.id, subjectId);
  });
}
export async function socialReports(q: Queryable, user: SessionUser) {
  requireSection(user, "conduct");
  return q.query<{ id: string; subject_id: string; subject: string; reporter: string; reason: string; excerpt: string; status: string }>("select r.id,r.subject_id,r.reason,r.excerpt,r.status,s.username as subject,u.username as reporter from social_reports r join users s on s.id=r.subject_id join users u on u.id=r.reporter_id where r.status='open' order by r.created_at limit 100");
}
export async function resolveSocialReport(db: Database, user: SessionUser, reportId: string, decision: string, hide: boolean) {
  requireSection(user, "conduct"); if (decision.trim().length < 10) fail("invalid_input");
  await db.tx(async q => {
    const [r] = await q.query<{ subject_id: string; reporter_id: string; status: string }>("select subject_id,reporter_id,status from social_reports where id=$1 for update", [reportId]);
    if (!r || r.status !== "open") fail("request_state");
    if ([r.subject_id, r.reporter_id].includes(user.id)) fail("forbidden");
    await q.query("update social_reports set status='resolved',decision=$2,decided_by=$3,decided_at=now() where id=$1", [reportId, v.clean(decision, 1000), user.id]);
    if (hide) {
      await q.query("update social_profiles set visible=false,suspended=true where user_id=$1", [r.subject_id]);
      await q.query("update social_matches set status='closed' where $1 in(user_a,user_b)", [r.subject_id]);
    }
    await audit(q, { actorId: user.id, action: "social.report_resolved", entity: "social_report", entityId: reportId, data: { hidden: hide } });
  });
}
export async function socialExport(q: Queryable, userId: string) {
  return {
    profile: await socialProfile(q, userId),
    likes: await q.query("select recipient_id,created_at from social_likes where sender_id=$1", [userId]),
    matches: await myMatches(q, userId),
    messages: await q.query("select id,match_id,body,created_at from social_messages where sender_id=$1 order by id", [userId]),
    blocks: await q.query("select subject_id,created_at from social_blocks where user_id=$1", [userId]),
    reports: await q.query("select subject_id,reason,excerpt,status,decision,created_at from social_reports where reporter_id=$1", [userId]),
  };
}
export async function eraseSocial(q: Queryable, userId: string) {
  await q.query("delete from social_profiles where user_id=$1", [userId]);
  await q.query("delete from social_likes where sender_id=$1 or recipient_id=$1", [userId]);
  await q.query("delete from social_blocks where user_id=$1 or subject_id=$1", [userId]);
  await q.query("delete from social_messages where sender_id=$1", [userId]);
  await q.query("update social_matches set status='closed' where $1 in(user_a,user_b)", [userId]);
  await q.query("update social_reports set reason='',excerpt='',decision='' where reporter_id=$1 or subject_id=$1", [userId]);
}
