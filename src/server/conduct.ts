/**
 * Fair play (MV-CONDUCT-1): reports about players, sanctions and appeals.
 *
 * - Every sanction cites a rule version, lists its evidence (with a SHA-256 digest of that list, repeated in
 *   the hash-chained audit log, so a later change is detectable), states a confidence level and a decision.
 * - Kinds: warning (a record, no restriction); queue ban (quick match and challenges); tournament ban
 *   (registrations and roster entries); suspension (the account can read and appeal, nothing else).
 * - Policy: a queue or tournament ban needs medium or high confidence and a term of 1–365 days; a final
 *   suspension needs high confidence and a term of 1–365 days or no end. A protective hold is a suspension
 *   of up to 72 hours while a report is investigated, at any confidence; the final decision on that report
 *   lifts it.
 * - The sanctioned player sees the rule, decision, evidence and term, and may appeal once within 14 days;
 *   the appeal is decided by a staff member other than the one who issued the sanction.
 * - Reports: one open report per reporter and player, at most 10 a day per reporter. The reporter learns
 *   whether action was taken, not the sanction itself.
 */
import { createHash } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit, canonical } from "./audit.ts";
import { isStaff, notify } from "./access.ts";
import { fail } from "./errors.ts";
import { removeFromQueue } from "./quickmatch.ts";
import * as v from "./validate.ts";

export const SANCTION_KINDS = ["warning", "queue_ban", "tournament_ban", "suspension"] as const;
export type SanctionKind = (typeof SANCTION_KINDS)[number];
export const CONFIDENCE = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCE)[number];
export const APPEAL_DAYS = 14;
export const PROTECTIVE_MAX_HOURS = 72;
export const MAX_DAYS = 365;
export const REPORTS_PER_DAY = 10;
/** Public counts below this are shown as "fewer than 3", so a small number does not point at a person. */
export const MIN_PUBLIC_COUNT = 3;
export const OTHER_RULE = "OTHER";

export type EvidenceItem = { url: string; note: string };

const isId = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x);

/** Evidence: one item per line, "link — note"; a portal path (/ru/…) or an https link; 1–10 items. */
export function parseEvidence(input: unknown): EvidenceItem[] {
  const lines = String(input ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length || lines.length > 10) fail("invalid_evidence");
  return lines.map((line) => {
    const [first, ...rest] = line.split(/\s+/);
    const url = first.replace(/[—–-]+$/, "");
    const portal = /^\/(ru|en)\/[A-Za-z0-9/_\-.?=&#%]{1,300}$/.test(url);
    const web = /^https:\/\/[^\s<>"']{4,500}$/.test(url);
    if (!portal && !web) fail("invalid_evidence");
    const note = rest.join(" ").replace(/^[—–-]\s*/, "").slice(0, 200);
    return { url, note };
  });
}

/** SHA-256 of the canonical evidence list. */
export const evidenceHash = (evidence: EvidenceItem[]) => createHash("sha256").update(canonical(evidence)).digest("hex");

/**
 * MV-CONDUCT-1 term and confidence rules. Returns the end of the sanction (null: no end) or fails with
 * `sanction_confidence` / `sanction_term`.
 */
export function sanctionTerm(
  input: { kind: SanctionKind; protective: boolean; confidence: Confidence; days: number | null; hours: number | null },
  now: Date,
): Date | null {
  const { kind, protective, confidence, days, hours } = input;
  if (protective) {
    if (kind !== "suspension") fail("sanction_term");
    if (hours === null || !Number.isInteger(hours) || hours < 1 || hours > PROTECTIVE_MAX_HOURS) fail("sanction_term");
    return new Date(now.getTime() + hours! * 3600_000);
  }
  if (kind === "warning") return null;
  if (kind === "suspension" && confidence !== "high") fail("sanction_confidence");
  if (confidence === "low") fail("sanction_confidence");
  if (days === null) {
    if (kind !== "suspension") fail("sanction_term");
    return null;
  }
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) fail("sanction_term");
  return new Date(now.getTime() + days * 86_400_000);
}

const optionalInt = (x: unknown): number | null => {
  const s = String(x ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : NaN;
};

async function staffIds(q: Queryable): Promise<string[]> {
  return (await q.query<{ user_id: string }>("select distinct user_id from user_roles where role in ('admin','support')")).map((r) => r.user_id);
}

export type RuleRow = { code: string; version: number; title_ru: string; title_en: string; body_ru: string; body_en: string; source_ru: string; source_en: string; created_at: Date };

/** Rules in force: the current version of each code. */
export async function currentRules(q: Queryable): Promise<RuleRow[]> {
  return q.query<RuleRow>(
    "select code, version, title_ru, title_en, body_ru, body_en, source_ru, source_en, created_at from conduct_rules where retired_at is null order by code",
  );
}

// ---------- Reports ----------

/** A signed-in player reports another player under a rule (or OTHER) with a description and optional links. */
export async function fileReport(
  db: Database,
  user: SessionUser,
  input: { username: unknown; rule: unknown; context: unknown; description: unknown; evidence: unknown },
): Promise<{ id: string; created: boolean }> {
  const username = v.username(input.username);
  const description = v.clean(input.description, 2000);
  if (description.length < 20) fail("invalid_input");
  const context = String(input.context ?? "").trim();
  if (context && !/^\/(ru|en)\/[A-Za-z0-9/_\-.?=&#%]{1,300}$/.test(context)) fail("invalid_url");
  const evidence = v.optionalUrl(input.evidence);
  const rule = String(input.rule ?? "").trim().toUpperCase();
  return db.tx(async (q) => {
    const [subject] = await q.query<{ id: string }>("select id from users where username = $1 and status = 'active'", [username]);
    if (!subject) fail("not_found");
    if (subject.id === user.id) fail("invalid_input");
    if (rule !== OTHER_RULE) {
      const [known] = await q.query("select 1 from conduct_rules where code = $1 and retired_at is null", [rule]);
      if (!known) fail("rule_not_found");
    }
    const [open] = await q.query<{ id: string }>("select id from conduct_reports where reporter_id = $1 and subject_id = $2 and status in ('open','reviewing')", [user.id, subject.id]);
    if (open) return { id: open.id, created: false };
    const [recent] = await q.query<{ n: number }>("select count(*)::int as n from conduct_reports where reporter_id = $1 and created_at > now() - interval '24 hours'", [user.id]);
    if ((recent?.n ?? 0) >= REPORTS_PER_DAY) fail("report_limit");
    const [row] = await q.query<{ id: string }>(
      "insert into conduct_reports (reporter_id, subject_id, rule_code, context_url, description, evidence_url) values ($1, $2, $3, $4, $5, $6) returning id",
      [user.id, subject.id, rule, context, description, evidence],
    );
    await notify(q, await staffIds(q), "conduct_report", { conductAdmin: "1" });
    await audit(q, { actorId: user.id, action: "conduct.reported", entity: "report", entityId: row.id, data: { subject: subject.id, rule } });
    return { id: row.id, created: true };
  });
}

/** Staff take a report into review (assigned to themselves). */
export async function takeReport(db: Database, staff: SessionUser, reportId: unknown): Promise<{ changed: boolean }> {
  if (!isStaff(staff)) fail("forbidden");
  if (!isId(reportId)) fail("not_found");
  return db.tx(async (q) => {
    const [r] = await q.query<{ status: string; assigned_to: string | null }>("select status, assigned_to from conduct_reports where id = $1 for update", [reportId]);
    if (!r) fail("not_found");
    if (!["open", "reviewing"].includes(r.status) || r.assigned_to === staff.id) return { changed: false };
    await q.query("update conduct_reports set status = 'reviewing', assigned_to = $2 where id = $1", [reportId, staff.id]);
    await audit(q, { actorId: staff.id, action: "conduct.report_taken", entity: "report", entityId: reportId as string });
    return { changed: true };
  });
}

/** Staff close a report without a sanction; a protective hold opened for it is lifted. */
export async function dismissReport(db: Database, staff: SessionUser, reportId: unknown, reasonInput: unknown): Promise<{ changed: boolean }> {
  if (!isStaff(staff)) fail("forbidden");
  if (!isId(reportId)) fail("not_found");
  const reason = v.clean(reasonInput, 1000);
  if (reason.length < 10) fail("invalid_input");
  return db.tx(async (q) => {
    const [r] = await q.query<{ status: string; reporter_id: string }>("select status, reporter_id from conduct_reports where id = $1 for update", [reportId]);
    if (!r) fail("not_found");
    if (!["open", "reviewing"].includes(r.status)) return { changed: false };
    await q.query("update conduct_reports set status = 'dismissed', resolution = $2, resolved_by = $3, resolved_at = now() where id = $1", [reportId, reason, staff.id]);
    await liftProtective(q, reportId as string, staff.id, "report dismissed");
    await notify(q, [r.reporter_id], "report_closed", { outcome: "dismissed", conduct: "1" });
    await audit(q, { actorId: staff.id, action: "conduct.report_dismissed", entity: "report", entityId: reportId as string, data: { reason } });
    return { changed: true };
  });
}

async function liftProtective(q: Queryable, reportId: string, staffId: string, reason: string) {
  const held = await q.query<{ id: string; user_id: string }>(
    "update sanctions set revoked_at = now(), revoked_by = $2, revoke_reason = $3 where report_id = $1 and protective and revoked_at is null and (ends_at is null or ends_at > now()) returning id, user_id",
    [reportId, staffId, reason],
  );
  for (const h of held) await audit(q, { actorId: staffId, action: "sanction.protective_lifted", entity: "sanction", entityId: h.id, data: { report: reportId, reason } });
  return held;
}

// ---------- Sanctions ----------

export type IssueInput = {
  username: unknown;
  kind: unknown;
  protective: unknown;
  rule: unknown;
  confidence: unknown;
  days: unknown;
  hours: unknown;
  evidence: unknown;
  decision: unknown;
  report: unknown;
};

/** Staff issue a sanction under MV-CONDUCT-1; a final decision on a report closes it and lifts its protective hold. */
export async function issueSanction(db: Database, staff: SessionUser, input: IssueInput): Promise<{ id: string }> {
  if (!isStaff(staff)) fail("forbidden");
  const username = v.username(input.username);
  const kind = (SANCTION_KINDS as readonly string[]).includes(String(input.kind)) ? (input.kind as SanctionKind) : fail("invalid_input");
  const confidence = (CONFIDENCE as readonly string[]).includes(String(input.confidence)) ? (input.confidence as Confidence) : fail("invalid_input");
  const protective = v.bool(input.protective);
  const days = optionalInt(input.days);
  const hours = optionalInt(input.hours);
  const evidence = parseEvidence(input.evidence);
  const decision = v.clean(input.decision, 2000);
  if (decision.length < 20) fail("invalid_input");
  const reportId = String(input.report ?? "").trim();
  if (reportId && !isId(reportId)) fail("not_found");
  if (protective && !reportId) fail("sanction_term");
  const result = await db.tx(async (q) => {
    const [subject] = await q.query<{ id: string }>("select id from users where username = $1 and status <> 'deleted'", [username]);
    if (!subject) fail("not_found");
    if (subject.id === staff.id) fail("cannot_modify_self");
    const [rule] = await q.query<{ code: string; version: number }>("select code, version from conduct_rules where code = $1 and retired_at is null", [String(input.rule ?? "").toUpperCase()]);
    if (!rule) fail("rule_not_found");
    const [{ now }] = await q.query<{ now: Date }>("select now() as now");
    const endsAt = sanctionTerm({ kind, protective, confidence, days: Number.isNaN(days) ? -1 : days, hours: Number.isNaN(hours) ? -1 : hours }, new Date(now));
    let report: { id: string; reporter_id: string; subject_id: string; status: string } | undefined;
    if (reportId) {
      [report] = await q.query<{ id: string; reporter_id: string; subject_id: string; status: string }>(
        "select id, reporter_id, subject_id, status from conduct_reports where id = $1 for update",
        [reportId],
      );
      if (!report || report.subject_id !== subject.id || !["open", "reviewing"].includes(report.status)) fail("not_found");
    }
    const hash = evidenceHash(evidence);
    const [row] = await q.query<{ id: string }>(
      `insert into sanctions (user_id, kind, protective, rule_code, rule_version, confidence, evidence, evidence_hash, decision, report_id, issued_by, starts_at, ends_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), $12) returning id`,
      [subject.id, kind, protective, rule.code, rule.version, confidence, JSON.stringify(evidence), hash, decision, report?.id ?? null, staff.id, endsAt],
    );
    if (report && !protective) {
      await q.query("update conduct_reports set status = 'actioned', resolution = $2, resolved_by = $3, resolved_at = now() where id = $1", [report.id, decision, staff.id]);
      await liftProtective(q, report.id, staff.id, "final decision");
      await notify(q, [report.reporter_id], "report_closed", { outcome: "actioned", conduct: "1" });
    } else if (report) {
      await q.query("update conduct_reports set status = 'reviewing', assigned_to = coalesce(assigned_to, $2) where id = $1", [report.id, staff.id]);
    }
    await notify(q, [subject.id], "sanction_issued", { kind, protective: protective ? "1" : "", conduct: "1" });
    await audit(q, {
      actorId: staff.id,
      action: protective ? "sanction.protective_hold" : "sanction.issued",
      entity: "sanction",
      entityId: row.id,
      data: { user: subject.id, kind, rule: `${rule.code}.${rule.version}`, confidence, endsAt, evidenceHash: hash, report: report?.id ?? null },
    });
    return { id: row.id, subjectId: subject.id };
  });
  // A player who may no longer queue leaves the quick-match queue (a running ready check counts as declined).
  if (kind === "queue_ban" || kind === "suspension") await removeFromQueue(db, result.subjectId, staff.id);
  return { id: result.id };
}

/** Staff revoke a sanction they find wrong (a correction); the reason is kept with it. */
export async function revokeSanction(db: Database, staff: SessionUser, sanctionId: unknown, reasonInput: unknown): Promise<{ changed: boolean }> {
  if (!isStaff(staff)) fail("forbidden");
  if (!isId(sanctionId)) fail("not_found");
  const reason = v.clean(reasonInput, 1000);
  if (reason.length < 10) fail("invalid_input");
  return db.tx(async (q) => {
    const [s] = await q.query<{ user_id: string; revoked_at: Date | null }>("select user_id, revoked_at from sanctions where id = $1 for update", [sanctionId]);
    if (!s) fail("not_found");
    if (s.revoked_at) return { changed: false };
    await q.query("update sanctions set revoked_at = now(), revoked_by = $2, revoke_reason = $3 where id = $1", [sanctionId, staff.id, reason]);
    await notify(q, [s.user_id], "sanction_revoked", { conduct: "1" });
    await audit(q, { actorId: staff.id, action: "sanction.revoked", entity: "sanction", entityId: sanctionId as string, data: { reason } });
    return { changed: true };
  });
}

// ---------- Appeals ----------

/** The sanctioned player appeals once, within 14 days, while the sanction stands. */
export async function fileAppeal(db: Database, user: SessionUser, sanctionId: unknown, statementInput: unknown, evidenceInput: unknown): Promise<{ id: string }> {
  if (!isId(sanctionId)) fail("not_found");
  const statement = v.clean(statementInput, 2000);
  if (statement.length < 20) fail("invalid_input");
  const evidence = v.optionalUrl(evidenceInput);
  return db.tx(async (q) => {
    const [s] = await q.query<{ user_id: string; revoked_at: Date | null; open: boolean }>(
      `select user_id, revoked_at, created_at > now() - ($2 || ' days')::interval as open from sanctions where id = $1 for update`,
      [sanctionId, String(APPEAL_DAYS)],
    );
    if (!s || s.user_id !== user.id) fail("not_found");
    if (s.revoked_at || !s.open) fail("appeal_closed");
    const [exists] = await q.query("select 1 from sanction_appeals where sanction_id = $1", [sanctionId]);
    if (exists) fail("appeal_exists");
    const [row] = await q.query<{ id: string }>(
      "insert into sanction_appeals (sanction_id, user_id, statement, evidence_url) values ($1, $2, $3, $4) returning id",
      [sanctionId, user.id, statement, evidence],
    );
    await notify(q, (await staffIds(q)).filter((id) => id !== user.id), "conduct_appeal", { conductAdmin: "1" });
    await audit(q, { actorId: user.id, action: "sanction.appealed", entity: "sanction", entityId: sanctionId as string, data: { appeal: row.id } });
    return { id: row.id };
  });
}

/** A staff member other than the issuer upholds the sanction or grants the appeal (the sanction is revoked). */
export async function decideAppeal(db: Database, staff: SessionUser, appealId: unknown, grant: boolean, decisionInput: unknown): Promise<{ changed: boolean }> {
  if (!isStaff(staff)) fail("forbidden");
  if (!isId(appealId)) fail("not_found");
  const decision = v.clean(decisionInput, 2000);
  if (decision.length < 20) fail("invalid_input");
  return db.tx(async (q) => {
    const [a] = await q.query<{ sanction_id: string; user_id: string; status: string }>("select sanction_id, user_id, status from sanction_appeals where id = $1 for update", [appealId]);
    if (!a) fail("not_found");
    const [s] = await q.query<{ issued_by: string; revoked_at: Date | null }>("select issued_by, revoked_at from sanctions where id = $1 for update", [a.sanction_id]);
    if (s.issued_by === staff.id) fail("appeal_needs_other_reviewer");
    if (a.status !== "open") return { changed: false };
    await q.query("update sanction_appeals set status = $2, decided_by = $3, decision = $4, decided_at = now() where id = $1", [appealId, grant ? "granted" : "upheld", staff.id, decision]);
    if (grant && !s.revoked_at)
      await q.query("update sanctions set revoked_at = now(), revoked_by = $2, revoke_reason = $3 where id = $1", [a.sanction_id, staff.id, `appeal granted: ${decision}`.slice(0, 1000)]);
    await notify(q, [a.user_id], "appeal_decided", { outcome: grant ? "granted" : "upheld", conduct: "1" });
    await audit(q, { actorId: staff.id, action: grant ? "sanction.appeal_granted" : "sanction.appeal_upheld", entity: "sanction", entityId: a.sanction_id, data: { appeal: appealId, decision } });
    return { changed: true };
  });
}

// ---------- Rules ----------

/** An administrator publishes a new version of a rule (or a new rule); the previous version is retired, not changed. */
export async function publishRule(
  db: Database,
  admin: SessionUser,
  input: { code: unknown; titleRu: unknown; titleEn: unknown; bodyRu: unknown; bodyEn: unknown; sourceRu: unknown; sourceEn: unknown },
): Promise<{ code: string; version: number }> {
  if (!admin.roles.includes("admin")) fail("forbidden");
  const code = String(input.code ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(code) || code === OTHER_RULE) fail("invalid_input");
  const titleRu = v.oneLine(input.titleRu, 120);
  const titleEn = v.oneLine(input.titleEn, 120);
  const bodyRu = v.clean(input.bodyRu, 2000);
  const bodyEn = v.clean(input.bodyEn, 2000);
  if (titleRu.length < 3 || titleEn.length < 3 || bodyRu.length < 10 || bodyEn.length < 10) fail("invalid_input");
  const sourceRu = v.oneLine(input.sourceRu, 200);
  const sourceEn = v.oneLine(input.sourceEn, 200);
  return db.tx(async (q) => {
    await q.query("select pg_advisory_xact_lock(hashtext($1))", [`rule:${code}`]);
    const [last] = await q.query<{ version: number }>("select max(version)::int as version from conduct_rules where code = $1", [code]);
    const version = (last?.version ?? 0) + 1;
    await q.query("update conduct_rules set retired_at = now() where code = $1 and retired_at is null", [code]);
    await q.query(
      "insert into conduct_rules (code, version, title_ru, title_en, body_ru, body_en, source_ru, source_en, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [code, version, titleRu, titleEn, bodyRu, bodyEn, sourceRu, sourceEn, admin.id],
    );
    await audit(q, { actorId: admin.id, action: "conduct.rule_published", entity: "rule", entityId: `${code}.${version}`, data: { titleRu, titleEn } });
    return { code, version };
  });
}

// ---------- Views ----------

export type SanctionView = {
  id: string;
  kind: SanctionKind;
  protective: boolean;
  rule_code: string;
  rule_version: number;
  title_ru: string;
  title_en: string;
  confidence: Confidence;
  evidence: EvidenceItem[];
  evidence_hash: string;
  decision: string;
  starts_at: Date;
  ends_at: Date | null;
  revoked_at: Date | null;
  revoke_reason: string;
  created_at: Date;
  live: boolean;
  appealable: boolean;
  appeal_status: string | null;
  appeal_decision: string | null;
};

const SANCTION_VIEW = `s.id, s.kind, s.protective, s.rule_code, s.rule_version, r.title_ru, r.title_en, s.confidence, s.evidence, s.evidence_hash,
       s.decision, s.starts_at, s.ends_at, s.revoked_at, s.revoke_reason, s.created_at,
       (s.revoked_at is null and s.starts_at <= now() and (s.ends_at is null or s.ends_at > now())) as live,
       (s.revoked_at is null and s.created_at > now() - interval '${APPEAL_DAYS} days' and a.id is null) as appealable,
       a.status as appeal_status, a.decision as appeal_decision`;

/** The player's own sanctions (with appeals) and the reports they filed (outcome only). */
export async function myConduct(q: Queryable, userId: string) {
  const sanctions = await q.query<SanctionView>(
    `select ${SANCTION_VIEW}
       from sanctions s join conduct_rules r on r.code = s.rule_code and r.version = s.rule_version
       left join sanction_appeals a on a.sanction_id = s.id
      where s.user_id = $1 order by s.created_at desc`,
    [userId],
  );
  const reports = await q.query<{ id: string; subject: string; rule_code: string; status: string; created_at: Date; resolved_at: Date | null }>(
    `select c.id, u.username as subject, c.rule_code, c.status, c.created_at, c.resolved_at
       from conduct_reports c join users u on u.id = c.subject_id where c.reporter_id = $1 order by c.created_at desc limit 30`,
    [userId],
  );
  return { sanctions, reports };
}

/** Recomputes the evidence digest of a stored sanction: false means the evidence changed after issue. */
export const evidenceIntact = (s: { evidence: EvidenceItem[]; evidence_hash: string }) => evidenceHash(s.evidence) === s.evidence_hash;

/** The staff queue: open reports, open appeals, live sanctions. */
export async function conductQueue(q: Queryable) {
  const reports = await q.query<{
    id: string; reporter: string; subject: string; subject_id: string; rule_code: string; context_url: string; description: string; evidence_url: string;
    status: string; assignee: string | null; created_at: Date; prior: number;
  }>(
    `select c.id, ru.username as reporter, su.username as subject, c.subject_id, c.rule_code, c.context_url, c.description, c.evidence_url, c.status,
            au.username as assignee, c.created_at,
            (select count(*)::int from sanctions s where s.user_id = c.subject_id and s.revoked_at is null) as prior
       from conduct_reports c join users ru on ru.id = c.reporter_id join users su on su.id = c.subject_id left join users au on au.id = c.assigned_to
      where c.status in ('open','reviewing') order by c.created_at limit 100`,
  );
  const appeals = await q.query<{
    id: string; sanction_id: string; username: string; statement: string; evidence_url: string; created_at: Date; kind: string; rule_code: string;
    rule_version: number; decision: string; issued_by: string; issuer: string; ends_at: Date | null;
  }>(
    `select a.id, a.sanction_id, u.username, a.statement, a.evidence_url, a.created_at, s.kind, s.rule_code, s.rule_version, s.decision, s.issued_by,
            iu.username as issuer, s.ends_at
       from sanction_appeals a join sanctions s on s.id = a.sanction_id join users u on u.id = a.user_id join users iu on iu.id = s.issued_by
      where a.status = 'open' order by a.created_at`,
  );
  const sanctions = await q.query<SanctionView & { username: string; issuer: string }>(
    `select ${SANCTION_VIEW}, u.username, iu.username as issuer
       from sanctions s join conduct_rules r on r.code = s.rule_code and r.version = s.rule_version
       join users u on u.id = s.user_id join users iu on iu.id = s.issued_by
       left join sanction_appeals a on a.sanction_id = s.id
      where s.revoked_at is null and (s.ends_at is null or s.ends_at > now()) order by s.created_at desc limit 100`,
  );
  return { reports, appeals, sanctions };
}

/** Public, anonymised reporting: counts only, small numbers hidden; open investigations are not shown. */
export async function trustReport(q: Queryable) {
  const [row] = await q.query<Record<string, number>>(
    `select
       (select count(*)::int from conduct_reports where created_at > now() - interval '90 days') as reports_received,
       (select count(*)::int from conduct_reports where status = 'actioned' and resolved_at > now() - interval '90 days') as reports_actioned,
       (select count(*)::int from conduct_reports where status = 'dismissed' and resolved_at > now() - interval '90 days') as reports_dismissed,
       (select count(*)::int from sanctions where kind = 'warning' and created_at > now() - interval '90 days') as warnings,
       (select count(*)::int from sanctions where kind = 'queue_ban' and created_at > now() - interval '90 days') as queue_bans,
       (select count(*)::int from sanctions where kind = 'tournament_ban' and created_at > now() - interval '90 days') as tournament_bans,
       (select count(*)::int from sanctions where kind = 'suspension' and not protective and created_at > now() - interval '90 days') as suspensions,
       (select count(*)::int from sanctions where protective and created_at > now() - interval '90 days') as protective_holds,
       (select count(*)::int from sanction_appeals where status = 'upheld' and decided_at > now() - interval '90 days') as appeals_upheld,
       (select count(*)::int from sanction_appeals where status = 'granted' and decided_at > now() - interval '90 days') as appeals_granted,
       (select count(*)::int from sanctions where revoked_at is not null and revoke_reason not like 'appeal granted:%' and not protective
          and revoked_at > now() - interval '90 days') as corrections`,
  );
  const [median] = await q.query<{ days: number | null }>(
    `select round((percentile_cont(0.5) within group (order by extract(epoch from resolved_at - created_at)) / 86400)::numeric, 1)::float as days
       from conduct_reports where resolved_at is not null and resolved_at > now() - interval '90 days'`,
  );
  return { counts: row, medianDays: median?.days ?? null };
}

/** Shows a public count, or null when it is small enough to point at a person. */
export const publicCount = (n: number) => (n > 0 && n < MIN_PUBLIC_COUNT ? null : n);
