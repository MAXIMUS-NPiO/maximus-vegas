import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { trustStats } from "@/server/queries.ts";
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
  const { db, dbError } = await viewer();
  const stats = db ? await trustStats(db).catch(() => null) : null;
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
      <div className="grid grid-2 section-tight">
        {d.trust.sections.map(([title, text]) => (
          <section key={title} className="card">
            <h2 className="h4">{title}</h2>
            <p className="muted">{text}</p>
          </section>
        ))}
      </div>
      <Link href={`/${lang}/contact`} className="btn btn-ghost btn-sm">
        {d.trust.appeal}
      </Link>
    </div>
  );
}
