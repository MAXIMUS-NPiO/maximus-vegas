import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { countryName } from "@/lib/countries.ts";
import { venueText } from "@/lib/venue-text.ts";
import { viewer } from "@/server/viewer.ts";
import { publicVenues, venueCities } from "@/server/venues.ts";
import { DbDown, Empty, Flash, one, PageHead, type SearchParams } from "@/components/ui";
import { ApplicationForm } from "@/components/application-form";
import { FeatureNotice } from "@/components/feature-notice";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "venues", venueText[lang].title, venueText[lang].lead);
}

export default async function Venues({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const x = venueText[lang];
  const d = dict(lang);
  const sp = await searchParams;
  const city = (one(sp.city) ?? "").slice(0, 80);
  const { db, user, dbError } = await viewer();
  const [list, cities] = db ? await Promise.all([publicVenues(db, city), venueCities(db)]) : [[], []];
  return (
    <div className="container page">
      <PageHead title={x.title} lead={x.lead} />
      <Flash lang={lang} params={sp} />
      <FeatureNotice db={db} lang={lang} feature="venues" />
      {dbError ? (
        <DbDown lang={lang} />
      ) : (
        <>
          {cities.length > 1 ? (
            <form method="get" action={`/${lang}/venues`} className="inline-form toolbar">
              <select name="city" defaultValue={city} aria-label={x.city}>
                <option value="">{x.anyCity}</option>
                {cities.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <button className="btn btn-ghost btn-sm">{x.show}</button>
            </form>
          ) : null}
          {list.length ? (
            <div className="grid grid-3">
              {list.map((v) => (
                <Link key={v.id} href={`/${lang}/venues/${v.slug}`} className="card card-link">
                  <p className="eyebrow">{x.kinds[v.kind]}</p>
                  <h3>{v.name}</h3>
                  <p className="small muted">
                    {v.address}, {v.city}
                    {v.country_code ? `, ${countryName(v.country_code, lang)}` : ""}
                  </p>
                  {v.upcoming ? (
                    <p className="small">
                      {x.upcoming}: {v.upcoming}
                    </p>
                  ) : null}
                </Link>
              ))}
            </div>
          ) : (
            <Empty title={x.none} />
          )}
        </>
      )}
      <section className="section-tight split">
        <div className="stack-sm">
          <h2 className="h3">{x.owners}</h2>
          <p className="small muted">{x.ownersLead}</p>
          {user ? (
            <p>
              <Link href={`/${lang}/organizer`} className="btn btn-ghost btn-sm">
                {d.organizer.title}
              </Link>
            </p>
          ) : null}
        </div>
        <ApplicationForm lang={lang} back={`/${lang}/venues`} kinds={["venue"]} user={user} title={d.partners.apply} />
      </section>
    </div>
  );
}
