/**
 * Progression and the earn-only coin economy.
 *
 * Coins and XP have no monetary value: they cannot be bought, sold, transferred, staked or cashed out.
 * They are credited only for real, confirmed activity and spent only on cosmetics and the premium pass
 * track. Every credit carries an idempotency key, so replays and retries never double-credit.
 */
import { randomInt } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import * as v from "./validate.ts";

export const XP = {
  matchWin: 50,
  matchPlayed: 20,
  place1: 300,
  place2: 200,
  place3: 120,
  participation: 60,
  leaderboardEntry: 10,
  challengeWin: 30,
  challengePlayed: 10,
} as const;

export const RANKS = [
  { key: "rookie", min: 0, ru: "Новичок", en: "Rookie" },
  { key: "bronze", min: 250, ru: "Бронза", en: "Bronze" },
  { key: "silver", min: 750, ru: "Серебро", en: "Silver" },
  { key: "gold", min: 1500, ru: "Золото", en: "Gold" },
  { key: "platinum", min: 3000, ru: "Платина", en: "Platinum" },
  { key: "diamond", min: 6000, ru: "Алмаз", en: "Diamond" },
  { key: "master", min: 10000, ru: "Мастер", en: "Master" },
  { key: "legend", min: 16000, ru: "Легенда", en: "Legend" },
] as const;
export type Rank = (typeof RANKS)[number];

export function rankFor(xp: number): { rank: Rank; next: Rank | null; progress: number } {
  let i = 0;
  while (i + 1 < RANKS.length && xp >= RANKS[i + 1].min) i++;
  const rank = RANKS[i];
  const next = RANKS[i + 1] ?? null;
  const progress = next ? Math.min(1, (xp - rank.min) / (next.min - rank.min)) : 1;
  return { rank, next, progress };
}

/** Grants XP to each user once per idempotency base. */
export async function grantXp(q: Queryable, userIds: string[], amount: number, reason: string, game: string, ref: string, idemBase: string) {
  if (amount <= 0) return;
  for (const userId of [...new Set(userIds)]) {
    await q.query(
      `insert into xp_events (user_id, amount, reason, game, ref, idem_key) values ($1,$2,$3,$4,$5,$6)
       on conflict (idem_key) do nothing`,
      [userId, amount, reason, game, ref, `${idemBase}:${userId}`],
    );
  }
  if (reason === "match_win" || reason === "match_played") await rewardReferrers(q, userIds);
}

/**
 * Credits (positive) or debits (negative) coins exactly once per idempotency key. Returns false when
 * the key was already used. Balances can never go negative.
 */
export async function moveCoins(q: Queryable | Database, userId: string, delta: number, reason: string, ref: string, idemKey: string): Promise<boolean> {
  // The wallet row lock must live inside a transaction; open one when called with the database itself.
  if (typeof (q as Database).tx === "function") return (q as Database).tx((t) => moveCoins(t, userId, delta, reason, ref, idemKey));
  if (!Number.isInteger(delta) || delta === 0) fail("invalid_input");
  await q.query("insert into wallets (user_id) values ($1) on conflict do nothing", [userId]);
  const [wallet] = await q.query<{ balance: number }>("select balance from wallets where user_id = $1 for update", [userId]);
  const [seen] = await q.query("select 1 from coin_ledger where idem_key = $1", [idemKey]);
  if (seen) return false;
  const after = (wallet?.balance ?? 0) + delta;
  if (after < 0) fail("insufficient_coins");
  await q.query(
    "insert into coin_ledger (user_id, delta, reason, ref, idem_key, balance_after) values ($1,$2,$3,$4,$5,$6)",
    [userId, delta, reason, ref, idemKey, after],
  );
  await q.query("update wallets set balance = $2, updated_at = now() where user_id = $1", [userId, after]);
  return true;
}

export async function balance(q: Queryable, userId: string): Promise<number> {
  const [w] = await q.query<{ balance: number }>("select balance from wallets where user_id = $1", [userId]);
  return w?.balance ?? 0;
}

export async function totalXp(q: Queryable, userId: string, since?: Date): Promise<number> {
  const [r] = await q.query<{ xp: number }>(
    "select coalesce(sum(amount), 0)::int as xp from xp_events where user_id = $1 and ($2::timestamptz is null or created_at >= $2)",
    [userId, since ? since.toISOString() : null],
  );
  return r?.xp ?? 0;
}

/**
 * The champion award is idempotent per champion registration, not per tournament: when an overturned
 * result changes the champion, the new champion is paid and nothing is clawed back from the previous one.
 */
export async function settleChampionAward(q: Queryable, tournamentId: string, championRegId: string) {
  const [t] = await q.query<{ prize_coins: number; name: string; slug: string }>(
    "select prize_coins, name, slug from tournaments where id = $1",
    [tournamentId],
  );
  if (!t || t.prize_coins <= 0) return;
  const inserted = await q.query(
    `insert into tournament_awards (tournament_id, registration_id, kind, coins) values ($1, $2, 'champion', $3)
     on conflict do nothing returning registration_id`,
    [tournamentId, championRegId, t.prize_coins],
  );
  if (!inserted.length) return;
  const members = await q.query<{ user_id: string }>("select user_id from roster_entries where registration_id = $1", [championRegId]);
  for (const m of members)
    await moveCoins(q, m.user_id, t.prize_coins, "champion_award", tournamentId, `award:${tournamentId}:${championRegId}:${m.user_id}`);
  await notify(q, members.map((m) => m.user_id), "award_received", { tournament: t.name, slug: t.slug, coins: t.prize_coins });
  await audit(q, { actorId: null, action: "tournament.award_paid", entity: "tournament", entityId: tournamentId, data: { registrationId: championRegId, coins: t.prize_coins } });
}

// ---------- Cosmetics ----------

export type Cosmetic = { id: string; color: string; price: number | null; source: "default" | "shop" | "pass" | "membership" };

export const COSMETICS: Cosmetic[] = [
  { id: "graphite", color: "#3a3a44", price: 0, source: "default" },
  { id: "slate", color: "#56607a", price: 0, source: "default" },
  { id: "violet", color: "#7c5cff", price: 200, source: "shop" },
  { id: "emerald", color: "#1f9d6b", price: 300, source: "shop" },
  { id: "amber", color: "#c98a12", price: 300, source: "shop" },
  { id: "crimson", color: "#c23a4b", price: 400, source: "shop" },
  { id: "azure", color: "#2f7fd8", price: 400, source: "shop" },
  { id: "ivory", color: "#d9d2c0", price: 600, source: "shop" },
  { id: "sunset", color: "#e0663a", price: null, source: "pass" },
  { id: "mint", color: "#3cc9a8", price: null, source: "pass" },
  { id: "neon", color: "#b8ff2e", price: null, source: "pass" },
  { id: "aurora", color: "#8a4dff", price: null, source: "pass" },
  { id: "gold", color: "#c8a24a", price: null, source: "membership" },
];
export const cosmeticById = (id: string) => COSMETICS.find((c) => c.id === id);
export const avatarColor = (id: string | null | undefined) => cosmeticById(id ?? "")?.color ?? null;

async function grantCosmetic(q: Queryable, userId: string, item: string, source: "shop" | "pass" | "objective" | "membership") {
  await q.query("insert into user_cosmetics (user_id, item, source) values ($1, $2, $3) on conflict do nothing", [userId, item, source]);
}

export async function ownedCosmetics(q: Queryable, userId: string): Promise<Set<string>> {
  const rows = await q.query<{ item: string }>("select item from user_cosmetics where user_id = $1", [userId]);
  const owned = new Set(rows.map((r) => r.item));
  for (const c of COSMETICS) if (c.source === "default") owned.add(c.id);
  if (await hasActiveMembership(q, userId)) for (const c of COSMETICS) if (c.source === "membership") owned.add(c.id);
  return owned;
}

export async function buyCosmetic(db: Database, user: SessionUser, itemInput: unknown) {
  const item = cosmeticById(String(itemInput ?? ""));
  if (!item || item.source !== "shop" || !item.price) fail("not_found");
  await db.tx(async (q) => {
    const [owned] = await q.query("select 1 from user_cosmetics where user_id = $1 and item = $2", [user.id, item!.id]);
    if (owned) fail("already_owned");
    await moveCoins(q, user.id, -item!.price!, "cosmetic_purchase", item!.id, `shop:${item!.id}:${user.id}`);
    await grantCosmetic(q, user.id, item!.id, "shop");
    await audit(q, { actorId: user.id, action: "cosmetic.bought", entity: "user", entityId: user.id, data: { item: item!.id, coins: item!.price } });
  });
}

export async function equipCosmetic(db: Database, user: SessionUser, itemInput: unknown) {
  const item = cosmeticById(String(itemInput ?? ""));
  if (!item) fail("not_found");
  if (!(await ownedCosmetics(db, user.id)).has(item!.id)) fail("not_owned");
  await db.query("update users set avatar_color = $2, updated_at = now() where id = $1", [user.id, item!.id]);
}

// ---------- Membership lookup (used by perks; billing owns the lifecycle) ----------

export async function hasActiveMembership(q: Queryable, userId: string): Promise<boolean> {
  const [m] = await q.query(
    "select 1 from memberships where user_id = $1 and status = 'active' and starts_at <= now() and (ends_at is null or ends_at > now()) limit 1",
    [userId],
  );
  return Boolean(m);
}

// ---------- Website Pass ----------

export const SEASON = {
  id: "s1",
  startsAt: new Date("2026-09-27T00:00:00Z"),
  tiers: 20,
  xpPerTier: 250,
  premiumPrice: 1500,
} as const;

export type PassReward = { coins?: number; cosmetic?: string } | null;

export function passReward(tier: number, track: "free" | "premium"): PassReward {
  if (tier < 1 || tier > SEASON.tiers) return null;
  if (track === "free") {
    if (tier === 10) return { cosmetic: "sunset" };
    if (tier === 20) return { cosmetic: "mint" };
    if (tier % 5 === 0) return { coins: 100 };
    if (tier % 2 === 0) return { coins: 50 };
    return null;
  }
  if (tier === 10) return { cosmetic: "neon" };
  if (tier === 20) return { cosmetic: "aurora" };
  return { coins: 60 };
}

/** Fixed 90-day seasons retain the original epoch and historical claim keys. */
export function currentSeason(now = new Date()) {
  const length = 90 * 86400_000;
  const index = Math.max(0, Math.floor((now.getTime() - SEASON.startsAt.getTime()) / length));
  const startsAt = new Date(SEASON.startsAt.getTime() + index * length);
  return { ...SEASON, id: `s${index + 1}`, startsAt, endsAt: new Date(startsAt.getTime() + length) };
}

export async function seasonXp(q: Queryable, userId: string, season = currentSeason()) {
  const [r] = await q.query<{ xp: number }>("select coalesce(sum(amount),0)::int as xp from xp_events where user_id=$1 and created_at >= $2 and created_at < $3", [userId, season.startsAt, season.endsAt]);
  return r.xp;
}

export async function premiumUnlocked(q: Queryable, userId: string, season = currentSeason()): Promise<"coins" | "membership" | null> {
  const SEASON = season;
  const [row] = await q.query<{ source: "coins" | "membership" }>("select source from pass_unlocks where user_id = $1 and season = $2", [userId, SEASON.id]);
  if (row) return row.source;
  return (await hasActiveMembership(q, userId)) ? "membership" : null;
}

export async function unlockPremium(db: Database, user: SessionUser) {
  const SEASON = currentSeason();
  await db.tx(async (q) => {
    const [row] = await q.query("select 1 from pass_unlocks where user_id = $1 and season = $2", [user.id, SEASON.id]);
    if (row) fail("already_owned");
    if (await hasActiveMembership(q, user.id)) fail("already_owned");
    await moveCoins(q, user.id, -SEASON.premiumPrice, "pass_premium", SEASON.id, `pass_unlock:${SEASON.id}:${user.id}`);
    await q.query("insert into pass_unlocks (user_id, season, source) values ($1, $2, 'coins')", [user.id, SEASON.id]);
    await audit(q, { actorId: user.id, action: "pass.premium_unlocked", entity: "user", entityId: user.id, data: { season: SEASON.id } });
  });
}

export async function claimPassTier(db: Database, user: SessionUser, tierInput: unknown, trackInput: unknown) {
  const SEASON = currentSeason();
  const tier = v.intIn(tierInput, 1, SEASON.tiers);
  const track = trackInput === "premium" ? "premium" : trackInput === "free" ? "free" : fail("invalid_input");
  const reward = passReward(tier, track);
  if (!reward) fail("not_found");
  await db.tx(async (q) => {
    const xp = await seasonXp(q, user.id, SEASON);
    if (xp < tier * SEASON.xpPerTier) fail("tier_locked");
    if (track === "premium" && !(await premiumUnlocked(q, user.id, SEASON))) fail("premium_locked");
    try {
      await q.query("insert into pass_claims (user_id, season, tier, track) values ($1, $2, $3, $4)", [user.id, SEASON.id, tier, track]);
    } catch (error) {
      if (isUniqueViolation(error)) fail("already_claimed");
      throw error;
    }
    if (reward!.coins) await moveCoins(q, user.id, reward!.coins, "pass_reward", `${SEASON.id}:${tier}:${track}`, `pass:${SEASON.id}:${tier}:${track}:${user.id}`);
    if (reward!.cosmetic) await grantCosmetic(q, user.id, reward!.cosmetic, "pass");
  });
}

// ---------- Objectives: evaluated live against real account state ----------

type Objective = {
  id: string;
  coins: number;
  xp: number;
  achieved: (q: Queryable, userId: string) => Promise<boolean>;
};

const exists = async (q: Queryable, sql: string, params: unknown[]) => Boolean((await q.query(sql, params))[0]);

export const OBJECTIVES: Objective[] = [
  { id: "profile_country", coins: 30, xp: 0, achieved: (q, u) => exists(q, "select 1 from users where id = $1 and country_code is not null", [u]) },
  { id: "verify_email", coins: 50, xp: 0, achieved: (q, u) => exists(q, "select 1 from users where id = $1 and email_verified_at is not null", [u]) },
  { id: "link_game", coins: 50, xp: 0, achieved: (q, u) => exists(q, "select 1 from linked_game_accounts where user_id = $1", [u]) },
  { id: "join_team", coins: 50, xp: 0, achieved: (q, u) => exists(q, "select 1 from team_members where user_id = $1", [u]) },
  {
    id: "first_registration",
    coins: 100,
    xp: 50,
    achieved: (q, u) => exists(q, "select 1 from roster_entries re join registrations r on r.id = re.registration_id where re.user_id = $1 and r.status in ('registered','disqualified','not_checked_in')", [u]),
  },
  {
    id: "first_match",
    coins: 100,
    xp: 50,
    achieved: (q, u) =>
      exists(q, `select 1 from matches m join roster_entries re on re.registration_id in (m.a_reg, m.b_reg)
                  where re.user_id = $1 and m.status = 'completed' and m.outcome in ('played','decision')`, [u]),
  },
  {
    id: "first_win",
    coins: 150,
    xp: 0,
    achieved: (q, u) =>
      exists(q, `select 1 from matches m join roster_entries re on re.registration_id = m.winner_reg
                  where re.user_id = $1 and m.status = 'completed' and m.outcome in ('played','decision')`, [u]),
  },
  {
    id: "first_challenge",
    coins: 80,
    xp: 0,
    achieved: (q, u) => exists(q, "select 1 from challenges where status = 'completed' and (challenger_id = $1 or opponent_id = $1)", [u]),
  },
  {
    id: "podium",
    coins: 300,
    xp: 0,
    achieved: (q, u) =>
      exists(q, `select 1 from roster_entries re join registrations r on r.id = re.registration_id join tournaments t on t.id = r.tournament_id
                  where re.user_id = $1 and t.status = 'COMPLETED' and r.placement between 1 and 3`, [u]),
  },
  { id: "rank_bronze", coins: 100, xp: 0, achieved: async (q, u) => (await totalXp(q, u)) >= 250 },
  { id: "rank_silver", coins: 200, xp: 0, achieved: async (q, u) => (await totalXp(q, u)) >= 750 },
  { id: "rank_gold", coins: 400, xp: 0, achieved: async (q, u) => (await totalXp(q, u)) >= 1500 },
];

export async function objectiveStates(q: Queryable, userId: string) {
  const claimed = new Set((await q.query<{ objective: string }>("select objective from objective_claims where user_id = $1", [userId])).map((r) => r.objective));
  const out: Array<{ id: string; coins: number; xp: number; achieved: boolean; claimed: boolean }> = [];
  for (const o of OBJECTIVES) out.push({ id: o.id, coins: o.coins, xp: o.xp, claimed: claimed.has(o.id), achieved: claimed.has(o.id) || (await o.achieved(q, userId)) });
  return out;
}

export async function claimObjective(db: Database, user: SessionUser, idInput: unknown) {
  const objective = OBJECTIVES.find((o) => o.id === idInput);
  if (!objective) fail("not_found");
  await db.tx(async (q) => {
    if (!(await objective!.achieved(q, user.id))) fail("objective_incomplete");
    try {
      await q.query("insert into objective_claims (user_id, objective) values ($1, $2)", [user.id, objective!.id]);
    } catch (error) {
      if (isUniqueViolation(error)) fail("already_claimed");
      throw error;
    }
    if (objective!.coins) await moveCoins(q, user.id, objective!.coins, "objective", objective!.id, `objective:${objective!.id}:${user.id}`);
    if (objective!.xp) await grantXp(q, [user.id], objective!.xp, "objective", "", objective!.id, `objective:${objective!.id}`);
  });
}

// ---------- Referrals ----------

export const REFERRAL = { refereeBonus: 100, referrerBonus: 100, windowDays: 14, referrerCap: 20 } as const;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export async function referralCode(q: Queryable, userId: string): Promise<string> {
  const [row] = await q.query<{ referral_code: string | null }>("select referral_code from users where id = $1", [userId]);
  if (row?.referral_code) return row.referral_code;
  for (let i = 0; i < 8; i++) {
    const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    try {
      const updated = await q.query<{ referral_code: string }>(
        "update users set referral_code = coalesce(referral_code, $2) where id = $1 returning referral_code",
        [userId, code],
      );
      return updated[0].referral_code;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return fail("server_error");
}

export async function redeemReferral(db: Database, user: SessionUser, codeInput: unknown) {
  const code = v.oneLine(codeInput, 20).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 8) fail("invalid_referral");
  await db.tx(async (q) => {
    const [me] = await q.query<{ created_at: Date }>("select created_at from users where id = $1 for update", [user.id]);
    if (Date.now() - new Date(me.created_at).getTime() > REFERRAL.windowDays * 86400_000) fail("referral_window_closed");
    const [referrer] = await q.query<{ id: string }>("select id from users where referral_code = $1 and status = 'active'", [code]);
    if (!referrer) fail("invalid_referral");
    if (referrer.id === user.id) fail("invalid_referral");
    try {
      await q.query("insert into referral_redemptions (referee_id, referrer_id, code) values ($1, $2, $3)", [user.id, referrer.id, code]);
    } catch (error) {
      if (isUniqueViolation(error)) fail("already_claimed");
      throw error;
    }
    await moveCoins(q, user.id, REFERRAL.refereeBonus, "referral_bonus", referrer.id, `referral:referee:${user.id}`);
    await audit(q, { actorId: user.id, action: "referral.redeemed", entity: "user", entityId: user.id, data: { referrerId: referrer.id } });
  });
}

/** The referrer is rewarded only once the referred player has completed a real, confirmed match. */
async function rewardReferrers(q: Queryable, userIds: string[]) {
  if (!userIds.length) return;
  const rows = await q.query<{ referee_id: string; referrer_id: string }>(
    `select referee_id, referrer_id from referral_redemptions where referee_id = any($1) and referrer_rewarded_at is null for update`,
    [userIds],
  );
  for (const r of rows) {
    const [count] = await q.query<{ n: number }>(
      "select count(*)::int as n from referral_redemptions where referrer_id = $1 and referrer_rewarded_at is not null",
      [r.referrer_id],
    );
    await q.query("update referral_redemptions set referrer_rewarded_at = now() where referee_id = $1", [r.referee_id]);
    if ((count?.n ?? 0) >= REFERRAL.referrerCap) continue;
    await moveCoins(q, r.referrer_id, REFERRAL.referrerBonus, "referral_reward", r.referee_id, `referral:referrer:${r.referee_id}`);
    await notify(q, [r.referrer_id], "referral_reward", { coins: REFERRAL.referrerBonus });
  }
}

export async function coinHistory(q: Queryable, userId: string, limit = 50) {
  return q.query<{ id: string; delta: number; reason: string; ref: string; balance_after: number; created_at: Date }>(
    "select id::text, delta, reason, ref, balance_after, created_at from coin_ledger where user_id = $1 order by coin_ledger.id desc limit $2",
    [userId, limit],
  );
}
