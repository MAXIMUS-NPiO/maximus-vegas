import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale, type Locale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { countryOptions } from "@/lib/countries.ts";
import { venueText } from "@/lib/venue-text.ts";
import { viewer } from "@/server/viewer.ts";
import { orgBySlug } from "@/server/queries.ts";
import { canManageOrg } from "@/server/access.ts";
import { orgVenues, VENUE_KINDS, venueCheckins, venuePasses, type Venue } from "@/server/venues.ts";
import { ActionForm, Badge, DbDown, Field, Flash, type SearchParams } from "@/components/ui";
import { LocalTime, TimeZoneField } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, `organizer/${slug}/venues`, venueText[lang].manage, undefined, { noindex: true });
}

function VenueFields({ lang, venue }: { lang: Locale; venue?: Venue }) {
  const x = venueText[lang];
  return (
    <>
      <div className="form-grid">
        <Field label={x.name}>
          <input name="name" required minLength={2} maxLength={80} defaultValue={venue?.name} />
        </Field>
        <Field label={x.kind}>
          <select name="kind" defaultValue={venue?.kind ?? "club"}>
            {VENUE_KINDS.map((k) => (
              <option key={k} value={k}>
                {x.kinds[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={x.address}>
          <input name="address" required minLength={5} maxLength={200} defaultValue={venue?.address} />
        </Field>
        <Field label={x.city}>
          <input name="city" required minLength={2} maxLength={80} defaultValue={venue?.city} />
        </Field>
        <Field label={x.country}>
          <select name="country" defaultValue={venue?.country_code ?? ""}>
            <option value="">—</option>
            {countryOptions(lang).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={x.site}>
          <input name="website" type="url" maxLength={300} placeholder="https://" defaultValue={venue?.website} />
        </Field>
      </div>
      <Field label={x.description}>
        <textarea name="description" maxLength={1000} rows={3} defaultValue={venue?.description} />
      </Field>
    </>
  );
}

export default async function OrgVenues({ params, searchParams }: { params: Promise<{ lang: string; slug: string }>; searchParams: SearchParams }) {
  const { lang, slug } = await params;
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
  const back = `/${lang}/organizer/${slug}/venues`;
  if (!user) redirect(`/${lang}/signin?next=${back}`);
  const data = await orgBySlug(db, slug);
  if (!data) notFound();
  if (!(await canManageOrg(db, data.org.id, user))) notFound();
  const venues = await orgVenues(db, data.org.id);
  const extras = await Promise.all(
    venues.map(async (v) =>
      v.status === "confirmed" ? { passes: await venuePasses(db, v.id), checkins: await venueCheckins(db, v.id, 15) } : { passes: [], checkins: [] },
    ),
  );
  return (
    <div className="container page">
      <p className="eyebrow">
        <Link href={`/${lang}/organizer/${slug}`}>{data.org.name}</Link>
      </p>
      <h1>{x.manage}</h1>
      <p className="lead">{x.manageLead}</p>
      <Flash lang={lang} params={sp} />
      <p className="small muted">{x.scanHow}</p>
      {venues.map((v, i) => (
        <section key={v.id} className="card stack-sm section-tight" id={`venue-${v.slug}`}>
          <div className="row-between">
            <h2 className="h3">
              <Link href={`/${lang}/venues/${v.slug}`}>{v.name}</Link>
            </h2>
            <Badge status={v.status === "confirmed" ? "ok" : v.status === "submitted" ? "info" : v.status === "draft" ? "muted" : "bad"}>
              {x.statuses[v.status]}
            </Badge>
          </div>
          <p className="small muted">
            {x.kinds[v.kind]} · {v.address}, {v.city}
          </p>
          {v.review_note && v.status !== "confirmed" ? (
            <p className="small">
              <strong>{x.reviewNote}:</strong> {v.review_note}
            </p>
          ) : null}
          <div className="row">
            {["draft", "rejected", "suspended"].includes(v.status) ? (
              <ActionForm action="venue.submit" lang={lang} back={back} hidden={{ venue: v.id }}>
                <button className="btn btn-primary btn-sm">{x.submit}</button>
              </ActionForm>
            ) : null}
          </div>
          <details className="disclosure">
            <summary>{x.edit}</summary>
            <ActionForm action="venue.update" lang={lang} back={back} hidden={{ venue: v.id }} className="stack-sm">
              <VenueFields lang={lang} venue={v} />
              <button className="btn btn-ghost btn-sm">{x.save}</button>
            </ActionForm>
          </details>
          {v.status === "confirmed" ? (
            <>
              <details className="disclosure">
                <summary>{x.guest}</summary>
                <p className="small muted">{x.guestLead}</p>
                <ActionForm action="pass.guest" lang={lang} back={back} hidden={{ venue: v.id }} className="stack-sm">
                  <div className="form-grid">
                    <Field label={x.username}>
                      <input name="username" required pattern="[A-Za-z0-9_]{3,24}" autoCapitalize="none" />
                    </Field>
                    <Field label={x.note}>
                      <input name="note" maxLength={200} />
                    </Field>
                    <Field label={x.from}>
                      <input type="datetime-local" name="from" required />
                    </Field>
                    <Field label={x.until}>
                      <input type="datetime-local" name="until" required />
                    </Field>
                  </div>
                  <TimeZoneField />
                  <button className="btn btn-primary btn-sm">{x.issue}</button>
                </ActionForm>
              </details>
              <h3 className="h4">{x.activePasses}</h3>
              {extras[i].passes.length ? (
                <ul className="list small">
                  {extras[i].passes.map((p) => (
                    <li key={p.id}>
                      <span className="grow">
                        @{p.holder_username} · {p.tournament_name ?? x.guest} · <LocalTime iso={p.valid_from} lang={lang} /> —{" "}
                        <LocalTime iso={p.valid_until} lang={lang} />
                      </span>
                      <ActionForm action="pass.revoke" lang={lang} back={back} hidden={{ pass: p.id }}>
                        <button className="btn btn-ghost btn-xs">{x.revoke}</button>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">{x.noPasses}</p>
              )}
              <h3 className="h4">{x.checkins}</h3>
              {extras[i].checkins.length ? (
                <ul className="list small">
                  {extras[i].checkins.map((c) => (
                    <li key={c.id}>
                      <span className="grow">
                        {c.holder ? `@${c.holder}` : "—"} · {x.results[c.result] ?? c.result} · @{c.staff}
                      </span>
                      <span className="muted">
                        <LocalTime iso={c.at} lang={lang} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">{x.noCheckins}</p>
              )}
            </>
          ) : null}
        </section>
      ))}
      <details className="disclosure card section-tight" open={!venues.length}>
        <summary>{x.add}</summary>
        <ActionForm action="venue.create" lang={lang} back={back} hidden={{ org: data.org.id }} className="stack-sm">
          <VenueFields lang={lang} />
          <button className="btn btn-primary btn-sm">{x.add}</button>
        </ActionForm>
      </details>
    </div>
  );
}
