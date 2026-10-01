import Link from "next/link";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { siteOrigin } from "@/lib/site.ts";
import { venueText } from "@/lib/venue-text.ts";
import { viewer } from "@/server/viewer.ts";
import { myPasses } from "@/server/venues.ts";
import { qrSvg } from "@/server/mfa.ts";
import { Badge, DbDown, Empty, Flash, PageHead, SignInPrompt, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "passes", venueText[lang].passes, undefined, { noindex: true });
}

export default async function Passes({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const x = venueText[lang];
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user)
    return (
      <div className="container page">
        <PageHead title={x.passes} lead={x.passesLead} />
        <SignInPrompt lang={lang} back={`/${lang}/passes`} />
      </div>
    );
  const h = await headers();
  const origin = siteOrigin() ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost"}`;
  const passes = await myPasses(db, user.id);
  const codes = await Promise.all(passes.map((p) => (p.token ? qrSvg(`${origin}/${lang}/pass/${p.token}`) : Promise.resolve(null))));
  return (
    <div className="container page">
      <PageHead title={x.passes} lead={x.passesLead} />
      <Flash lang={lang} params={sp} />
      {passes.length ? (
        <div className="grid grid-2">
          {passes.map((p, i) => (
            <section key={p.id} id={`pass-${p.id}`} className="card stack-sm pass-card">
              <div className="row-between">
                <h2 className="h4">
                  <Link href={`/${lang}/venues/${p.venue_slug}`}>{p.venue_name}</Link>
                </h2>
                <Badge status={p.status === "active" && p.token ? "ok" : "muted"}>
                  {p.status === "active" && !p.token ? x.results.expired : x.passStatus[p.status]}
                </Badge>
              </div>
              <p className="small muted">
                {p.venue_address}, {p.venue_city}
              </p>
              {p.tournament_slug ? (
                <p className="small">
                  {x.event}: <Link href={`/${lang}/tournaments/${p.tournament_slug}`}>{p.tournament_name}</Link>
                </p>
              ) : p.note ? (
                <p className="small">{p.note}</p>
              ) : null}
              <p className="small">
                {x.validity}: <LocalTime iso={p.valid_from} lang={lang} /> — <LocalTime iso={p.valid_until} lang={lang} />
              </p>
              {p.used_at ? (
                <p className="small muted">
                  {x.usedAt}: <LocalTime iso={p.used_at} lang={lang} />
                </p>
              ) : null}
              {codes[i] ? (
                <>
                  <div className="qr pass-qr" role="img" aria-label={x.eventPass} dangerouslySetInnerHTML={{ __html: codes[i]! }} />
                  <p className="small muted">{x.manualCode}</p>
                  <code className="mono small break-all">{`${origin}/${lang}/pass/${p.token}`}</code>
                </>
              ) : null}
            </section>
          ))}
        </div>
      ) : (
        <Empty title={x.noMyPasses} />
      )}
    </div>
  );
}
