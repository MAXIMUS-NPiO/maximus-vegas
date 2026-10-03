import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { Flash, type SearchParams } from "@/components/ui";
import { ApplicationForm } from "@/components/application-form";
import { partnerModules, t } from "@/lib/directions.ts";
import { Arrow, Check } from "@/components/icons";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "partners", dict(lang).partners.title, dict(lang).partners.lead);
}

export default async function Partners({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const p = d.partners;
  const sp = await searchParams;
  const { user } = await viewer();
  return (
    <div className="container page">
      <header className="page-head">
        <p className="eyebrow">{p.eyebrow}</p>
        <h1>{p.title}</h1>
        <p className="lead">{p.lead}</p>
        <div className="row">
          <Link href={`/${lang}/organizer`} className="btn btn-primary">
            {p.start}
            <Arrow />
          </Link>
          <a href="#apply" className="btn btn-ghost">
            {p.apply}
          </a>
        </div>
      </header>
      <Flash lang={lang} params={sp} />
      <div className="grid grid-2">
        <section className="card">
          <h2 className="h3">{p.now}</h2>
          <ul className="checks">
            {partnerModules(true).map((x) => (
              <li key={x.id}>
                <Check />
                {t(x.name, lang)}
              </li>
            ))}
          </ul>
        </section>
        <section className="card">
          <h2 className="h3">{p.next}</h2>
          <ul className="bullets">
            {partnerModules(false).map((x) => (
              <li key={x.id}>{t(x.name, lang)} — {t(x.note, lang)}</li>
            ))}
          </ul>
        </section>
      </div>
      <section className="section-tight">
        <div className="grid grid-4">
          {p.scenarios.map(([title, text]) => (
            <div key={title} className="card">
              <h3>{title}</h3>
              <p className="muted">{text}</p>
            </div>
          ))}
        </div>
        <p className="small muted">{p.tech}</p>
      </section>
      <section id="apply" className="section-tight narrow-block">
        <ApplicationForm lang={lang} back={`/${lang}/partners#apply`} kinds={["partner", "organizer", "sponsor", "school", "venue", "investor"]} user={user} title={p.apply} />
      </section>
    </div>
  );
}
