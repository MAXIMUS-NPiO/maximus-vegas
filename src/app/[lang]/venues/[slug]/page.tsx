import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { countryName } from "@/lib/countries.ts";
import { mapLink, venueText } from "@/lib/venue-text.ts";
import { viewer } from "@/server/viewer.ts";
import { venueTournaments, venueView } from "@/server/venues.ts";
import { Badge, DbDown, Flash, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  const { db } = await viewer();
  const data = db ? await venueView(db, slug, null).catch(() => null) : null;
  return pageMeta(lang, `venues/${slug}`, data?.venue.name ?? venueText[lang].title, data ? `${data.venue.address}, ${data.venue.city}` : undefined, {
    noindex: !data,
  });
}

export default async function VenuePage({ params, searchParams }: { params: Promise<{ lang: string; slug: string }>; searchParams: SearchParams }) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  const x = venueText[lang];
  const d = dict(lang);
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  const data = await venueView(db, slug, user);
  if (!data) notFound();
  const { venue, manager } = data;
  const events = venue.status === "confirmed" ? await venueTournaments(db, venue.id) : [];
  return (
    <div className="container page">
      <p className="eyebrow">
        <Link href={`/${lang}/venues`}>{x.title}</Link> · {x.kinds[venue.kind]}
      </p>
      <h1>
        {venue.name} {venue.status !== "confirmed" ? <Badge status="warn">{x.statuses[venue.status]}</Badge> : null}
      </h1>
      <Flash lang={lang} params={sp} />
      {venue.status !== "confirmed" ? <p className="notice small">{x.notPublic}</p> : null}
      <p className="lead">
        {venue.address}, {venue.city}
        {venue.country_code ? `, ${countryName(venue.country_code, lang)}` : ""}
      </p>
      <p className="row">
        <a href={mapLink(venue.address, venue.city)} target="_blank" rel="noopener" className="btn btn-ghost btn-sm">
          {x.map}
        </a>
        {venue.website ? (
          <a href={venue.website} target="_blank" rel="noopener nofollow" className="btn btn-ghost btn-sm">
            {x.website} ↗
          </a>
        ) : null}
        {manager ? (
          <Link href={`/${lang}/organizer`} className="btn btn-ghost btn-sm">
            {d.organizer.title}
          </Link>
        ) : null}
      </p>
      {venue.description ? <p className="prewrap">{venue.description}</p> : null}
      <section className="section-tight">
        <h2 className="h3">{x.events}</h2>
        {events.length ? (
          <ul className="list">
            {events.map((t) => (
              <li key={t.slug}>
                <span className="grow">
                  <Link href={`/${lang}/tournaments/${t.slug}`}>{t.name}</Link> <span className="small muted">· {gameBySlug(t.game)?.name ?? t.game}</span>
                </span>
                <span className="row small">
                  {t.starts_at ? <LocalTime iso={t.starts_at} lang={lang} /> : null}
                  <Badge status={t.status}>{d.statuses.tournament[t.status] ?? t.status}</Badge>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">{x.noEvents}</p>
        )}
      </section>
    </div>
  );
}
