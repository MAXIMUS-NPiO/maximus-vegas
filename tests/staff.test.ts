import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { deleteAccount, exportAccount, signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { hasSection, rolesOf, sectionsFor, SECTIONS, STAFF_ROLES, canSendMessage } from "../src/server/staff-roles.ts";
import { requireSection, staffWith } from "../src/server/access.ts";
import { takeReport } from "../src/server/conduct.ts";
import { reviewVenue } from "../src/server/venues.ts";
import { issueInvoice } from "../src/server/billing.ts";
import { adminUsers, playerProfile } from "../src/server/queries.ts";
import { recordStaffView, setRole } from "../src/server/admin.ts";
import {
  copyMessage,
  createMessage,
  deleteMessage,
  MARKETING_CAP,
  messageList,
  openMessage,
  previewReach,
  sendMessage,
  updateMessage,
} from "../src/server/messages.ts";
import { featureEnabled, featureOf, gate, maintenanceState, recordRun, setFlag, systemStatus } from "../src/server/system.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
const PASSWORD = "correct horse battery";
const tokens = new Map<string, string>();
async function mk(name: string, marketing = false): Promise<SessionUser> {
  const s = await signUp(db, {
    email: `${name}@example.com`,
    username: name,
    displayName: name.toUpperCase(),
    password: PASSWORD,
    adult: "on",
    terms: "on",
    marketing: marketing ? "on" : "",
  });
  tokens.set(name, s.token);
  return (await sessionUser(db, s.token))!;
}
async function withRole(name: string, ...roles: string[]): Promise<SessionUser> {
  const u = await mk(name);
  for (const r of roles) await db.query("insert into user_roles (user_id, role) values ($1, $2)", [u.id, r]);
  // A second factor confirmed just now: the step-up checks pass.
  return { ...(await sessionUser(db, tokens.get(name)))!, mfaAt: new Date() };
}
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}
const throwsCode = (fn: () => unknown, code: string) => assert.throws(fn, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
const UUID = "00000000-0000-4000-8000-000000000001";

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
});
test.after(async () => {
  await db.close();
});

test("role matrix: each role holds only its sections; the administrator holds all", () => {
  assert.deepEqual(sectionsFor(["admin"]), [...SECTIONS]);
  assert.deepEqual(sectionsFor([]), []);
  assert.deepEqual(sectionsFor(["marketing"]), ["overview", "applications", "messages", "sponsors"]);
  assert.deepEqual(sectionsFor(["finance"]), ["overview", "memberships", "offers", "payments"]);
  assert.deepEqual(sectionsFor(["moderation"]), ["overview", "challenges", "conduct"]);
  assert.deepEqual(sectionsFor(["referee"]), ["overview", "disputes", "challenges", "tournaments"]);
  assert.deepEqual(sectionsFor(["analytics"]), ["overview", "tournaments"]);
  assert.deepEqual(sectionsFor(["infrastructure"]), ["overview", "outbox", "messages", "system", "security", "audit"]);
  assert.deepEqual(sectionsFor(["compliance"]), ["overview", "users", "venues", "academy", "payments", "security", "audit"]);
  for (const role of STAFF_ROLES) assert.ok(hasSection([role], "overview"), role);
  // Every section has at least one role besides the administrator, and the administrator is always notified.
  for (const s of SECTIONS) assert.equal(rolesOf(s)[0], "admin");
  assert.equal(canSendMessage(["marketing"], "marketing"), true);
  assert.equal(canSendMessage(["marketing"], "operational"), false);
  assert.equal(canSendMessage(["support"], "marketing"), false);
  assert.equal(canSendMessage(["infrastructure"], "operational"), true);
  assert.equal(canSendMessage(["admin"], "marketing"), true);
});

test("sections are checked on the server: a role outside the section is refused even with a direct call", async () => {
  const marketer = await withRole("st_marketer", "marketing");
  const moderator = await withRole("st_moderator", "moderation");
  const finance = await withRole("st_finance", "finance");
  const support = await withRole("st_support", "support");
  // Fair play: moderation passes the section check (and finds no report); marketing is refused before any lookup.
  await rejects(takeReport(db, marketer, UUID), "forbidden");
  await rejects(takeReport(db, moderator, UUID), "not_found");
  // Venues: support passes, finance does not.
  await rejects(reviewVenue(db, finance, UUID, "confirm", ""), "forbidden");
  await rejects(reviewVenue(db, support, UUID, "confirm", ""), "not_found");
  // Payments: finance passes the section, marketing does not.
  await rejects(issueInvoice(db, marketer, UUID, "ru"), "forbidden");
  throwsCode(() => requireSection(marketer, "system"), "forbidden");
  requireSection(moderator, "conduct");
  // Granting roles stays with the administrator; a new role name is accepted, an unknown one is not.
  const admin = await withRole("st_admin", "admin");
  await rejects(setRole(db, support, marketer.id, "finance", true), "forbidden");
  await setRole(db, admin, marketer.id, "analytics", true);
  await rejects(setRole(db, admin, marketer.id, "superuser", true), "invalid_input");
  const roles = (await sessionUser(db, tokens.get("st_marketer")))!.roles;
  assert.deepEqual([...roles].sort(), ["analytics", "marketing"]);
  // The users search matches "_" and "%" literally.
  assert.deepEqual((await adminUsers(db, "st_m")).map((u) => u.username).sort(), ["st_marketer", "st_moderator"]);
  assert.deepEqual(await adminUsers(db, "st%"), []);
  // Notifications for a section reach its roles only.
  const conductStaff = await staffWith(db, "conduct");
  assert.ok(conductStaff.includes(moderator.id) && conductStaff.includes(support.id) && conductStaff.includes(admin.id));
  assert.ok(!conductStaff.includes(marketer.id) && !conductStaff.includes(finance.id));
});

test("messages: marketing respects consent and the frequency cap; operational reaches the whole segment", async () => {
  const marketer = await withRole("st_mk", "marketing");
  const support = await withRole("st_sp", "support");
  const [a, b, c] = [await mk("st_a", true), await mk("st_b", true), await mk("st_c", false)];
  const suspended = await mk("st_d", true);
  await db.query("update users set country_code = 'IS' where id = any($1::uuid[])", [[a.id, b.id, c.id, suspended.id]]);
  await db.query("update users set status = 'suspended' where id = $1", [suspended.id]);
  const segment = { audience: "all", country: "IS" };
  // Rights by kind.
  await rejects(createMessage(db, support, { kind: "marketing", title: "Анонс", body: "Текст", ...segment }), "message_kind");
  await rejects(createMessage(db, marketer, { kind: "operational", title: "Работы", body: "Текст", ...segment }), "message_kind");
  await rejects(createMessage(db, marketer, { kind: "marketing", title: "x", body: "Текст", ...segment }), "invalid_input");
  await rejects(createMessage(db, marketer, { kind: "marketing", title: "Анонс", body: "Текст", ...segment, game: "chess960" }), "invalid_game");
  // The account b already received the cap of marketing messages this week.
  for (let i = 0; i < MARKETING_CAP; i++) {
    const { id } = await createMessage(db, marketer, { kind: "marketing", title: `Ранний анонс ${i}`, body: "Текст", audience: "all" });
    await db.query("insert into message_recipients (message_id, user_id, status) values ($1, $2, 'sent')", [id, b.id]);
    await db.query("update staff_messages set status = 'sent', sent_at = now() where id = $1", [id]);
  }
  const { id } = await createMessage(db, marketer, { kind: "marketing", title: "Кубок выходных", body: "Регистрация открыта.", ...segment });
  assert.deepEqual(await previewReach(db, "marketing", { audience: "all", game: "", country: "IS", activeDays: 0 }), {
    total: 3,
    reach: 1,
    skippedConsent: 1,
    skippedCap: 1,
  });
  // Sending needs a second factor confirmed in the last minutes.
  await rejects(sendMessage(db, { ...marketer, mfaAt: new Date(Date.now() - 3600_000) }, id), "step_up_required");
  await rejects(sendMessage(db, support, id), "message_kind");
  assert.deepEqual(await sendMessage(db, marketer, id), { sent: 1, skipped_consent: 1, skipped_cap: 1 });
  await rejects(sendMessage(db, marketer, id), "message_state");
  await rejects(updateMessage(db, marketer, id, { kind: "marketing", title: "Другой", body: "Текст", ...segment }), "message_state");
  await rejects(deleteMessage(db, marketer, id), "message_state");
  // Only a: the notification links to the message; the recipient's opening is recorded once.
  const notes = await db.query<{ user_id: string; data: Record<string, string> }>("select user_id, data from notifications where kind = 'staff_message'");
  assert.deepEqual(
    notes.map((n) => n.user_id),
    [a.id],
  );
  assert.equal(notes[0].data.messageId, id);
  assert.equal(await openMessage(db, b.id, id), null, "a skipped account cannot open it");
  assert.equal((await openMessage(db, a.id, id))?.title, "Кубок выходных");
  await openMessage(db, a.id, id);
  const [row] = await db.query<{ read_at: Date | null }>("select read_at from notifications where user_id = $1 and kind = 'staff_message'", [a.id]);
  assert.ok(row.read_at, "opening marks the notification read");
  const sent = (await messageList(db)).find((m) => m.id === id)!;
  assert.equal(sent.opened, 1);
  assert.deepEqual(sent.stats, { sent: 1, skipped_consent: 1, skipped_cap: 1 });
  // Operational: consent and cap do not apply; a suspended account is never in a segment.
  const op = await createMessage(db, support, { kind: "operational", title: "Технические работы", body: "В воскресенье с 02:00 до 03:00 UTC.", ...segment });
  assert.deepEqual(await sendMessage(db, support, op.id), { sent: 3 });
  // Templates are never sent; a draft is copied from them.
  const tpl = await createMessage(db, marketer, { kind: "marketing", title: "Шаблон анонса", body: "Текст", ...segment, template: "1" });
  await rejects(sendMessage(db, marketer, tpl.id), "message_state");
  const fromTpl = await copyMessage(db, marketer, tpl.id, "draft");
  await updateMessage(db, marketer, fromTpl.id, { kind: "marketing", title: "Анонс по шаблону", body: "Текст", audience: "all", country: "NO" });
  await rejects(sendMessage(db, marketer, fromTpl.id), "message_empty");
  await deleteMessage(db, marketer, fromTpl.id);
  // Export lists the account's messages; deletion erases its delivery records but keeps the totals.
  const data = (await exportAccount(db, a)) as unknown as { portalMessages: { title: string }[] };
  assert.deepEqual(
    data.portalMessages.map((m) => m.title),
    ["Кубок выходных", "Технические работы"],
  );
  await deleteAccount(db, a, PASSWORD);
  assert.equal((await db.query("select 1 from message_recipients where user_id = $1", [a.id])).length, 0);
  assert.deepEqual((await messageList(db)).find((m) => m.id === id)!.stats, { sent: 1, skipped_consent: 1, skipped_cap: 1 });
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("switches and maintenance: refused before anything changes; staff keep working; changes are audited", async () => {
  const infra = await withRole("st_infra", "infrastructure");
  const marketer = await withRole("st_mk2", "marketing");
  const player = await mk("st_player");
  assert.equal(featureOf("clan.create"), "clans");
  assert.equal(featureOf("clan.leave"), null, "leaving is never switched off");
  assert.equal(featureOf("war.decide"), null, "staff decisions are never switched off");
  assert.equal(featureOf("pass.admit"), null, "the door keeps admitting");
  await rejects(setFlag(db, marketer, "clans", false, ""), "forbidden");
  await rejects(setFlag(db, infra, "everything", false, ""), "invalid_input");
  await setFlag(db, infra, "clans", false, "Проверяем ошибку в таблице");
  assert.equal(await featureEnabled(db, "clans"), false);
  await rejects(gate(db, "clan.create", player), "feature_disabled");
  await gate(db, "clan.leave", player);
  await gate(db, "clan.create", infra);
  await gate(db, "challenge.create", player);
  await setFlag(db, infra, "clans", true, "");
  await gate(db, "clan.create", player);
  // Maintenance needs a fresh second factor; it refuses every action except signing in and out.
  await rejects(setFlag(db, { ...infra, mfaAt: new Date(Date.now() - 3600_000) }, "maintenance", true, ""), "step_up_required");
  await setFlag(db, infra, "maintenance", true, "Обновление базы до 03:00 UTC");
  assert.deepEqual({ ...(await maintenanceState(db)), since: null }, { on: true, note: "Обновление базы до 03:00 UTC", since: null });
  await rejects(gate(db, "tournament.register", player), "maintenance");
  await rejects(gate(db, "auth.signup", null), "maintenance");
  await gate(db, "auth.signin", null);
  await gate(db, "auth.signout", player);
  await gate(db, "tournament.register", infra);
  await setFlag(db, infra, "maintenance", false, "");
  await gate(db, "tournament.register", player);
  const log = await db.query<{ entity_id: string; data: { enabled: boolean } }>("select entity_id, data from audit_log where action = 'system.flag' order by id");
  assert.deepEqual(
    log.map((r) => `${r.entity_id}:${r.data.enabled}`),
    ["clans:false", "clans:true", "maintenance:true", "maintenance:false"],
  );
  // The status panel reads real state and never secret values.
  await recordRun(db, "maintenance", { mail: 0 });
  const s = await systemStatus(db);
  assert.equal(s.runs[0].name, "maintenance");
  assert.equal(s.features.find((f) => f.key === "clans")?.enabled, true);
  assert.ok(s.migration && s.migration.id >= 21);
  assert.ok(!JSON.stringify(s).includes(process.env.MFA_SECRET_KEY ?? "no-key-set-in-this-test"));
});

test("a private profile opened by staff with the users section is marked and recorded; other roles see it hidden", async () => {
  const owner = await mk("st_private");
  await db.query("update users set profile_public = false where id = $1", [owner.id]);
  const support = await withRole("st_sp2", "support");
  const marketer = await withRole("st_mk3", "marketing");
  const stranger = await mk("st_stranger");
  assert.equal((await playerProfile(db, "st_private", stranger))?.hidden, true);
  assert.equal((await playerProfile(db, "st_private", marketer))?.hidden, true);
  const seen = await playerProfile(db, "st_private", support);
  assert.equal(seen?.hidden, false);
  assert.equal(seen && !seen.hidden && seen.staffView, true);
  const self = await playerProfile(db, "st_private", owner);
  assert.equal(self && !self.hidden && self.staffView, false);
  await recordStaffView(db, support, owner.id, "profile");
  const [entry] = await db.query<{ actor_id: string; entity_id: string; data: { what: string } }>(
    "select actor_id, entity_id, data from audit_log where action = 'staff.viewed' order by id desc limit 1",
  );
  assert.deepEqual(entry, { actor_id: support.id, entity_id: owner.id, data: { what: "profile" } });
});
