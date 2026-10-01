import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { trustText } from "@/lib/conduct-text.ts";
import { viewer } from "@/server/viewer.ts";
import { trustStats } from "@/server/queries.ts";
import { currentRules, publicCount, trustReport } from "@/server/conduct.ts";
import { DbDown, PageHead } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "trust", dict(lang).trust.title, dict(lang).trust.lead);
}

export default async function Trust({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const t = trustText[lang];
  const { db, dbError } = await viewer();
  const [stats, report, rules] = db
    ? await Promise.all([trustStats(db).catch(() => null), trustReport(db).catch(() => null), currentRules(db).catch(() => [])])
    : [null, null, []];
  return (
    <div className="container page">
      <PageHead title={d.trust.title} lead={d.trust.lead} />
      {dbError || !stats ? (
        <DbDown lang={lang} />
      ) : (
        <dl className="stat-grid">
          {Object.entries(stats).map(([k, v]) => (
            <div key={k}>
              <dt>{d.trust.stats[k]}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}

      {report ? (
        <section className="section-tight" aria-labelledby="trust-report">
          <h2 className="h3" id="trust-report">
            {t.report}
          </h2>
          <dl className="stat-grid">
            {Object.entries(report.counts).map(([k, v]) => {
              const shown = publicCount(v);
              return (
                <div key={k}>
                  <dt>{t.counts[k]}</dt>
                  <dd>{shown === null ? t.fewer : shown}</dd>
                </div>
              );
            })}
            <div>
              <dt>{t.median}</dt>
              <dd>{report.medianDays ?? "—"}</dd>
            </div>
          </dl>
        </section>
      ) : null}

      <section className="section-tight">
        <h2 className="h3">{t.procedure}</h2>
        <div className="grid grid-2">
          {t.steps.map(([title, text]) => (
            <section key={title} className="card">
              <h3 className="h4">{title}</h3>
              <p className="muted">{text}</p>
            </section>
          ))}
        </div>
      </section>

      {rules.length ? (
        <section className="section-tight" id="rules">
          <h2 className="h3">{t.rules}</h2>
          <p className="small muted">{t.rulesNote}</p>
          <ul className="list">
            {rules.map((r) => (
              <li key={r.code} className="stack-sm">
                <span>
                  <strong>{lang === "ru" ? r.title_ru : r.title_en}</strong>{" "}
                  <span className="small muted">
                    {r.code} · v{r.version}
                  </span>
                </span>
                <span className="small">{lang === "ru" ? r.body_ru : r.body_en}</span>
                {r.source_ru ? (
                  <span className="small muted">
                    {t.source}: {lang === "ru" ? r.source_ru : r.source_en}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid grid-2 section-tight">
        {d.trust.sections.map(([title, text]) => (
          <section key={title} className="card">
            <h2 className="h4">{title}</h2>
            <p className="muted">{text}</p>
          </section>
        ))}
      </div>
      <div className="row">
        <Link href={`/${lang}/conduct`} className="btn btn-ghost btn-sm">
          {d.trust.appeal}
        </Link>
        <Link href={`/${lang}/conduct#report`} className="btn btn-ghost btn-sm">
          {t.myStatus}
        </Link>
      </div>
    </div>
  );
}
