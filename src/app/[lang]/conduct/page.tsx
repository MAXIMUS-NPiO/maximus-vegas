import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, type Locale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { conductText } from "@/lib/conduct-text.ts";
import { viewer } from "@/server/viewer.ts";
import { currentRules, evidenceIntact, myConduct, OTHER_RULE, type SanctionView } from "@/server/conduct.ts";
import { ActionForm, Badge, DbDown, Field, Flash, PageHead, SignInPrompt, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "conduct", conductText[lang].title, conductText[lang].lead, { noindex: true });
}

export default async function Conduct({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const x = conductText[lang];
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  const reportUser = typeof sp.user === "string" ? sp.user.slice(0, 24) : "";
  const back = `/${lang}/conduct`;
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user)
    return (
      <div className="container page">
        <PageHead title={x.title} lead={x.lead} />
        <SignInPrompt lang={lang} back={`${back}${reportUser ? `?user=${encodeURIComponent(reportUser)}` : ""}`} />
      </div>
    );
  const [{ sanctions, reports }, rules] = await Promise.all([myConduct(db, user.id), currentRules(db)]);
  return (
    <div className="container page">
      <PageHead title={x.title} lead={x.lead}>
        <Link href={`/${lang}/trust`} className="btn btn-ghost btn-sm">
          {x.rules}
        </Link>
      </PageHead>
      <Flash lang={lang} params={sp} />
      {user.restricted ? <p className="notice notice-warn">{x.restricted}</p> : null}

      <section className="section-tight">
        <h2 className="h3">{x.sanctions}</h2>
        {sanctions.length ? (
          <div className="stack">
            {sanctions.map((s) => (
              <SanctionCard key={s.id} lang={lang} s={s} back={back} />
            ))}
          </div>
        ) : (
          <p className="small muted">{x.noSanctions}</p>
        )}
      </section>

      <section className="section-tight" id="report">
        <h2 className="h3">{x.report}</h2>
        <p className="small muted">{x.reportLead}</p>
        <ActionForm action="conduct.report" lang={lang} back={back} className="card form-card">
          <div className="form-grid">
            <Field label={x.player}>
              <input name="username" required minLength={3} maxLength={24} defaultValue={reportUser} autoComplete="off" />
            </Field>
            <Field label={x.rule}>
              <select name="rule" required>
                {rules.map((r) => (
                  <option key={r.code} value={r.code}>
                    {lang === "ru" ? r.title_ru : r.title_en}
                  </option>
                ))}
                <option value={OTHER_RULE}>{x.ruleOther}</option>
              </select>
            </Field>
          </div>
          <Field label={x.context}>
            <input name="context" maxLength={300} placeholder={`/${lang}/matches/…`} />
          </Field>
          <Field label={x.description}>
            <textarea name="description" required minLength={20} maxLength={2000} rows={4} />
          </Field>
          <Field label={x.evidenceUrl}>
            <input name="evidence" type="url" maxLength={500} placeholder="https://" />
          </Field>
          <button className="btn btn-primary btn-sm" disabled={Boolean(user.restricted)}>
            {x.sendReport}
          </button>
        </ActionForm>
      </section>

      <section className="section-tight">
        <h2 className="h3">{x.myReports}</h2>
        {reports.length ? (
          <ul className="list">
            {reports.map((r) => (
              <li key={r.id}>
                <span className="grow small">
                  @{r.subject} · {r.rule_code === OTHER_RULE ? x.ruleOther : r.rule_code} · <LocalTime iso={r.created_at} lang={lang} dateOnly />
                </span>
                <Badge status={r.status === "actioned" ? "ok" : r.status === "dismissed" ? "muted" : "warn"}>{x.reportStatus[r.status]}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">{x.noReports}</p>
        )}
      </section>
    </div>
  );
}

function SanctionCard({ lang, s, back }: { lang: Locale; s: SanctionView; back: string }) {
  const x = conductText[lang];
  const state = s.revoked_at ? "revoked" : s.live ? "live" : "ended";
  return (
    <article className="card stack-sm sanction-card">
      <div className="row-between">
        <strong>{s.protective ? x.protective : x.kinds[s.kind]}</strong>
        <Badge status={state === "live" ? "warn" : "muted"}>{x[state]}</Badge>
      </div>
      <dl className="finder-facts small">
        <div>
          <dt>{x.rule}</dt>
          <dd>
            {lang === "ru" ? s.title_ru : s.title_en} ({s.rule_code}, {x.version} {s.rule_version})
          </dd>
        </div>
        <div>
          <dt>{x.confidence}</dt>
          <dd>{x.confidences[s.confidence]}</dd>
        </div>
        <div>
          <dt>{x.term}</dt>
          <dd>
            {x.from} <LocalTime iso={s.starts_at} lang={lang} />
            {s.ends_at ? (
              <>
                {" "}
                {x.until} <LocalTime iso={s.ends_at} lang={lang} />
              </>
            ) : s.kind === "warning" ? null : (
              ` · ${x.noEnd}`
            )}
          </dd>
        </div>
      </dl>
      <p className="small">
        <strong>{x.decision}:</strong> <span className="prewrap">{s.decision}</span>
      </p>
      <div className="small">
        <strong>{x.evidence}:</strong>
        <ul className="evidence-list">
          {s.evidence.map((e, i) => (
            <li key={i}>
              {e.url.startsWith("/") ? <Link href={e.url}>{e.url}</Link> : <a href={e.url} rel="noopener noreferrer nofollow" target="_blank">{e.url}</a>}
              {e.note ? ` — ${e.note}` : ""}
            </li>
          ))}
        </ul>
        {evidenceIntact(s) ? <p className="muted">{x.integrity}</p> : null}
      </div>
      {s.revoked_at && s.revoke_reason ? (
        <p className="small muted">
          {x.revokeReason}: {s.revoke_reason}
        </p>
      ) : null}
      {s.appeal_status ? (
        <p className="small">
          <Badge status={s.appeal_status === "granted" ? "ok" : s.appeal_status === "upheld" ? "muted" : "warn"}>{x.appealStatus[s.appeal_status]}</Badge>
          {s.appeal_decision ? (
            <span className="prewrap">
              {" "}
              {x.appealDecision}: {s.appeal_decision}
            </span>
          ) : null}
        </p>
      ) : s.appealable ? (
        <details className="disclosure">
          <summary>{x.appeal}</summary>
          <p className="small muted">{x.appealNote}</p>
          <ActionForm action="conduct.appeal" lang={lang} back={back} hidden={{ sanction: s.id }} className="stack-sm">
            <Field label={x.statement}>
              <textarea name="statement" required minLength={20} maxLength={2000} rows={3} />
            </Field>
            <Field label={x.appealEvidence}>
              <input name="evidence" type="url" maxLength={500} placeholder="https://" />
            </Field>
            <button className="btn btn-primary btn-sm">{x.send}</button>
          </ActionForm>
        </details>
      ) : null}
    </article>
  );
}
