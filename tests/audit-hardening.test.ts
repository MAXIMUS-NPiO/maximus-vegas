/**
 * Release-audit hardening (C-36): evidence images must decode completely and keep their original bytes;
 * account creation has a per-client budget on both sign-up paths.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { openDatabase, type Database } from "../src/server/db.ts";
import { storeUpload } from "../src/server/media.ts";
import { SIGNUP_PER_DAY, SIGNUP_PER_HOUR, sha256, signUp } from "../src/server/auth.ts";
import { signUpEmailFirst } from "../src/server/accounts.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
let n = 0;
test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
});
test.after(async () => {
  await db.close();
});

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}
const file = (bytes: Uint8Array, name: string) => new File([new Uint8Array(bytes)], name);
const account = (clientKey?: string) => {
  n += 1;
  return { email: `budget${n}@example.com`, username: `budget_${n}`, displayName: `Budget ${n}`, password: "budget-password-123", adult: "on", terms: "on", clientKey };
};

test("evidence: a signature alone is refused, a broken image is refused, a real image keeps its exact bytes", async () => {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await rejects(storeUpload(db, null, "evidence", file(signature, "fake.png")), "invalid_file");

  const png = new Uint8Array(await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer());
  await rejects(storeUpload(db, null, "evidence", file(png.slice(0, Math.floor(png.length / 2)), "cut.png")), "invalid_file");

  const jpegHeaderOnly = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  await rejects(storeUpload(db, null, "evidence", file(jpegHeaderOnly, "fake.jpg")), "invalid_file");

  const id = (await storeUpload(db, null, "evidence", file(png, "screenshot.png")))!;
  const [row] = await db.query<{ content_type: string; bytes: number; sha256: string; data: Uint8Array }>("select content_type, bytes, sha256, data from media where id = $1", [id]);
  assert.equal(row.content_type, "image/png");
  assert.equal(row.bytes, png.length, "the original is stored unchanged");
  assert.equal(row.sha256, createHash("sha256").update(png).digest("hex"));
  assert.deepEqual(new Uint8Array(row.data), png);

  const webp = new Uint8Array(await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).webp().toBuffer());
  assert.ok(await storeUpload(db, null, "evidence", file(webp, "s.webp")), "a real WebP is accepted");
});

test("sign-up budget: an hourly and a daily limit per client, on both sign-up paths; other clients are unaffected", async () => {
  const venue = "203.0.113.50";
  for (let i = 0; i < SIGNUP_PER_HOUR; i++) assert.ok(await signUp(db, account(venue)));
  await rejects(signUp(db, account(venue)), "signup_limited");
  await rejects(signUpEmailFirst(db, account(venue)), "signup_limited");
  const [users] = await db.query<{ n: number }>("select count(*)::int as n from users where username like 'budget_%'");
  assert.equal(users.n, SIGNUP_PER_HOUR, "the refused attempts created no account");

  assert.ok(await signUp(db, account("198.51.100.7")), "another connection is not blocked");
  for (let i = 0; i < SIGNUP_PER_HOUR + 2; i++) assert.ok(await signUp(db, account()), "no client address (tests, local tools): no budget");
  for (const local of ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
    for (let i = 0; i < SIGNUP_PER_HOUR + 1; i++) assert.ok(await signUp(db, account(local)), `a loopback address (${local}) is this machine: no budget`);

  // The daily limit counts older attempts of the same day.
  const busy = "192.0.2.77";
  await db.query(
    "insert into auth_attempts (key, ok, at) select $1, true, now() - interval '3 hours' from generate_series(1, $2)",
    [`signup-client:${sha256(busy)}`, SIGNUP_PER_DAY],
  );
  await rejects(signUp(db, account(busy)), "signup_limited");
  // Attempts older than a day no longer count.
  await db.query("update auth_attempts set at = now() - interval '25 hours' where key = $1", [`signup-client:${sha256(busy)}`]);
  assert.ok(await signUp(db, account(busy)));
});
