import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { DIRECTIONS, t } from "@/lib/directions.ts";
import { pageMeta } from "@/lib/meta.ts";
import { PageHead, StateBadge } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "explore", dict(lang).explore.title, dict(lang).explore.lead);
}

export default async function Explore({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const personal: Array<[string, string]> = [
    ["hub", d.nav.hub],
    ["notifications", d.nav.notifications],
    ["calendar", d.hub.calendar],
    ["settings", d.nav.settings],
    ["organizer", d.nav.organizer],
    ["inventory", t(DIRECTIONS.find((x) => x.slug === "inventory")!.title, lang)],
    ["billing", t(DIRECTIONS.find((x) => x.slug === "billing")!.title, lang)],
  ];
  const service: Array<[string, string]> = [
    ["trust", d.trust.title],
    ["status", d.status.title],
    ["help", d.help.title],
    ["contact", d.contact.title],
    ["terms", lang === "ru" ? "Условия использования" : "Terms of use"],
    ["privacy", lang === "ru" ? "Конфиденциальность" : "Privacy"],
    ["search", d.search.title],
  ];
  return (
    <div className="container page">
      <PageHead title={d.explore.title} lead={d.explore.lead} />
      <div className="grid grid-3">
        {d.nav.groups.map((g) => (
          <section key={g.label} className="card">
            <h2 className="h4">{g.label}</h2>
            <ul className="link-list">
              {g.items.map(([slug, label]) => {
                const dir = DIRECTIONS.find((x) => x.slug === slug);
                return (
                  <li key={slug}>
                    <Link href={`/${lang}/${slug}`}>{label}</Link>
                    {dir ? <StateBadge lang={lang} state={dir.state} /> : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        <section className="card">
          <h2 className="h4">{lang === "ru" ? "Личное пространство" : "Personal space"}</h2>
          <ul className="link-list">
            {personal.map(([slug, label]) => (
              <li key={slug}>
                <Link href={`/${lang}/${slug}`}>{label}</Link>
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2 className="h4">{lang === "ru" ? "Магазин и сервисы" : "Shop and services"}</h2>
          <ul className="link-list">
            {["shop", "marketplace", "clubhouses"].map((slug) => {
              const dir = DIRECTIONS.find((x) => x.slug === slug)!;
              return (
                <li key={slug}>
                  <Link href={`/${lang}/${slug}`}>{t(dir.title, lang)}</Link>
                  <StateBadge lang={lang} state={dir.state} />
                </li>
              );
            })}
          </ul>
        </section>
        <section className="card">
          <h2 className="h4">{lang === "ru" ? "Доверие и документы" : "Trust and documents"}</h2>
          <ul className="link-list">
            {service.map(([slug, label]) => (
              <li key={slug}>
                <Link href={`/${lang}/${slug}`}>{label}</Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
