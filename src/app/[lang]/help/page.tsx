import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { PageHead } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "help", dict(lang).help.title);
}

export default async function Help({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  return (
    <div className="container narrow page">
      <PageHead title={d.help.title} />
      <div className="faq">
        {d.help.faqs.map(([q, a]) => (
          <details key={q}>
            <summary>{q}</summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
      <p className="section-tight">
        {d.help.contact}{" "}
        <Link href={`/${lang}/contact`} className="text-link">
          {d.contact.title}
        </Link>
      </p>
    </div>
  );
}
