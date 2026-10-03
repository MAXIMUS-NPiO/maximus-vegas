import { arbitrationExport, eraseMarketData } from "./arbitration.ts";
import { socialExport, eraseSocial } from "./social.ts";
import { eraseClubhouse } from "./clubhouse.ts";
import { eraseP2p } from "./p2p.ts";
import { listingDrafts, myMarketOrders } from "./marketplace.ts";
import { checkReservedName, claimReservedName } from "./username-reservations.ts";
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Database, Queryable } from "./db.ts";
import { audit } from "./audit.ts";
import { DomainError, fail, isUniqueViolation } from "./errors.ts";
import * as v from "./validate.ts";
import { clanExport, eraseClanData, ownedClansWithMembers } from "./clans.ts";
import { passExport, revokePassesOf } from "./venues.ts";
import type { StaffRole } from "./staff-roles.ts";
import { eraseMessageData, messageExport } from "./messages.ts";
import { academyExport, eraseAcademyData } from "./academy.ts";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_DAYS = 30;
export const SESSION_COOKIE = "mv_session";

export type Role = StaffRole;
export type SessionUser = {
  id: string;
  email: string;
  username: string;
  displayName: string;
  roles: Role[];
  sessionId: string;
  emailVerified?: boolean;
  /** When this session last passed the second factor (staff only). */
  mfaAt?: Date | null;
  avatarColor?: string;
  onboarded?: boolean;
  /** A live suspension sanction: the account reads and appeals, every other action is refused. */
  restricted?: boolean;
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const DUMMY_HASH =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export async function createSession(q: Queryable, userId: string, userAgent: string) {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await q.query(
    "insert into sessions (id, user_id, expires_at, user_agent) values ($1, $2, $3, $4)",
    [sha256(token), userId, expires.toISOString(), v.oneLine(userAgent, 200)],
  );
  return { token, expires };
}

async function limited(q: Queryable, keys: string[]): Promise<boolean> {
  const [row] = await q.query<{ n: number }>(
    "select count(*)::int as n from auth_attempts where key = any($1) and ok = false and at > now() - interval '15 minutes'",
    [keys],
  );
  return (row?.n ?? 0) >= 8;
}

export type SignUpInput = {
  reservation?: unknown;
  email: unknown;
  username: unknown;
  displayName: unknown;
  password: unknown;
  adult: unknown;
  terms: unknown;
  marketing?: unknown;
  userAgent?: string;
  lang?: "ru" | "en";
};

export function parseSignUp(input: SignUpInput) {
  const email = v.email(input.email);
  const username = v.username(input.username);
  const displayName = v.displayName(input.displayName || input.username);
  const password = v.password(input.password);
  if (!v.bool(input.adult)) fail("adult_required");
  if (!v.bool(input.terms)) fail("consent_required");
  return { email, username, displayName, password, marketing: v.bool(input.marketing) };
}

/** Records acceptance of the current terms and privacy notice and the separate marketing choice. */
export async function recordSignupConsents(q: Queryable, userId: string, marketing: boolean) {
  const { LEGAL_VERSIONS } = await import("../lib/legal.ts");
  await q.query(
    `insert into consents (user_id, kind, version, granted, source) values ($1, 'terms', $2, true, 'signup'), ($1, 'privacy', $3, true, 'signup'),
       ($1, 'marketing', $2, $4, 'signup')`,
    [userId, LEGAL_VERSIONS.terms, LEGAL_VERSIONS.privacy, marketing],
  );
  if (marketing) await q.query("update users set marketing_opt_in_at = now() where id = $1", [userId]);
}

/**
 * Instant sign-up: the account is usable immediately; email confirmation is a separate state. An email
 * conflict returns a generic refusal rather than confirming that the address is registered.
 */
export async function signUp(db: Database, input: SignUpInput) {
  const data = parseSignUp(input);
  const passwordHash = await hashPassword(data.password);
  try {
    return await db.tx(async (q) => {
      const reservation = await checkReservedName(q, data.username, input.reservation);
      const [user] = await q.query<{ id: string }>(
        `insert into users (email, username, display_name, password_hash, adult_confirmed_at)
         values ($1, $2, $3, $4, now()) returning id`,
        [data.email, data.username, data.displayName, passwordHash],
      );
      await claimReservedName(q, reservation, user.id);
      await recordSignupConsents(q, user.id, data.marketing);
      await audit(q, { actorId: user.id, action: "user.signup", entity: "user", entityId: user.id, data: { username: data.username } });
      const session = await createSession(q, user.id, input.userAgent ?? "");
      const { queueVerification } = await import("./accounts.ts");
      await queueVerification(q, user.id, data.email, input.lang ?? "ru");
      return { userId: user.id, ...session };
    });
  } catch (error) {
    if (isUniqueViolation(error, "users_email_key")) fail("signup_unavailable");
    if (isUniqueViolation(error, "users_username_key")) fail("username_taken");
    throw error;
  }
}

export async function signIn(
  db: Database,
  input: { login: unknown; password: unknown; userAgent?: string; clientKey?: string },
) {
  const login = v.oneLine(input.login, 254).toLowerCase();
  const password = typeof input.password === "string" ? input.password.slice(0, 200) : "";
  if (!login || !password) fail("invalid_credentials");
  const keys = [`login:${sha256(login)}`, ...(input.clientKey ? [`client:${sha256(input.clientKey)}`] : [])];
  if (await limited(db, keys)) fail("too_many_attempts");
  const [user] = await db.query<{ id: string; password_hash: string; status: string }>(
    "select id, password_hash, status from users where (email = $1 or username = $1) and status <> 'deleted'",
    [login],
  );
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    for (const key of keys) await db.query("insert into auth_attempts (key, ok) values ($1, false)", [key]);
    fail("invalid_credentials");
  }
  // Only reachable with the correct password, so it reveals nothing to someone guessing addresses.
  if (user.status === "pending") fail("account_not_activated");
  if (user.status !== "active") fail("account_suspended");
  return db.tx(async (q) => {
    await q.query("delete from auth_attempts where key = any($1)", [keys]);
    await audit(q, { actorId: user.id, action: "user.signin", entity: "user", entityId: user.id });
    const session = await createSession(q, user.id, input.userAgent ?? "");
    return { userId: user.id, ...session };
  });
}

export async function sessionUser(db: Queryable, token: string | undefined): Promise<SessionUser | null> {
  if (!token || token.length > 100) return null;
  const id = sha256(token);
  const [row] = await db.query<{
    id: string;
    email: string;
    username: string;
    display_name: string;
    roles: Role[] | null;
    last_seen_at: Date;
    email_verified_at: Date | null;
    mfa_at: Date | null;
    avatar_color: string;
    onboarded_at: Date | null;
    restricted: boolean;
  }>(
    `select u.id, u.email, u.username, u.display_name, s.last_seen_at, u.email_verified_at, s.mfa_at, u.avatar_color, u.onboarded_at,
            array(select role from user_roles r where r.user_id = u.id order by role) as roles,
            exists (select 1 from sanctions x where x.user_id = u.id and x.kind = 'suspension' and x.revoked_at is null
                       and x.starts_at <= now() and (x.ends_at is null or x.ends_at > now())) as restricted
       from sessions s join users u on u.id = s.user_id
      where s.id = $1 and s.revoked_at is null and s.expires_at > now() and u.status = 'active'`,
    [id],
  );
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 10 * 60_000)
    await db.query("update sessions set last_seen_at = now() where id = $1", [id]);
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.display_name,
    roles: row.roles ?? [],
    sessionId: id,
    emailVerified: Boolean(row.email_verified_at),
    mfaAt: row.mfa_at ? new Date(row.mfa_at) : null,
    avatarColor: row.avatar_color,
    onboarded: Boolean(row.onboarded_at),
    restricted: Boolean(row.restricted),
  };
}

export async function signOut(db: Queryable, token: string | undefined) {
  if (!token) return;
  await db.query("update sessions set revoked_at = now() where id = $1 and revoked_at is null", [sha256(token)]);
}

export async function changePassword(db: Database, user: SessionUser, current: unknown, next: unknown) {
  const password = v.password(next);
  const [row] = await db.query<{ password_hash: string }>("select password_hash from users where id = $1", [user.id]);
  if (!row || typeof current !== "string" || !(await verifyPassword(current, row.password_hash)))
    fail("wrong_password");
  const hash = await hashPassword(password);
  await db.tx(async (q) => {
    await q.query("update users set password_hash = $2, updated_at = now() where id = $1", [user.id, hash]);
    await q.query("update sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null", [
      user.id,
      user.sessionId,
    ]);
    await audit(q, { actorId: user.id, action: "user.password_changed", entity: "user", entityId: user.id });
  });
}

export async function revokeSession(db: Database, user: SessionUser, sessionId: unknown) {
  const id = v.oneLine(sessionId, 80);
  if (id === "others") {
    await db.query("update sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null", [
      user.id,
      user.sessionId,
    ]);
    return;
  }
  await db.query("update sessions set revoked_at = now() where user_id = $1 and id = $2 and revoked_at is null", [
    user.id,
    id,
  ]);
}

export async function updateProfile(
  db: Database,
  user: SessionUser,
  input: { displayName: unknown; country: unknown; bio: unknown; profilePublic: unknown },
) {
  const displayName = v.displayName(input.displayName);
  const country = v.oneLine(input.country, 60);
  const bio = v.clean(input.bio, 600);
  const isPublic = v.bool(input.profilePublic);
  await db.tx(async (q) => {
    await q.query(
      "update users set display_name = $2, country = $3, bio = $4, profile_public = $5, updated_at = now() where id = $1",
      [user.id, displayName, country, bio, isPublic],
    );
    await audit(q, { actorId: user.id, action: "user.profile_updated", entity: "user", entityId: user.id });
  });
}

export async function setGameAccount(db: Database, user: SessionUser, game: string, handle: unknown) {
  const value = v.oneLine(handle, 60);
  if (!value) {
    await db.query("delete from linked_game_accounts where user_id = $1 and game = $2", [user.id, game]);
    return;
  }
  await db.query(
    `insert into linked_game_accounts (user_id, game, handle) values ($1, $2, $3)
     on conflict (user_id, game) do update set handle = excluded.handle, verified = false`,
    [user.id, game, value],
  );
}

/**
 * Hash of the owner's one-time bootstrap code. Only the SHA-256 is public; the code itself was handed
 * to the owner privately. It works only while the platform has no administrator at all.
 */
const OWNER_BOOTSTRAP_SHA256 = "4d085c8ef774733527bde14e5a79db6890e5d291ec365369eb634c99020500b0";

export function adminClaimMode(): "env" | "owner_code" {
  return (process.env.ADMIN_BOOTSTRAP_TOKEN?.trim().length ?? 0) >= 24 ? "env" : "owner_code";
}

export async function claimAdmin(db: Database, user: SessionUser, token: unknown) {
  const given = typeof token === "string" ? token.trim() : "";
  if (!given) fail("admin_token_invalid");
  const envToken = process.env.ADMIN_BOOTSTRAP_TOKEN?.trim();
  await db.tx(async (q) => {
    await q.query("select pg_advisory_xact_lock($1)", [7461003]);
    let ok = false;
    if (envToken && envToken.length >= 24) {
      ok = timingSafeEqual(Buffer.from(sha256(given)), Buffer.from(sha256(envToken)));
    } else {
      const [admins] = await q.query<{ n: number }>("select count(*)::int as n from user_roles where role = 'admin'");
      if ((admins?.n ?? 0) > 0) fail("admin_claim_disabled");
      ok = timingSafeEqual(Buffer.from(sha256(given)), Buffer.from(OWNER_BOOTSTRAP_SHA256));
    }
    if (!ok) fail("admin_token_invalid");
    await q.query(
      "insert into user_roles (user_id, role, granted_by) values ($1, 'admin', $1) on conflict do nothing",
      [user.id],
    );
    await audit(q, { actorId: user.id, action: "role.admin_claimed", entity: "user", entityId: user.id });
  });
}

export async function exportAccount(db: Database, user: SessionUser) {
  const [profile] = await db.query(
    `select id, email, username, display_name, country, country_code, bio, profile_public, avatar_color, referral_code,
            email_verified_at, marketing_opt_in_at, onboarded_at, created_at from users where id = $1`,
    [user.id],
  );
  const q = <T = Record<string, unknown>>(sql: string) => db.query<T & Record<string, unknown>>(sql, [user.id]);
  const [mfa] = await q<{ enrolled: boolean }>("select confirmed_at is not null as enrolled from mfa_factors where user_id = $1");
  return {
    exportedAt: new Date().toISOString(),
    profile,
    roles: user.roles,
    consents: await q("select kind, version, granted, source, created_at from consents where user_id = $1 order by id"),
    secondFactor: { enrolled: Boolean(mfa?.enrolled) },
    usernameReservations: await q("select username, team_id, status, created_at, expires_at from username_reservations where invited_by = $1 or claimed_by = $1"),
    gameAccounts: await q("select game, handle, verified, created_at from all_game_accounts where user_id = $1"),
    teams: await q("select t.slug, t.name, t.game, tm.joined_at from team_members tm join teams t on t.id = tm.team_id where tm.user_id = $1"),
    registrations: await q(
      `select t.slug as tournament, r.status, r.placement, r.created_at, case when r.registered_by = $1 then r.answers end as answers,
              r.decision_note
         from registrations r join tournaments t on t.id = r.tournament_id
        where r.registered_by = $1 or exists (select 1 from roster_entries re where re.registration_id = r.id and re.user_id = $1)
        order by r.created_at`,
    ),
    scoreEntries: await q(
      `select t.slug as tournament, s.kills, s.assists, s.deaths, s.headshots, s.damage, s.distance, s.placement, s.match_ref,
              s.evidence_url, s.flags, s.review, s.review_note, s.created_at
         from score_entries s join tournaments t on t.id = s.tournament_id where s.submitted_by = $1 order by s.created_at`,
    ),
    disputesFiled: await q("select match_id, kind, reason, evidence_url, status, decision, created_at from disputes where opened_by = $1 order by created_at"),
    tournamentFeedback: await q(
      "select t.slug as tournament, f.rating, f.comment, f.created_at, f.updated_at from tournament_feedback f join tournaments t on t.id = f.tournament_id where f.user_id = $1 order by f.created_at",
    ),
    finderPosts: await q(
      "select kind, game, region, roles, languages, level, schedule, note, slots, status, created_at, expires_at, closed_at from finder_posts where user_id = $1 order by created_at",
    ),
    finderApplications: await q(
      "select a.status, a.message, a.created_at, a.decided_at, p.kind, p.game from finder_applications a join finder_posts p on p.id = a.post_id where a.user_id = $1 order by a.created_at",
    ),
    quickRatings: await q("select game, rating, matches, wins, losses, peak, updated_at from ratings where user_id = $1 order by game"),
    ratingHistory: await q("select game, result, before, after, delta, created_at from rating_events where user_id = $1 order by created_at"),
    party: await q(
      "select p.game, (p.leader_id = $1) as leader, m.joined_at from party_members m join parties p on p.id = m.party_id where m.user_id = $1",
    ),
    readyChecks: await q(
      "select rc.game, rc.status, rp.side, rp.region, rp.answer, rp.answered_at, rc.created_at from ready_check_players rp join ready_checks rc on rc.id = rp.ready_check_id where rp.user_id = $1 order by rc.created_at",
    ),
    queueCooldowns: await q("select game, kind, cooldown_until, created_at from quick_dodges where user_id = $1 order by created_at"),
    sanctions: await q(
      "select kind, protective, rule_code, rule_version, confidence, evidence, decision, starts_at, ends_at, revoked_at, revoke_reason, created_at from sanctions where user_id = $1 order by created_at",
    ),
    appeals: await q("select a.statement, a.evidence_url, a.status, a.decision, a.created_at, a.decided_at from sanction_appeals a where a.user_id = $1 order by a.created_at"),
    teamHistory: await q("select t.name as team, h.event, h.at from team_history h join teams t on t.id = h.team_id where h.user_id = $1 order by h.at"),
    transfers: await q(
      "select ft.name as from_team, tt.name as to_team, tr.status, tr.note, tr.created_at, tr.completed_at from team_transfers tr join teams ft on ft.id = tr.from_team join teams tt on tt.id = tr.to_team where tr.player_id = $1 order by tr.created_at",
    ),
    ...(await clanExport(db, user.id)),
    venuePasses: await passExport(db, user.id),
    portalMessages: await messageExport(db, user.id),
    academy: await academyExport(db, user.id),
    connections: await socialExport(db, user.id),
    recurringMissions: await q("select mission,window_start,window_end,game,target,coins,xp,claimed_at from mission_assignments where user_id=$1 order by window_start"),
    venueGifts: await q("select id,reward_id,status,claimed_at,collected_at from pass_reward_claims where user_id=$1"),
    stationBookings: await q("select id,station_id,starts_at,ends_at,status,created_at from station_bookings where user_id=$1 order by starts_at"),
    clubhouseRsvps: await q("select event_id,status,created_at from club_rsvps where user_id=$1"),
    p2pHosts: await q("select id,name,region,cpu,gpu,ram_gb,games,status,review_note,created_at from p2p_hosts where owner_id=$1"),
    p2pSessions: await q("select s.id,s.host_id,s.game,s.status,s.created_at,s.started_at,s.ended_at,s.connected_seconds,s.feedback,s.problem,s.rewarded from p2p_sessions s join p2p_hosts h on h.id=s.host_id where $1 in(s.client_id,h.owner_id)"),
    arbitration: await arbitrationExport(db,user.id),
    skinListingDrafts: await listingDrafts(db,user.id),
    skinDemoOrders: await myMarketOrders(db,user.id),
    scoutFilters: await q("select name, query, created_at from scout_filters where user_id = $1 order by created_at"),
    watchlist: await q("select u.username as player, w.note, w.created_at from scout_watch w join users u on u.id = w.player_id where w.user_id = $1 order by w.created_at"),
    reportsFiled: await q(
      "select u.username as player, c.rule_code, c.context_url, c.description, c.evidence_url, c.status, c.created_at, c.resolved_at from conduct_reports c join users u on u.id = c.subject_id where c.reporter_id = $1 order by c.created_at",
    ),
    challenges: await q(
      `select c.kind, c.game, c.status, (c.challenger_id = $1) as sent_by_me, case when c.challenger_id = $1 then uo.username else uc.username end as opponent,
              c.score_challenger, c.score_opponent, (c.winner_id = $1) as won, c.created_at, c.completed_at
         from challenges c join users uc on uc.id = c.challenger_id join users uo on uo.id = c.opponent_id
        where $1 in (c.challenger_id, c.opponent_id) order by c.created_at`,
    ),
    wallet: {
      balance: (await q<{ balance: number }>("select balance from wallets where user_id = $1"))[0]?.balance ?? 0,
      ledger: await q("select delta, reason, balance_after, created_at from coin_ledger where user_id = $1 order by id"),
    },
    xp: await q("select amount, reason, game, created_at from xp_events where user_id = $1 order by id"),
    objectives: await q("select objective, claimed_at from objective_claims where user_id = $1"),
    seasonPass: {
      unlocks: await q("select season, source, unlocked_at from pass_unlocks where user_id = $1"),
      claims: await q("select season, tier, track, claimed_at from pass_claims where user_id = $1 order by season, tier"),
    },
    cosmetics: await q("select item, source, acquired_at from user_cosmetics where user_id = $1"),
    referral: {
      usedCode: (await q<{ code: string; created_at: Date }>("select code, created_at from referral_redemptions where referee_id = $1"))[0] ?? null,
      invitedPlayers: (await q<{ n: number }>("select count(*)::int as n from referral_redemptions where referrer_id = $1"))[0]?.n ?? 0,
    },
    uploads: await q("select id, kind, content_type, bytes, created_at from media where owner_id = $1 order by created_at"),
    membershipApplications: await q(
      "select reference, status, objective, decision_note, created_at, decided_at from membership_applications where user_id = $1 order by created_at",
    ),
    invoices: await q(
      `select number, status, amount_minor, currency, exponent, recipient, tax_treatment, terms_version, created_at, paid_at, voided_at, refunded_minor
         from invoices where user_id = $1 order by created_at`,
    ),
    paymentAttempts: await q(
      `select i.number as invoice, a.provider, a.mode, a.status, a.amount_minor, a.currency, a.created_at, a.updated_at
         from payment_attempts a join invoices i on i.id = a.invoice_id where a.user_id = $1 order by a.created_at`,
    ),
    memberships: await q("select status, starts_at, ends_at, status_reason, created_at from memberships where user_id = $1 order by created_at"),
    emails: await q("select template, lang, status, created_at, sent_at from email_outbox where user_id = $1 order by created_at"),
    sessions: await q("select created_at, last_seen_at, expires_at, revoked_at, user_agent from sessions where user_id = $1 order by created_at desc"),
    notifications: await q("select kind, data, read_at, created_at from notifications where user_id = $1 order by created_at desc"),
  };
}

export async function deleteAccount(db: Database, user: SessionUser, confirmPassword: unknown) {
  const [row] = await db.query<{ password_hash: string }>("select password_hash from users where id = $1", [user.id]);
  if (!row || typeof confirmPassword !== "string" || !(await verifyPassword(confirmPassword, row.password_hash)))
    fail("wrong_password");
  await db.tx(async (q) => {
    const [owned] = await q.query<{ n: number }>(
      `select count(*)::int as n from teams t
        where t.owner_id = $1 and exists (select 1 from team_members m where m.team_id = t.id and m.user_id <> $1)`,
      [user.id],
    );
    const [orgs] = await q.query<{ n: number }>(
      `select count(*)::int as n from org_members m
        where m.user_id = $1 and m.role = 'owner'
          and not exists (select 1 from org_members o where o.org_id = m.org_id and o.role = 'owner' and o.user_id <> $1)`,
      [user.id],
    );
    if ((owned?.n ?? 0) > 0 || (orgs?.n ?? 0) > 0 || (await ownedClansWithMembers(q, user.id)) > 0) throw new DomainError("transfer_ownership_first");
    // A payment the provider may still confirm must settle first, so it is never attached to a deleted account.
    const [paying] = await q.query(
      "select 1 from payment_attempts where user_id = $1 and status in ('created','open','processing') limit 1",
      [user.id],
    );
    if (paying) throw new DomainError("checkout_in_progress");
    const tag = user.id.slice(0, 8);
    await q.query(
      `update users set email = $2, username = $3, display_name = 'Deleted user', password_hash = $4,
              country = '', country_code = null, bio = '', profile_public = false, avatar_color = '', referral_code = null,
              email_verified_at = null, marketing_opt_in_at = null, status = 'deleted', updated_at = now()
        where id = $1`,
      [user.id, `deleted+${user.id}@invalid.local`, `deleted_${tag}`, `deleted$${randomBytes(16).toString("hex")}`],
    );
    await q.query("delete from username_reservations where invited_by = $1 or claimed_by = $1", [user.id]);
    await q.query("delete from additional_game_accounts where user_id = $1", [user.id]);
    await q.query("delete from linked_game_accounts where user_id = $1", [user.id]);
    // Registration answers may hold contact details: erased with the account that gave them.
    await q.query("update registrations set answers = null where registered_by = $1 and answers is not null", [user.id]);
    await q.query("delete from tournament_feedback where user_id = $1", [user.id]);
    // Team finder posts and applications are free text the account wrote: erased with it.
    await q.query("delete from finder_applications where user_id = $1", [user.id]);
    await q.query("delete from finder_posts where user_id = $1", [user.id]);
    await q.query("delete from team_members where user_id = $1", [user.id]);
    await q.query("delete from user_roles where user_id = $1", [user.id]);
    await q.query("delete from tournament_organizers where user_id = $1", [user.id]);
    await q.query("update team_invites set status = 'revoked' where user_id = $1 and status = 'pending'", [user.id]);
    await q.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [user.id]);
    // Credentials, pending mail and live queues go; confirmed results, ledgers and financial records stay
    // (without the name) because other players' histories and accounting depend on them.
    await q.query("delete from email_tokens where user_id = $1", [user.id]);
    await q.query("delete from email_outbox where user_id = $1", [user.id]);
    await q.query("delete from mfa_factors where user_id = $1", [user.id]);
    await q.query("delete from mfa_recovery_codes where user_id = $1", [user.id]);
    // Parties: the leader's party is disbanded, a member leaves; a queued party leaves the queue whole.
    await q.query("delete from quick_queue where party_id in (select party_id from party_members where user_id = $1)", [user.id]);
    await q.query("delete from parties where leader_id = $1", [user.id]);
    await q.query("delete from party_members where user_id = $1", [user.id]);
    await q.query("update party_invites set status = 'revoked', responded_at = now() where user_id = $1 and status = 'pending'", [user.id]);
    await q.query("delete from quick_queue where user_id = $1", [user.id]);
    // Quick-match ratings, their history and queue cooldowns belong to the account alone.
    await q.query("delete from rating_events where user_id = $1", [user.id]);
    await q.query("delete from ratings where user_id = $1", [user.id]);
    await q.query("delete from quick_dodges where user_id = $1", [user.id]);
    await q.query("update ready_check_players set region = '' where user_id = $1", [user.id]);
    // Transfer proposals still open for the account lapse with it.
    await q.query("update team_transfers set status = 'cancelled' where player_id = $1 and status = 'proposed'", [user.id]);
    // Clans: a sole owner's clan is disbanded; the account leaves its clan, invitations and future lineups.
    await eraseClanData(q, user.id);
    // Venue passes of the account stop working.
    await revokePassesOf(q, user.id);
    // Delivery records of portal-team messages go; each message keeps only its totals.
    await eraseMessageData(q, user.id);
    // Academy: the account's training records go; as a coach, open requests are cancelled and the profile goes.
    await eraseAcademyData(q, user.id);
    await eraseMarketData(q,user.id);
    await eraseSocial(q, user.id);
    await eraseClubhouse(q, user.id);
    await eraseP2p(q, user.id);
    await q.query("delete from mission_preferences where user_id=$1", [user.id]);
    await q.query("update pass_reward_claims set status='cancelled',collection_sealed='' where user_id=$1 and status='reserved'", [user.id]);
    // Scouting: the account's filters and watchlist go, and it leaves every other watchlist.
    await q.query("delete from scout_filters where user_id = $1", [user.id]);
    await q.query("delete from scout_watch where user_id = $1 or player_id = $1", [user.id]);
    // Reports still under review that no decision relies on are withdrawn with the account; decided ones stay as the record.
    await q.query(
      "delete from conduct_reports c where c.reporter_id = $1 and c.status in ('open','reviewing') and not exists (select 1 from sanctions s where s.report_id = c.id)",
      [user.id],
    );
    await q.query(
      "update challenges set status = 'cancelled', resolution = 'account_deleted' where $1 in (challenger_id, opponent_id) and status in ('pending','accepted')",
      [user.id],
    );
    await q.query("update membership_applications set status = 'withdrawn', updated_at = now() where user_id = $1 and status in ('submitted','under_review','awaiting_info')", [
      user.id,
    ]);
    await q.query("update invoices set status = 'void', voided_at = now() where user_id = $1 and status = 'open'", [user.id]);
    await q.query(
      "update memberships set status = 'ended', ends_at = least(coalesce(ends_at, now()), now()), status_reason = 'account_deleted', updated_at = now() where user_id = $1 and status in ('pending','active','suspended')",
      [user.id],
    );
    await q.query("insert into consents (user_id, kind, version, granted, source) select $1, 'marketing', version, false, 'account_deleted' from consents where user_id = $1 and kind = 'marketing' order by id desc limit 1", [
      user.id,
    ]);
    await audit(q, { actorId: user.id, action: "user.deleted", entity: "user", entityId: user.id });
  });
}
