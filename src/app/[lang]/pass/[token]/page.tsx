import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { venueText } from "@/lib/venue-text.ts";
import { viewer } from "@/server/viewer.ts";
import { isVenueStaff, passByToken, passState } from "@/server/venues.ts";
import { ActionForm, Badge, DbDown, Flash, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "strict-origin" };

/**
 * The page a pass's QR opens. The venue's staff see the holder and admit once; anyone else sees only what
 * the page is. The token is in the path, so links from it send only the site's origin (strict-origin; a
 * no-referrer policy would make the browser post the admit form with `Origin: null`).
 */
export default async function PassScan({ params, searchParams }: { params: Promise<{ lang: string; token: string }>; searchParams: SearchParams }) {
  const { lang, token } = await params;
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
  const pass = await passByToken(db, token);
  if (!pass) notFound();
  const back = `/${lang}/pass/${token}`;
  const staff = await isVenueStaff(db, pass.org_id, user);
  const holder = user?.id === pass.user_id;
  if (!staff)
    return (
      <div className="container page narrow">
        <h1>{x.scanTitle}</h1>
        <p className="lead">{holder ? x.passesLead : user ? x.scanForeign : x.scanPublic}</p>
        {holder ? (
          <Link href={`/${lang}/passes#pass-${pass.id}`} className="btn btn-primary btn-sm">
            {x.showPass}
          </Link>
        ) : null}
      </div>
    );
  const state = await passState(db, pass);
  return (
    <div className="container page narrow">
      <p className="eyebrow">{x.scanTitle}</p>
      <h1>{pass.holder_name}</h1>
      <p className="muted">@{pass.holder_username}</p>
      <Flash lang={lang} params={sp} />
      <dl className="embed-facts section-tight">
        <div>
          <dt>{x.venue}</dt>
          <dd>{pass.venue_name}</dd>
        </div>
        <div>
          <dt>{pass.tournament_name ? x.event : x.guest}</dt>
          <dd>{pass.tournament_name ?? (pass.note || "—")}</dd>
        </div>
        <div>
          <dt>{x.validity}</dt>
          <dd>
            <LocalTime iso={pass.valid_from} lang={lang} /> — <LocalTime iso={pass.valid_until} lang={lang} />
          </dd>
        </div>
      </dl>
      <p className="scan-state">
        {x.stateNow}: <Badge status={state === "admitted" ? "ok" : "bad"}>{state === "admitted" ? x.passStatus.active : x.results[state]}</Badge>
        {pass.used_at ? (
          <span className="small muted">
            {" "}
            <LocalTime iso={pass.used_at} lang={lang} /> · @{pass.used_by_username}
          </span>
        ) : null}
      </p>
      {state === "admitted" ? (
        <ActionForm action="pass.admit" lang={lang} back={back} hidden={{ token }}>
          <button className="btn btn-primary">{x.admit}</button>
        </ActionForm>
      ) : null}
    </div>
  );
}
