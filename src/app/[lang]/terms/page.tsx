import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { LEGAL_DATES, LEGAL_VERSIONS, legalDocs } from "@/lib/legal.ts";
import { pageMeta } from "@/lib/meta.ts";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "terms", legalDocs.terms[lang].title);
}

export default async function LegalPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const doc = legalDocs.terms[lang];
  return (
    <article className="container narrow page legal">
      <h1>{doc.title}</h1>
      <p className="muted small">
        {LEGAL_DATES[lang]} · {lang === "ru" ? "версия" : "version"} <span className="mono">{LEGAL_VERSIONS.terms}</span>
      </p>
      {doc.sections.map(([title, paragraphs]) => (
        <section key={title}>
          <h2 className="h4">{title}</h2>
          {paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </section>
      ))}
    </article>
  );
}
