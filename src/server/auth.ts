import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Database, Queryable } from "./db.ts";
import { audit } from "./audit.ts";
import { DomainError, fail, isUniqueViolation } from "./errors.ts";
import * as v from "./validate.ts";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_DAYS = 30;
export const SESSION_COOKIE = "mv_session";

export type Role = "admin" | "referee" | "support";
export type SessionUser = {
  id: string;
  email: string;
  username: string;
  displayName: string;
  roles: Role[];
  sessionId: string;
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

async function createSession(q: Queryable, userId: string, userAgent: string) {
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
  email: unknown;
  username: unknown;
  displayName: unknown;
  password: unknown;
  adult: unknown;
  terms: unknown;
  userAgent?: string;
};

export async function signUp(db: Database, input: SignUpInput) {
  const email = v.email(input.email);
  const username = v.username(input.username);
  const displayName = v.displayName(input.displayName || input.username);
  const password = v.password(input.password);
  if (!v.bool(input.adult)) fail("adult_required");
  if (!v.bool(input.terms)) fail("consent_required");
  const passwordHash = await hashPassword(password);
  try {
    return await db.tx(async (q) => {
      const [user] = await q.query<{ id: string }>(
        `insert into users (email, username, display_name, password_hash, adult_confirmed_at)
         values ($1, $2, $3, $4, now()) returning id`,
        [email, username, displayName, passwordHash],
      );
      await audit(q, { actorId: user.id, action: "user.signup", entity: "user", entityId: user.id, data: { username } });
      const session = await createSession(q, user.id, input.userAgent ?? "");
      return { userId: user.id, ...session };
    });
  } catch (error) {
    if (isUniqueViolation(error, "users_email_key")) fail("email_taken");
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
  }>(
    `select u.id, u.email, u.username, u.display_name, s.last_seen_at,
            array(select role from user_roles r where r.user_id = u.id order by role) as roles
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
    "select id, email, username, display_name, country, bio, profile_public, created_at from users where id = $1",
    [user.id],
  );
  return {
    exportedAt: new Date().toISOString(),
    profile,
    roles: user.roles,
    gameAccounts: await db.query("select game, handle, verified, created_at from linked_game_accounts where user_id = $1", [user.id]),
    teams: await db.query(
      "select t.slug, t.name, t.game, tm.joined_at from team_members tm join teams t on t.id = tm.team_id where tm.user_id = $1",
      [user.id],
    ),
    registrations: await db.query(
      `select t.slug as tournament, r.status, r.placement, r.created_at
         from roster_entries re join registrations r on r.id = re.registration_id
         join tournaments t on t.id = r.tournament_id where re.user_id = $1`,
      [user.id],
    ),
    sessions: await db.query(
      "select created_at, last_seen_at, expires_at, revoked_at, user_agent from sessions where user_id = $1 order by created_at desc",
      [user.id],
    ),
    notifications: await db.query(
      "select kind, data, read_at, created_at from notifications where user_id = $1 order by created_at desc",
      [user.id],
    ),
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
    if ((owned?.n ?? 0) > 0 || (orgs?.n ?? 0) > 0) throw new DomainError("transfer_ownership_first");
    const tag = user.id.slice(0, 8);
    await q.query(
      `update users set email = $2, username = $3, display_name = 'Deleted user', password_hash = $4,
              country = '', bio = '', profile_public = false, status = 'deleted', updated_at = now()
        where id = $1`,
      [user.id, `deleted+${user.id}@invalid.local`, `deleted_${tag}`, `deleted$${randomBytes(16).toString("hex")}`],
    );
    await q.query("delete from linked_game_accounts where user_id = $1", [user.id]);
    await q.query("delete from team_members where user_id = $1", [user.id]);
    await q.query("delete from user_roles where user_id = $1", [user.id]);
    await q.query("update team_invites set status = 'revoked' where user_id = $1 and status = 'pending'", [user.id]);
    await q.query("update sessions set revoked_at = now() where user_id = $1 and revoked_at is null", [user.id]);
    await audit(q, { actorId: user.id, action: "user.deleted", entity: "user", entityId: user.id });
  });
}
