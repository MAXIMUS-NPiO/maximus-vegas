/**
 * Owner access recovery (C-34): while the platform has no administrator, the holder of the owner's bootstrap
 * secret sets a new password for an existing account and makes it the first administrator. The tests use the
 * ADMIN_BOOTSTRAP_TOKEN path; the owner code itself is never in the repository (only its SHA-256).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { adminCount, claimAdmin, recoverOwnerAccess, sessionUser, signIn, signUp } from "../src/server/auth.ts";
import { requireStaffMfa } from "../src/server/mfa.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
const TOKEN = "owner-recovery-test-token-0123456789";
const OLD = "the old password nobody remembers";
const NEW = "a brand new owner password";

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}
const signup = (name: string) =>
  signUp(db, { email: `${name}@example.com`, username: name, displayName: name.toUpperCase(), password: OLD, adult: "on", terms: "on" });

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
});
test.after(async () => {
  delete process.env.ADMIN_BOOTSTRAP_TOKEN;
  await db.close();
});

test("without the bootstrap secret nothing changes; a wrong code counts towards the limit", async () => {
  delete process.env.ADMIN_BOOTSTRAP_TOKEN;
  await signup("ownerzero");
  // Owner-code mode: the real code is not known to the tests, so any guess is refused.
  await rejects(recoverOwnerAccess(db, { login: "ownerzero", token: "MV-not-the-owner-code", password: NEW, clientKey: "203.0.113.9" }), "admin_token_invalid");
  await rejects(recoverOwnerAccess(db, { login: "", token: "x", password: NEW }), "admin_token_invalid");
  await rejects(recoverOwnerAccess(db, { login: "ownerzero", token: "x", password: "short" }), "weak_password");
  for (let i = 0; i < 7; i++) await rejects(recoverOwnerAccess(db, { login: "ownerzero", token: `guess-${i}`, password: NEW, clientKey: "203.0.113.9" }), "admin_token_invalid");
  await rejects(recoverOwnerAccess(db, { login: "ownerzero", token: "guess-8", password: NEW, clientKey: "203.0.113.9" }), "too_many_attempts");
  // Another client is not blocked by someone else's guesses.
  await rejects(recoverOwnerAccess(db, { login: "ownerzero", token: "guess-9", password: NEW, clientKey: "198.51.100.4" }), "admin_token_invalid");
  assert.equal(await adminCount(db), 0);
  assert.ok(await signIn(db, { login: "ownerzero", password: OLD }), "the password is unchanged");
});

test("the owner sets a new password, becomes the first administrator, other sessions end; then the form closes", async () => {
  process.env.ADMIN_BOOTSTRAP_TOKEN = TOKEN;
  const old = await signup("theowner");
  await signup("someoneelse");
  await rejects(recoverOwnerAccess(db, { login: "nobody@example.com", token: TOKEN, password: NEW }), "owner_account_not_found");
  assert.equal(await adminCount(db), 0, "an unknown account creates no administrator");

  await rejects(recoverOwnerAccess(db, { login: "theowner", token: "MV-still-not-the-owner-code", password: NEW, clientKey: "192.0.2.1" }), "admin_token_invalid");
  const s = await recoverOwnerAccess(db, { login: "TheOwner@Example.com", token: ` ${TOKEN} `, password: NEW, userAgent: "test", clientKey: "192.0.2.1" });
  assert.equal(await sessionUser(db, old.token), null, "the earlier session ended");
  const user = (await sessionUser(db, s.token))!;
  assert.equal(user.username, "theowner");
  assert.deepEqual(user.roles, ["admin"]);
  await rejects(requireStaffMfa(db, user), "mfa_not_enrolled");
  await rejects(signIn(db, { login: "theowner", password: OLD }), "invalid_credentials");
  assert.ok(await signIn(db, { login: "theowner@example.com", password: NEW }), "the new password works with the email");
  assert.ok(await signIn(db, { login: "theowner", password: NEW }), "and with the username");
  const [audited] = await db.query<{ n: number }>("select count(*)::int as n from audit_log where action = 'owner.access_recovered' and entity_id = $1", [user.id]);
  assert.equal(audited.n, 1);

  // Closed once an administrator exists: for any account and with the right secret.
  await rejects(recoverOwnerAccess(db, { login: "someoneelse", token: TOKEN, password: NEW }), "admin_claim_disabled");
  assert.ok(await signIn(db, { login: "someoneelse", password: OLD }), "another account keeps its password");
  assert.equal(await adminCount(db), 1);
  // The existing claim keeps working with the configured secret for a signed-in account.
  const other = (await sessionUser(db, (await signIn(db, { login: "someoneelse", password: OLD })).token))!;
  await claimAdmin(db, other, TOKEN);
  assert.equal(await adminCount(db), 2);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("a suspended account is not recovered", async () => {
  const db2 = await openDatabase({ embedded: true, dataDir: "memory://" });
  try {
    process.env.ADMIN_BOOTSTRAP_TOKEN = TOKEN;
    await signUp(db2, { email: "held@example.com", username: "held", displayName: "Held", password: OLD, adult: "on", terms: "on" });
    await db2.query("update users set status = 'suspended' where username = 'held'");
    await rejects(recoverOwnerAccess(db2, { login: "held", token: TOKEN, password: NEW }), "account_suspended");
    assert.equal(await adminCount(db2), 0);
  } finally {
    await db2.close();
  }
});
