import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { countryName, countryOptions } from "@/lib/countries.ts";
import { venueText } from "@/lib/venue-text.ts";
import { viewer } from "@/server/viewer.ts";
import { discoverVenues, venueFilters, VENUE_KINDS, venueCities } from "@/server/venues.ts";
import { DbDown, Empty, Field, Flash, one, PageHead, type SearchParams } from "@/components/ui";
import { ApplicationForm } from "@/components/application-form";
import { FeatureNotice } from "@/components/feature-notice";
import { GAMES, gameBySlug } from "@/lib/games.ts";
import { venueMapPoints } from "@/lib/venue-discovery.ts";
import { VenueMap } from "@/components/venue-map";

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
  const filters = venueFilters({ name: one(sp.name), city: one(sp.city), country: one(sp.country), game: one(sp.game), kind: one(sp.kind) });
  const filtered = Object.values(filters).some(Boolean);
  const { db, user, dbError } = await viewer();
  const [result, cities] = db ? await Promise.all([discoverVenues(db, filters), venueCities(db)]) : [{ items: [], more: false }, []];
  const list = result.items;
  return (
    <div className="container page">
      <PageHead title={x.title} lead={x.lead} />
      <Flash lang={lang} params={sp} />
      <FeatureNotice db={db} lang={lang} feature="venues" />
      {dbError ? (
        <DbDown lang={lang} />
      ) : (
        <>
          <form key={`filters:${JSON.stringify(filters)}`} method="get" action={`/${lang}/venues`} className="venue-directory-filters" aria-label={x.title}>
            <Field label={x.search}><input name="name" maxLength={80} defaultValue={filters.name} /></Field>
            <Field label={x.city}><input name="city" maxLength={80} defaultValue={filters.city} list="venue-cities" placeholder={x.anyCity} />
              <datalist id="venue-cities">{cities.map(c => <option key={c} value={c} />)}</datalist>
            </Field>
            <Field label={x.country}><select name="country" aria-label={x.country} defaultValue={filters.country}>
              <option value="">{x.anyCountry}</option>{countryOptions(lang).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select></Field>
            <Field label={x.game}><select name="game" aria-label={x.game} defaultValue={filters.game}>
              <option value="">{x.anyGame}</option>{GAMES.map(g => <option key={g.slug} value={g.slug}>{g.name}</option>)}
            </select></Field>
            <Field label={x.kind}><select name="kind" aria-label={x.kind} defaultValue={filters.kind}>
              <option value="">{x.anyKind}</option>{VENUE_KINDS.map(k => <option key={k} value={k}>{x.kinds[k]}</option>)}
            </select></Field>
            <div className="row"><button className="btn btn-primary">{x.show}</button><Link href={`/${lang}/venues`} className="btn btn-ghost">{x.reset}</Link></div>
          </form>
          {result.more && <p className="notice small">{x.limited}</p>}
          <VenueMap key={`map:${JSON.stringify(filters)}`} lang={lang} points={venueMapPoints(list)} />
          {list.length ? (
            <div className="grid grid-3" data-venue-results>
              {list.map((v) => (
                <Link key={v.id} href={`/${lang}/venues/${v.slug}`} className="card card-link">
                  <p className="eyebrow">{x.kinds[v.kind]}</p>
                  <h3>{v.name}</h3>
                  <p className="small muted">
                    {v.address}, {v.city}
                    {v.country_code ? `, ${countryName(v.country_code, lang)}` : ""}
                  </p>
                  {v.games.length > 0 && <p className="small">{v.games.map(g => gameBySlug(g)?.name ?? g).join(" · ")}</p>}
                  {v.lat_e6 === null && <p className="small muted">{x.noCoordinates}</p>}
                  {v.upcoming ? (
                    <p className="small">
                      {x.upcoming}: {v.upcoming}
                    </p>
                  ) : null}
                </Link>
              ))}
            </div>
          ) : (
            <Empty title={filtered ? x.noResults : x.none} />
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
