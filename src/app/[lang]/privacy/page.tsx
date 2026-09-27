import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { content, isLocale } from "@/lib/content";
export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return {
    title: `${content[lang].privacyTitle} — MAXIMUS VEGAS`,
    robots: { index: false, follow: true },
    alternates: {
      canonical: `/${lang}/privacy`,
      languages: { ru: "/ru/privacy", en: "/en/privacy" },
    },
  };
}
export default async function Privacy({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const c = content[lang];
  return (
    <main id="main" className="container privacy-page">
      <Link className="text-link" href={`/${lang}`}>
        ← {c.privacyBack}
      </Link>
      <h1>{c.privacyTitle}</h1>
      {c.privacySections.map(([heading, text]) => (
        <section key={heading}>
          <h2>{heading}</h2>
          <p>{text}</p>
        </section>
      ))}
    </main>
  );
}
