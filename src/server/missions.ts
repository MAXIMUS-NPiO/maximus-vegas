import { createHash, randomBytes } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { fail } from "./errors.ts";
import * as v from "./validate.ts";
import { isGame } from "../lib/games.ts";
import { activeAccount, manageVenue } from "./product-access.ts";
import { currentSeason, grantXp, moveCoins, seasonXp } from "./progression.ts";
import { seal, unseal } from "./secret-box.ts";
import { audit } from "./audit.ts";

export const MISSIONS = [
  { id: "daily_play", period: "day", target: 1, coins: 15, xp: 10, ru: "Сыграйте подтверждённый матч", en: "Play a confirmed match" },
  { id: "weekly_play", period: "week", target: 5, coins: 70, xp: 50, ru: "Сыграйте 5 подтверждённых матчей", en: "Play 5 confirmed matches" },
  { id: "weekly_visit", period: "week", target: 1, coins: 30, xp: 25, ru: "Посетите подтверждённую площадку", en: "Check in at a verified venue" },
  { id: "season_play", period: "season", target: 30, coins: 250, xp: 200, ru: "Сыграйте 30 матчей за сезон", en: "Play 30 matches this season" },
] as const;

export function missionWindow(period: string, now: Date) {
  if (period === "season") { const s = currentSeason(now); return { start: s.startsAt, end: s.endsAt }; }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "week") start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  return { start, end: new Date(start.getTime() + (period === "week" ? 7 : 1) * 86400_000) };
}
type Assignment = { mission: string; window_start: Date; window_end: Date; game: string; target: number; coins: number; xp: number; claimed_at: Date | null };

export async function setMissionPreference(db: Database, user: SessionUser, game: string) {
  if (game && !isGame(game)) fail("invalid_game");
  await activeAccount(db, user);
  // Existing assignments keep their original game; editing a preference cannot reset progress or claim keys.
  await db.query("insert into mission_preferences(user_id,game) values($1,$2) on conflict(user_id) do update set game=excluded.game,updated_at=now()", [user.id, game]);
}
async function assignments(q: Queryable, userId: string, now: Date) {
  const [p] = await q.query<{ game: string }>("select game from mission_preferences where user_id=$1", [userId]);
  for (const m of MISSIONS) {
    const w = missionWindow(m.period, now);
    await q.query(`insert into mission_assignments(user_id,mission,window_start,window_end,game,target,coins,xp) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
      [userId, m.id, w.start, w.end, m.id === "weekly_visit" ? "" : p?.game ?? "", m.target, m.coins, m.xp]);
  }
  return q.query<Assignment>("select * from mission_assignments where user_id=$1 and window_start <= $2 and window_end > $2 order by window_end,mission", [userId, now]);
}
async function progress(q: Queryable, userId: string, a: Assignment) {
  const [r] = a.mission === "weekly_visit"
    ? await q.query<{ n: number }>("select count(distinct venue_id)::int as n from venue_passes where user_id=$1 and status='used' and used_at >= $2 and used_at < $3", [userId, a.window_start, a.window_end])
    : await q.query<{ n: number }>(`select count(distinct ref)::int as n from xp_events where user_id=$1 and reason in ('match_win','match_played')
        and created_at >= $2 and created_at < $3 and ($4='' or game=$4)`, [userId, a.window_start, a.window_end, a.game]);
  return Math.min(a.target, r.n);
}
export async function missionStates(db: Database, userId: string, now = new Date()) {
  return db.tx(async q => {
    const rows = await assignments(q, userId, now);
    return Promise.all(rows.map(async a => ({ ...a, progress: a.claimed_at ? a.target : await progress(q, userId, a) })));
  });
}
export async function claimMission(db: Database, user: SessionUser, mission: string, now = new Date()) {
  if (!MISSIONS.some(m => m.id === mission)) fail("not_found");
  await db.tx(async q => {
    await activeAccount(q, user);
    await assignments(q, user.id, now);
    const [a] = await q.query<Assignment>("select * from mission_assignments where user_id=$1 and mission=$2 and window_start <= $3 and window_end > $3 for update", [user.id, mission, now]);
    if (!a) fail("objective_incomplete");
    if (a.claimed_at) fail("already_claimed");
    if (await progress(q, user.id, a) < a.target) fail("objective_incomplete");
    const key = `mission:${mission}:${new Date(a.window_start).toISOString()}:${user.id}`;
    await moveCoins(q, user.id, a.coins, "mission", mission, key);
    await grantXp(q, [user.id], a.xp, "mission", a.game, mission, key);
    await q.query("update mission_assignments set claimed_at=$4 where user_id=$1 and mission=$2 and window_start=$3", [user.id, mission, a.window_start, now]);
  });
}
export async function missionHistory(q: Queryable, userId: string) {
  return q.query<Assignment>("select * from mission_assignments where user_id=$1 and claimed_at is not null order by claimed_at desc limit 40", [userId]);
}

/** Partner-funded gifts have a fixed inventory; they never redeem or sell earned coins. */
export async function createPassReward(db: Database, user: SessionUser, venueId: string, input: Record<string, unknown>) {
  const title = v.displayName(input.title, 100), description = v.clean(input.description, 1000);
  if (description.length < 10) fail("invalid_input");
  const tier = v.intIn(input.tier, 1, 20), quantity = v.intIn(input.quantity, 1, 10000);
  return db.tx(async q => {
    await activeAccount(q, user); await manageVenue(q, user, venueId, true);
    const [r] = await q.query<{ id: string }>("insert into pass_rewards(venue_id,title,description,season,tier,quantity,created_by) values($1,$2,$3,$4,$5,$6,$7) returning id", [venueId, title, description, currentSeason().id, tier, quantity, user.id]);
    await audit(q, { actorId: user.id, action: "pass.reward_created", entity: "pass_reward", entityId: r.id, data: { quantity, tier } });
    return r.id;
  });
}
export async function reservePassReward(db: Database, user: SessionUser, rewardId: string) {
  return db.tx(async q => {
    await activeAccount(q, user);
    const [r] = await q.query<{ tier: number; quantity: number; season: string; active: boolean; status: string }>("select r.*,v.status from pass_rewards r join venues v on v.id=r.venue_id where r.id=$1 for update of r", [rewardId]);
    if (!r || !r.active || r.status !== "confirmed" || r.season !== currentSeason().id) fail("offer_unavailable");
    const [old] = await q.query("select 1 from pass_reward_claims where reward_id=$1 and user_id=$2", [rewardId, user.id]);
    if (old) fail("already_claimed");
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from pass_reward_claims where reward_id=$1 and status<>'cancelled'", [rewardId]);
    if (n.n >= r.quantity) fail("offer_unavailable");
    if (await seasonXp(q, user.id) < r.tier * currentSeason().xpPerTier) fail("tier_locked");
    const code = randomBytes(16).toString("hex");
    const [claim] = await q.query<{ id: string }>("insert into pass_reward_claims(reward_id,user_id,collection_hash,collection_sealed) values($1,$2,$3,$4) returning id", [rewardId, user.id, createHash("sha256").update(code).digest("hex"), JSON.stringify(seal("reward", code))]);
    return claim.id;
  });
}
export async function fulfilPassReward(db: Database, user: SessionUser, claimId: string, code: string) {
  await db.tx(async q => {
    const [r] = await q.query<{ venue_id: string; status: string; collection_hash: string }>("select r.venue_id,c.status,c.collection_hash from pass_reward_claims c join pass_rewards r on r.id=c.reward_id where c.id=$1 for update of c", [claimId]);
    if (!r) fail("not_found");
    await activeAccount(q, user); await manageVenue(q, user, r.venue_id, true);
    if (r.status !== "reserved") fail("invalid_transition");
    if (createHash("sha256").update(code.trim()).digest("hex") !== r.collection_hash) fail("token_invalid");
    await q.query("update pass_reward_claims set status='collected',collected_at=now(),collected_by=$2,collection_sealed='' where id=$1", [claimId, user.id]);
    await audit(q, { actorId: user.id, action: "pass.reward_collected", entity: "pass_reward_claim", entityId: claimId });
  });
}
export async function setPassRewardActive(db: Database, user: SessionUser, rewardId: string, active: boolean) {
  await db.tx(async q => {
    const [reward] = await q.query<{ venue_id: string }>("select venue_id from pass_rewards where id=$1 for update", [rewardId]);
    if (!reward) fail("not_found");
    await activeAccount(q, user); await manageVenue(q, user, reward.venue_id, active);
    await q.query("update pass_rewards set active=$2 where id=$1", [rewardId, active]);
    await audit(q, { actorId: user.id, action: "pass.reward_availability", entity: "pass_reward", entityId: rewardId, data: { active } });
  });
}
export async function cancelPassReward(db: Database, user: SessionUser, claimId: string) {
  await db.tx(async q => {
    const [claim] = await q.query<{ user_id: string; venue_id: string; status: string }>("select c.user_id,r.venue_id,c.status from pass_reward_claims c join pass_rewards r on r.id=c.reward_id where c.id=$1 for update of c", [claimId]);
    if (!claim) fail("not_found");
    if (claim.user_id !== user.id) await manageVenue(q, user, claim.venue_id);
    if (claim.status === "cancelled") return;
    if (claim.status !== "reserved") fail("invalid_transition");
    await q.query("update pass_reward_claims set status='cancelled',collection_sealed='' where id=$1", [claimId]);
    await audit(q, { actorId: user.id, action: "pass.reward_cancelled", entity: "pass_reward_claim", entityId: claimId });
  });
}
export async function rewardCatalogue(q: Queryable, userId: string) {
  const rewards = await q.query<{ id: string; title: string; description: string; tier: number; venue: string; slug: string; city: string; remaining: number }>(`select r.id,r.title,r.description,r.tier,v.name as venue,v.slug,v.city,
    (r.quantity-(select count(*) from pass_reward_claims c where c.reward_id=r.id and c.status<>'cancelled'))::int as remaining
    from pass_rewards r join venues v on v.id=r.venue_id where r.active and r.season=$1 and v.status='confirmed' order by r.created_at desc limit 100`, [currentSeason().id]);
  const claims = await q.query<{ id: string; reward_id: string; title: string; venue: string; status: string; collection_sealed: string }>("select c.id,c.reward_id,c.status,c.collection_sealed,r.title,v.name as venue from pass_reward_claims c join pass_rewards r on r.id=c.reward_id join venues v on v.id=r.venue_id where c.user_id=$1 order by c.claimed_at desc limit 100", [userId]);
  return { rewards, claims: claims.map(({ collection_sealed, ...c }) => {
    const s = collection_sealed ? JSON.parse(collection_sealed) : null;
    return { ...c, code: s && c.status === "reserved" ? unseal("reward", s.value, s.scheme) : null };
  }) };
}
