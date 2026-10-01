import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { deleteAccount, exportAccount, signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createChallenge } from "../src/server/challenges.ts";
import { createParty, inviteToParty, joinQuickMatch, respondPartyInvite } from "../src/server/quickmatch.ts";
import { createOrg } from "../src/server/teams.ts";
import { createTournament, register, transition } from "../src/server/tournaments.ts";
import {
  conductQueue,
  currentRules,
  decideAppeal,
  dismissReport,
  evidenceIntact,
  fileAppeal,
  fileReport,
  issueSanction,
  myConduct,
  publishRule,
  revokeSanction,
  takeReport,
  trustReport,
  type IssueInput,
} from "../src/server/conduct.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
const PASSWORD = "correct horse battery";
const tokens = new Map<string, string>();
async function mk(name: string): Promise<SessionUser> {
  const s = await signUp(db, { email: `${name}@example.com`, username: name, displayName: name.toUpperCase(), password: PASSWORD, adult: "on", terms: "on" });
  tokens.set(name, s.token);
  return (await sessionUser(db, s.token))!;
}
/** The player's session as the server sees it now (roles, restriction). */
const fresh = async (u: SessionUser) => (await sessionUser(db, tokens.get(u.username)))!;
async function staffUser(name: string, role: "admin" | "support"): Promise<SessionUser> {
  const u = await mk(name);
  await db.query("insert into user_roles (user_id, role) values ($1, $2)", [u.id, role]);
  return fresh(u);
}
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}
const notes = (userId: string, kind: string) => db.query<{ data: Record<string, string> }>("select data from notifications where user_id = $1 and kind = $2", [userId, kind]);
const base = (username: string, extra: Partial<IssueInput> = {}): IssueInput => ({
  username,
  kind: "warning",
  protective: "",
  rule: "CHEATING",
  confidence: "medium",
  days: "",
  hours: "",
  evidence: "/ru/matches/00000000-0000-0000-0000-000000000001 — демо раунда 7",
  decision: "Сторонняя программа видна на записи раунда 7 и 9.",
  report: "",
  ...extra,
});

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
});
test.after(async () => {
  await db.close();
});

test("the rules restate the Terms of use and are versioned; only an administrator publishes a new version", async () => {
  const rules = await currentRules(db);
  assert.deepEqual(rules.map((r) => r.code), ["ACCOUNTS", "CHEATING", "CONTENT", "MATCH_FIXING", "PRESSURE", "STAKES"]);
  assert.ok(rules.every((r) => r.version === 1 && r.source_ru.includes("2026-09-27.2")));
  const support = await staffUser("cd_support0", "support");
  const admin = await staffUser("cd_admin0", "admin");
  const text = { code: "CHEATING", titleRu: "Читы и эксплойты", titleEn: "Cheats and exploits", bodyRu: "Запрещены читы, эксплойты и макросы.", bodyEn: "Cheats, exploits and macros are prohibited.", sourceRu: "", sourceEn: "" };
  await rejects(publishRule(db, support, text), "forbidden");
  assert.deepEqual(await publishRule(db, admin, text), { code: "CHEATING", version: 2 });
  const cheating = (await currentRules(db)).find((r) => r.code === "CHEATING");
  assert.equal(cheating?.version, 2, "the current version moves on");
  const [old] = await db.query<{ retired_at: Date | null }>("select retired_at from conduct_rules where code = 'CHEATING' and version = 1");
  assert.ok(old.retired_at, "the previous version is kept, retired");
});

test("report → review → queue ban: the player leaves the queue, cannot queue or challenge, the reporter learns the outcome only", async () => {
  const staff = await staffUser("cd_staff1", "support");
  const reporter = await mk("cd_rep1");
  const cheat = await mk("cd_cheat1");
  const other = await mk("cd_other1");
  await rejects(fileReport(db, reporter, { username: reporter.username, rule: "CHEATING", context: "", description: "x".repeat(25), evidence: "" }), "invalid_input");
  await rejects(fileReport(db, reporter, { username: cheat.username, rule: "NOPE", context: "", description: "x".repeat(25), evidence: "" }), "rule_not_found");
  await rejects(fileReport(db, reporter, { username: cheat.username, rule: "CHEATING", context: "javascript:1", description: "x".repeat(25), evidence: "" }), "invalid_url");
  const report = await fileReport(db, reporter, { username: cheat.username, rule: "CHEATING", context: "/ru/matches/abc", description: "Видно стороннюю программу на трансляции матча.", evidence: "https://example.org/vod" });
  assert.equal(report.created, true);
  assert.deepEqual(await fileReport(db, reporter, { username: cheat.username, rule: "OTHER", context: "", description: "Ещё одно сообщение о том же игроке.", evidence: "" }), { id: report.id, created: false }, "one open report per reporter and player");
  assert.equal((await notes(staff.id, "conduct_report")).length, 1, "staff are told once; the repeat creates nothing");
  assert.deepEqual(await takeReport(db, staff, report.id), { changed: true });
  const queue = await conductQueue(db);
  assert.equal(queue.reports.find((r) => r.id === report.id)?.assignee, staff.username);
  // The player waits in quick match when the ban is issued.
  await joinQuickMatch(db, cheat, "cs2");
  await rejects(issueSanction(db, staff, base(cheat.username, { kind: "queue_ban", confidence: "low", days: "7", report: report.id })), "sanction_confidence");
  await rejects(issueSanction(db, reporter, base(cheat.username, { kind: "queue_ban", days: "7" })), "forbidden");
  await rejects(issueSanction(db, staff, base(staff.username)), "cannot_modify_self");
  await rejects(issueSanction(db, staff, base(cheat.username, { evidence: "ftp://x" })), "invalid_evidence");
  await rejects(issueSanction(db, staff, base(cheat.username, { report: report.id, username: other.username })), "not_found");
  const ban = await issueSanction(db, staff, base(cheat.username, { kind: "queue_ban", days: "7", report: report.id }));
  assert.ok(ban.id);
  assert.equal((await db.query("select 1 from quick_queue where user_id = $1", [cheat.id])).length, 0, "the banned player left the queue");
  await rejects(joinQuickMatch(db, cheat, "cs2"), "queue_restricted");
  await rejects(createChallenge(db, cheat, { opponent: other.username, game: "cs2", message: "" }), "queue_restricted");
  await rejects(createChallenge(db, other, { opponent: cheat.username, game: "cs2", message: "" }), "queue_restricted");
  // A party with the banned player cannot queue either.
  await createParty(db, other, "dota2");
  await inviteToParty(db, other, cheat.username);
  const [inv] = await db.query<{ id: string }>("select id from party_invites where user_id = $1 and status = 'pending'", [cheat.id]);
  await respondPartyInvite(db, cheat, inv.id, true);
  await rejects(joinQuickMatch(db, other, "dota2"), "queue_restricted");
  // The reporter sees the outcome, not the sanction; the player sees everything about it.
  const [closed] = await notes(reporter.id, "report_closed");
  assert.equal(closed.data.outcome, "actioned");
  const mine = await myConduct(db, reporter.id);
  assert.equal(mine.reports[0].status, "actioned");
  assert.equal(mine.sanctions.length, 0);
  const theirs = await myConduct(db, cheat.id);
  assert.equal(theirs.sanctions[0].kind, "queue_ban");
  assert.equal(theirs.sanctions[0].rule_code, "CHEATING");
  assert.equal(theirs.sanctions[0].live, true);
  assert.equal(theirs.sanctions[0].appealable, true);
  assert.equal(evidenceIntact(theirs.sanctions[0]), true);
  assert.equal((await fresh(cheat)).restricted, false, "a queue ban does not restrict the account");
  const [logged] = await db.query<{ data: { evidenceHash: string } }>("select data from audit_log where action = 'sanction.issued' and entity_id = $1", [ban.id]);
  assert.equal(logged.data.evidenceHash, theirs.sanctions[0].evidence_hash, "the evidence digest is in the hash-chained log");
  // Tampering with stored evidence is detectable.
  await db.query(`update sanctions set evidence = '[{"url":"/ru/matches/x","note":"changed"}]' where id = $1`, [ban.id]);
  assert.equal(evidenceIntact((await myConduct(db, cheat.id)).sanctions[0]), false);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("suspension: high confidence only; the account reads and appeals; another staff member grants the appeal and lifts it", async () => {
  const issuer = await staffUser("cd_issuer2", "support");
  const reviewer = await staffUser("cd_review2", "admin");
  const player = await mk("cd_player2");
  const org = await mk("cd_org2");
  await rejects(issueSanction(db, issuer, base(player.username, { kind: "suspension", confidence: "medium", days: "30" })), "sanction_confidence");
  await rejects(issueSanction(db, issuer, base(player.username, { kind: "suspension", confidence: "high", days: "400" })), "sanction_term");
  const s = await issueSanction(db, issuer, base(player.username, { kind: "suspension", confidence: "high", days: "30", rule: "MATCH_FIXING", decision: "Сговор о счёте подтверждён перепиской и записью матча." }));
  assert.equal((await fresh(player)).restricted, true, "the session carries the restriction");
  assert.equal((await notes(player.id, "sanction_issued")).length, 1);
  // Tournament entry is refused for a suspended player.
  const space = await createOrg(db, org, { name: "Conduct Cup Org", description: "" });
  const t = await createTournament(db, org, space.id, {
    name: "Conduct Cup", game: "cs2", participantType: "solo", teamSize: 1, maxParticipants: 8, checkInRequired: "", region: "", startsAt: "2030-03-01T12:00", timeZone: "UTC", description: "", rules: "",
  } as never);
  await transition(db, org, t.id, "PUBLISHED");
  await transition(db, org, t.id, "REGISTRATION_OPEN");
  await rejects(register(db, player, t.id), "tournament_restricted");
  // Appeal: once, decided by someone other than the issuer.
  await rejects(fileAppeal(db, player, s.id, "коротко", ""), "invalid_input");
  await fileAppeal(db, player, s.id, "Переписка вырвана из контекста, прилагаю полную запись.", "https://example.org/full");
  await rejects(fileAppeal(db, player, s.id, "Повторная апелляция с другими словами.", ""), "appeal_exists");
  assert.equal((await notes(reviewer.id, "conduct_appeal")).length, 1);
  const { appeals } = await conductQueue(db);
  const appeal = appeals.find((a) => a.sanction_id === s.id)!;
  await rejects(decideAppeal(db, issuer, appeal.id, true, "Пересмотрел своё решение и отменяю меру."), "appeal_needs_other_reviewer");
  assert.deepEqual(await decideAppeal(db, reviewer, appeal.id, true, "Полная запись показывает, что сговора не было."), { changed: true });
  assert.deepEqual(await decideAppeal(db, reviewer, appeal.id, false, "Повторное решение ничего не меняет."), { changed: false });
  assert.equal((await fresh(player)).restricted, false, "a granted appeal lifts the restriction");
  const view = (await myConduct(db, player.id)).sanctions[0];
  assert.equal(view.appeal_status, "granted");
  assert.ok(view.revoked_at);
  assert.equal((await notes(player.id, "appeal_decided"))[0].data.outcome, "granted");
  await register(db, player, t.id);
  await rejects(fileAppeal(db, player, s.id, "Ещё одна апелляция после отмены меры.", ""), "appeal_closed");
});

test("protective hold: only on a report, up to 72 hours; dismissing the report lifts it", async () => {
  const staff = await staffUser("cd_staff3", "support");
  const reporter = await mk("cd_rep3");
  const player = await mk("cd_player3");
  await rejects(issueSanction(db, staff, base(player.username, { kind: "suspension", protective: "1", hours: "24", confidence: "low" })), "sanction_term");
  const report = await fileReport(db, reporter, { username: player.username, rule: "ACCOUNTS", context: "", description: "Играет с чужого аккаунта, голос на трансляции другой.", evidence: "" });
  await rejects(issueSanction(db, staff, base(player.username, { kind: "suspension", protective: "1", hours: "100", confidence: "low", report: report.id })), "sanction_term");
  await issueSanction(db, staff, base(player.username, { kind: "suspension", protective: "1", hours: "48", confidence: "low", rule: "ACCOUNTS", report: report.id }));
  assert.equal((await fresh(player)).restricted, true);
  const [r] = await db.query<{ status: string }>("select status from conduct_reports where id = $1", [report.id]);
  assert.equal(r.status, "reviewing", "a protective hold keeps the report open");
  await rejects(dismissReport(db, staff, report.id, "коротко"), "invalid_input");
  await dismissReport(db, staff, report.id, "Голос совпадает с владельцем аккаунта по прошлым записям.");
  assert.equal((await fresh(player)).restricted, false, "the hold is lifted with the report");
  assert.equal((await notes(reporter.id, "report_closed"))[0].data.outcome, "dismissed");
});

test("revocation as a correction, reporting limits, anonymised public counts, export and erasure", async () => {
  const staff = await staffUser("cd_staff4", "support");
  const player = await mk("cd_player4");
  const reporter = await mk("cd_rep4");
  const warning = await issueSanction(db, staff, base(player.username, { rule: "CONTENT", decision: "Оскорбления в описании команды, текст сохранён." }));
  await rejects(revokeSanction(db, staff, warning.id, "ошибка"), "invalid_input");
  assert.deepEqual(await revokeSanction(db, staff, warning.id, "Мера выдана не тому игроку, исправлено."), { changed: true });
  assert.deepEqual(await revokeSanction(db, staff, warning.id, "Повторная отмена ничего не меняет."), { changed: false });
  // Ten reports a day at most.
  const targets = await Promise.all(Array.from({ length: 11 }, (_, i) => mk(`cd_t4_${i}`)));
  for (const t of targets.slice(0, 10))
    await fileReport(db, reporter, { username: t.username, rule: "PRESSURE", context: "", description: "Давит на судью в чате матча после решения.", evidence: "" });
  await rejects(fileReport(db, reporter, { username: targets[10].username, rule: "PRESSURE", context: "", description: "Давит на судью в чате матча после решения.", evidence: "" }), "report_limit");
  // Public reporting: counts only, small numbers hidden by the page.
  const report = await trustReport(db);
  assert.ok(report.counts.reports_received >= 12);
  assert.equal(typeof report.counts.corrections, "number");
  assert.ok(report.counts.corrections >= 1);
  // Export and erasure: the reporter's open reports go with the account; decided ones stay as the record.
  const data = (await exportAccount(db, player)) as unknown as { sanctions: unknown[] };
  assert.equal(data.sanctions.length, 1);
  const before = await db.query("select 1 from conduct_reports where reporter_id = $1", [reporter.id]);
  assert.equal(before.length, 10);
  await deleteAccount(db, reporter, PASSWORD);
  const after = await db.query("select 1 from conduct_reports where reporter_id = $1", [reporter.id]);
  assert.equal(after.length, 0);
  assert.equal((await verifyAuditChain(db)).valid, true);
});
