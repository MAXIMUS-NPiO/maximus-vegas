import Link from "next/link";
import type { Locale } from "@/lib/i18n.ts";
import { conductText } from "@/lib/conduct-text.ts";
import type { Database } from "@/server/db.ts";
import type { SessionUser } from "@/server/auth.ts";
import { CONFIDENCE, conductQueue, currentRules, evidenceIntact, OTHER_RULE, PROTECTIVE_MAX_HOURS, SANCTION_KINDS } from "@/server/conduct.ts";
import { ActionForm, Badge, Empty, Field } from "@/components/ui";
import { LocalTime } from "@/components/time";

const T = {
  ru: {
    reports: "Обращения на проверке",
    noReports: "Открытых обращений нет.",
    from: "от",
    about: "о",
    prior: "действующих мер у игрока",
    take: "Взять в работу",
    assigned: "в работе у",
    dismiss: "Закрыть без санкции",
    dismissReason: "Почему нарушение не подтверждено (от 10 символов; автор увидит только итог)",
    issue: "Вынести решение",
    issueStandalone: "Санкция без обращения",
    kind: "Мера",
    protective: "Защитная блокировка до 72 часов (только по обращению)",
    confidence: "Уверенность",
    days: "Срок, дней (1–365; пусто — без срока для окончательного ограничения аккаунта)",
    hours: `Срок защитной блокировки, часов (1–${PROTECTIVE_MAX_HOURS})`,
    evidence: "Доказательства: по одной на строку — ссылка (/ru/… или https://…), затем пояснение",
    decision: "Обоснование решения (от 20 символов; игрок увидит его)",
    username: "Имя пользователя",
    submit: "Записать решение",
    policy: "Предупреждение — любая уверенность, без срока. Запрет быстрого матча или турниров — средняя или высокая, 1–365 дней. Ограничение аккаунта — только высокая. Нужен свежий код второго фактора.",
    appeals: "Апелляции",
    noAppeals: "Открытых апелляций нет.",
    issuer: "решение вынес",
    yourDecision: "Это ваше решение: апелляцию рассматривает другой сотрудник.",
    answer: "Ответ игроку (от 20 символов)",
    grant: "Удовлетворить — отменить меру",
    uphold: "Отклонить — мера в силе",
    live: "Действующие меры",
    noLive: "Действующих мер нет.",
    revoke: "Отменить как ошибочную",
    revokeReason: "Причина отмены (от 10 символов)",
    intact: "хеш доказательств совпадает",
    broken: "ХЕШ ДОКАЗАТЕЛЬСТВ НЕ СОВПАДАЕТ",
    until: "до",
    noEnd: "без срока",
    rules: "Правила",
    newVersion: "Новая редакция или новое правило",
    code: "Код (латиница, например CHEATING)",
    titleRu: "Название (RU)",
    titleEn: "Название (EN)",
    bodyRu: "Текст (RU)",
    bodyEn: "Текст (EN)",
    sourceRu: "Источник (RU)",
    sourceEn: "Источник (EN)",
    publish: "Опубликовать",
    adminOnly: "Публикует только администратор; прежняя редакция сохраняется.",
  },
  en: {
    reports: "Reports under review",
    noReports: "No open reports.",
    from: "from",
    about: "about",
    prior: "measures in force for the player",
    take: "Take it",
    assigned: "taken by",
    dismiss: "Close without a sanction",
    dismissReason: "Why no violation is found (10 characters or more; the reporter sees only the outcome)",
    issue: "Decide",
    issueStandalone: "Sanction without a report",
    kind: "Measure",
    protective: "Protective hold up to 72 hours (only on a report)",
    confidence: "Confidence",
    days: "Term, days (1–365; empty means no end for a final account restriction)",
    hours: `Protective hold, hours (1–${PROTECTIVE_MAX_HOURS})`,
    evidence: "Evidence: one per line — a link (/en/… or https://…), then a note",
    decision: "Reasoning (20 characters or more; the player sees it)",
    username: "Username",
    submit: "Record the decision",
    policy: "Warning — any confidence, no term. Quick match or tournament ban — medium or high, 1–365 days. Account restriction — high only. A fresh second-factor code is required.",
    appeals: "Appeals",
    noAppeals: "No open appeals.",
    issuer: "issued by",
    yourDecision: "This is your decision: another staff member reviews the appeal.",
    answer: "Answer to the player (20 characters or more)",
    grant: "Grant — revoke the measure",
    uphold: "Reject — the measure stands",
    live: "Measures in force",
    noLive: "No measures in force.",
    revoke: "Revoke as a mistake",
    revokeReason: "Reason (10 characters or more)",
    intact: "evidence digest matches",
    broken: "EVIDENCE DIGEST DOES NOT MATCH",
    until: "until",
    noEnd: "no end",
    rules: "Rules",
    newVersion: "New version or new rule",
    code: "Code (Latin, e.g. CHEATING)",
    titleRu: "Title (RU)",
    titleEn: "Title (EN)",
    bodyRu: "Text (RU)",
    bodyEn: "Text (EN)",
    sourceRu: "Source (RU)",
    sourceEn: "Source (EN)",
    publish: "Publish",
    adminOnly: "Only an administrator publishes; the previous version is kept.",
  },
};

function IssueForm({
  lang,
  back,
  rules,
  username,
  report,
  defaultRule,
}: {
  lang: Locale;
  back: string;
  rules: { code: string; title: string }[];
  username?: string;
  report?: string;
  defaultRule?: string;
}) {
  const x = T[lang];
  const c = conductText[lang];
  return (
    <ActionForm action="conduct.sanction" lang={lang} back={back} hidden={report ? { report, username: username ?? "" } : undefined} className="stack-sm">
      <div className="form-grid">
        {report ? null : (
          <Field label={x.username}>
            <input name="username" required minLength={3} maxLength={24} />
          </Field>
        )}
        <Field label={x.kind}>
          <select name="kind" defaultValue="warning">
            {SANCTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {c.kinds[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={c.rule}>
          <select name="rule" defaultValue={defaultRule && defaultRule !== OTHER_RULE ? defaultRule : undefined}>
            {rules.map((r) => (
              <option key={r.code} value={r.code}>
                {r.title} ({r.code})
              </option>
            ))}
          </select>
        </Field>
        <Field label={x.confidence}>
          <select name="confidence" defaultValue="medium">
            {CONFIDENCE.map((k) => (
              <option key={k} value={k}>
                {c.confidences[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={x.days}>
          <input name="days" type="number" min={1} max={365} inputMode="numeric" />
        </Field>
        {report ? (
          <Field label={x.hours}>
            <input name="hours" type="number" min={1} max={PROTECTIVE_MAX_HOURS} inputMode="numeric" />
          </Field>
        ) : null}
      </div>
      {report ? (
        <label className="check">
          <input type="checkbox" name="protective" value="1" /> {x.protective}
        </label>
      ) : null}
      <Field label={x.evidence}>
        <textarea name="evidence" required rows={3} maxLength={3000} placeholder={`/${lang}/matches/… — …`} />
      </Field>
      <Field label={x.decision}>
        <textarea name="decision" required minLength={20} maxLength={2000} rows={3} />
      </Field>
      <p className="small muted">{x.policy}</p>
      <button className="btn btn-danger btn-sm">{x.submit}</button>
    </ActionForm>
  );
}

/** Control-centre tab: reports, appeals, measures in force, rules. */
export async function ConductTab({ db, user, lang, back }: { db: Database; user: SessionUser; lang: Locale; back: string }) {
  const x = T[lang];
  const c = conductText[lang];
  const [queue, rules] = await Promise.all([conductQueue(db), currentRules(db)]);
  const ruleList = rules.map((r) => ({ code: r.code, title: lang === "ru" ? r.title_ru : r.title_en }));
  const admin = user.roles.includes("admin");
  return (
    <div className="stack">
      <section className="stack-sm">
        <h2 className="h3">{x.reports}</h2>
        {queue.reports.length ? (
          <ul className="list">
            {queue.reports.map((r) => (
              <li key={r.id} className="stack-sm">
                <div className="row-between">
                  <span>
                    <strong>{r.rule_code === OTHER_RULE ? c.ruleOther : r.rule_code}</strong> · {x.about}{" "}
                    <Link href={`/${lang}/players/${r.subject}`} className="text-link">
                      @{r.subject}
                    </Link>{" "}
                    · {x.from} @{r.reporter} · <LocalTime iso={r.created_at} lang={lang} />
                  </span>
                  <span className="small muted">
                    {x.prior}: {r.prior}
                  </span>
                </div>
                <p className="small prewrap">{r.description}</p>
                <p className="small">
                  {r.context_url ? (
                    <Link href={r.context_url} className="text-link">
                      {r.context_url}
                    </Link>
                  ) : null}
                  {r.evidence_url ? (
                    <>
                      {" "}
                      ·{" "}
                      <a href={r.evidence_url} rel="noopener noreferrer nofollow" target="_blank" className="text-link">
                        {r.evidence_url}
                      </a>
                    </>
                  ) : null}
                </p>
                <div className="row">
                  {r.assignee ? (
                    <Badge status="info">
                      {x.assigned} @{r.assignee}
                    </Badge>
                  ) : (
                    <ActionForm action="conduct.take" lang={lang} back={back} hidden={{ report: r.id }}>
                      <button className="btn btn-ghost btn-xs">{x.take}</button>
                    </ActionForm>
                  )}
                  <details className="disclosure">
                    <summary>{x.dismiss}</summary>
                    <ActionForm action="conduct.dismiss" lang={lang} back={back} hidden={{ report: r.id }} className="inline-form">
                      <input name="reason" required minLength={10} maxLength={1000} placeholder={x.dismissReason} aria-label={x.dismissReason} />
                      <button className="btn btn-ghost btn-xs">{x.dismiss}</button>
                    </ActionForm>
                  </details>
                </div>
                <details className="disclosure">
                  <summary>{x.issue}</summary>
                  <IssueForm lang={lang} back={back} rules={ruleList} username={r.subject} report={r.id} defaultRule={r.rule_code} />
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={x.noReports} />
        )}
      </section>

      <section className="stack-sm">
        <h2 className="h3">{x.appeals}</h2>
        {queue.appeals.length ? (
          <ul className="list">
            {queue.appeals.map((a) => (
              <li key={a.id} className="stack-sm">
                <span>
                  <strong>@{a.username}</strong> · {c.kinds[a.kind]} · {a.rule_code}.{a.rule_version} · {x.issuer} @{a.issuer} · <LocalTime iso={a.created_at} lang={lang} />
                </span>
                <p className="small muted prewrap">
                  {c.decision}: {a.decision}
                </p>
                <p className="small prewrap">{a.statement}</p>
                {a.evidence_url ? (
                  <a href={a.evidence_url} rel="noopener noreferrer nofollow" target="_blank" className="text-link small">
                    {a.evidence_url}
                  </a>
                ) : null}
                {a.issued_by === user.id ? (
                  <p className="small muted">{x.yourDecision}</p>
                ) : (
                  <ActionForm action="conduct.decide" lang={lang} back={back} hidden={{ appeal: a.id }} className="stack-sm">
                    <Field label={x.answer}>
                      <textarea name="decision" required minLength={20} maxLength={2000} rows={2} />
                    </Field>
                    <div className="row">
                      <button className="btn btn-primary btn-sm" name="grant" value="1">
                        {x.grant}
                      </button>
                      <button className="btn btn-ghost btn-sm" name="grant" value="0">
                        {x.uphold}
                      </button>
                    </div>
                  </ActionForm>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={x.noAppeals} />
        )}
      </section>

      <section className="stack-sm">
        <h2 className="h3">{x.live}</h2>
        {queue.sanctions.length ? (
          <ul className="list">
            {queue.sanctions.map((s) => (
              <li key={s.id} className="stack-sm">
                <span>
                  <strong>@{s.username}</strong> · {s.protective ? c.protective : c.kinds[s.kind]} · {s.rule_code}.{s.rule_version} · {c.confidences[s.confidence]} ·{" "}
                  {s.ends_at ? (
                    <>
                      {x.until} <LocalTime iso={s.ends_at} lang={lang} />
                    </>
                  ) : (
                    x.noEnd
                  )}{" "}
                  · {x.issuer} @{s.issuer}
                </span>
                <span className={evidenceIntact(s) ? "small muted" : "small text-bad"}>{evidenceIntact(s) ? x.intact : x.broken}</span>
                <details className="disclosure">
                  <summary>{x.revoke}</summary>
                  <ActionForm action="conduct.revoke" lang={lang} back={back} hidden={{ sanction: s.id }} className="inline-form">
                    <input name="reason" required minLength={10} maxLength={1000} placeholder={x.revokeReason} aria-label={x.revokeReason} />
                    <button className="btn btn-ghost btn-xs">{x.revoke}</button>
                  </ActionForm>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={x.noLive} />
        )}
        <details className="disclosure card">
          <summary>{x.issueStandalone}</summary>
          <IssueForm lang={lang} back={back} rules={ruleList} />
        </details>
      </section>

      <section className="stack-sm">
        <h2 className="h3">{x.rules}</h2>
        <ul className="list">
          {rules.map((r) => (
            <li key={r.code}>
              <span className="grow small">
                <strong>{r.code}</strong> · {c.version} {r.version} · {lang === "ru" ? r.title_ru : r.title_en} — {lang === "ru" ? r.body_ru : r.body_en}
                {r.source_ru ? <span className="muted"> ({lang === "ru" ? r.source_ru : r.source_en})</span> : null}
              </span>
            </li>
          ))}
        </ul>
        {admin ? (
          <details className="disclosure card">
            <summary>{x.newVersion}</summary>
            <p className="small muted">{x.adminOnly}</p>
            <ActionForm action="conduct.rule" lang={lang} back={back} className="stack-sm">
              <div className="form-grid">
                <Field label={x.code}>
                  <input name="code" required pattern="[A-Za-z][A-Za-z0-9_]{1,31}" maxLength={32} />
                </Field>
                <Field label={x.titleRu}>
                  <input name="titleRu" required minLength={3} maxLength={120} />
                </Field>
                <Field label={x.titleEn}>
                  <input name="titleEn" required minLength={3} maxLength={120} />
                </Field>
                <Field label={x.sourceRu}>
                  <input name="sourceRu" maxLength={200} />
                </Field>
                <Field label={x.sourceEn}>
                  <input name="sourceEn" maxLength={200} />
                </Field>
              </div>
              <Field label={x.bodyRu}>
                <textarea name="bodyRu" required minLength={10} maxLength={2000} rows={2} />
              </Field>
              <Field label={x.bodyEn}>
                <textarea name="bodyEn" required minLength={10} maxLength={2000} rows={2} />
              </Field>
              <button className="btn btn-primary btn-sm">{x.publish}</button>
            </ActionForm>
          </details>
        ) : null}
      </section>
    </div>
  );
}
