import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { DIRECTIONS, directionBySlug, t } from "@/lib/directions.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { Flash, PageHead, StateBadge, type SearchParams } from "@/components/ui";
import { ApplicationForm } from "@/components/application-form";

export const dynamicParams = false;
/** Directions that have their own working page are served by it, not by this description page. */
const OWN_PAGE = new Set(["venues", "media"]);
export function generateStaticParams() {
  return DIRECTIONS.filter((x) => !OWN_PAGE.has(x.slug)).map((x) => ({ section: x.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string; section: string }> }): Promise<Metadata> {
  const { lang, section } = await params;
  const dir = directionBySlug(section);
  if (!isLocale(lang) || !dir) return {};
  return pageMeta(lang, section, t(dir.title, lang), t(dir.lead, lang));
}

export default async function Direction({ params, searchParams }: { params: Promise<{ lang: string; section: string }>; searchParams: SearchParams }) {
  const { lang, section } = await params;
  const dir = directionBySlug(section);
  if (!isLocale(lang) || !dir) notFound();
  const d = dict(lang);
  const sp = await searchParams;
  const { user } = await viewer();
  const kinds = dir.slug === "cloud-gaming" ? ["cloud_gaming", "gpu_host"] : dir.slug === "academy" ? ["academy", "school"] : [dir.kind];
  return (
    <div className="container page">
      <PageHead title={t(dir.title, lang)} lead={t(dir.lead, lang)}>
        <StateBadge lang={lang} state={dir.state} />
      </PageHead>
      <Flash lang={lang} params={sp} />
      <div className="split">
        <div className="stack">
          <section>
            <h2 className="h3">{lang === "ru" ? "Что входит в направление" : "What this covers"}</h2>
            <ul className="bullets">
              {dir.scope[lang].map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </section>
          <section className="notice">
            <strong>{lang === "ru" ? "Что доступно сейчас" : "Available now"}</strong>
            <p>{t(dir.now, lang)}</p>
          </section>
          {dir.boundary ? (
            <section className="notice notice-quiet">
              <strong>{lang === "ru" ? "Границы" : "Boundaries"}</strong>
              <p>{t(dir.boundary, lang)}</p>
            </section>
          ) : null}
          <p className="small">
            <Link href={`/${lang}/status`} className="text-link">
              {d.status.registry}
            </Link>
          </p>
        </div>
        <ApplicationForm lang={lang} back={`/${lang}/${dir.slug}`} kinds={kinds} user={user} title={d.partners.apply} />
      </div>
    </div>
  );
}
