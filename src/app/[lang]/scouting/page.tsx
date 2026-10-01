import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { GAMES, gameBySlug } from "@/lib/games.ts";
import { countryName, countryOptions } from "@/lib/countries.ts";
import { pageMeta } from "@/lib/meta.ts";
import { scoutText } from "@/lib/scout-text.ts";
import { viewer } from "@/server/viewer.ts";
import { ACTIVE_DAYS, isEmptyQuery, myFilters, parseScoutQuery, SCOUT_LIMIT, scoutParams, scoutPlayers, watchlist } from "@/server/scouting.ts";
import { ActionForm, Badge, DbDown, Empty, Field, Flash, PageHead, SignInPrompt, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";
import { FeatureNotice } from "@/components/feature-notice";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "scouting", scoutText[lang].title, scoutText[lang].lead, { noindex: true });
}

const firstOf = (x: string | string[] | undefined) => (Array.isArray(x) ? x[0] : x);

export default async function Scouting({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const x = scoutText[lang];
  const sp = await searchParams;
  const flat = Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, firstOf(v)]));
  const query = parseScoutQuery(flat);
  const qs = new URLSearchParams(scoutParams(query)).toString();
  const back = `/${lang}/scouting${qs ? `?${qs}` : ""}`;
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
        <PageHead title={x.title} lead={x.lead} />
        <SignInPrompt lang={lang} back={back} />
      </div>
    );
  const [rows, filters, watched] = await Promise.all([scoutPlayers(db, user.id, query), myFilters(db, user.id), watchlist(db, user.id)]);
  return (
    <div className="container page">
      <PageHead title={x.title} lead={x.lead} />
      <Flash lang={lang} params={sp} />
      <FeatureNotice db={db} lang={lang} feature="scouting" />
      <form method="get" action={`/${lang}/scouting`} className="card form-card scout-filters">
        <div className="form-grid">
          <Field label={x.game}>
            <select name="game" defaultValue={query.game}>
              <option value="">{x.anyGame}</option>
              {GAMES.filter((g) => !g.legacy).map((g) => (
                <option key={g.slug} value={g.slug}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={x.country}>
            <select name="country" defaultValue={query.country}>
              <option value="">{x.anyCountry}</option>
              {countryOptions(lang).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={x.minRating} hint={x.ratingHint}>
            <input name="minRating" type="number" min={100} max={5000} step={10} defaultValue={query.minRating ?? ""} inputMode="numeric" />
          </Field>
          <Field label={x.maxRating}>
            <input name="maxRating" type="number" min={100} max={5000} step={10} defaultValue={query.maxRating ?? ""} inputMode="numeric" />
          </Field>
          <Field label={x.active}>
            <select name="activeDays" defaultValue={query.activeDays ? String(query.activeDays) : ""}>
              <option value="">{x.anyTime}</option>
              {ACTIVE_DAYS.map((d) => (
                <option key={d} value={d}>
                  {x.days[d]}
                </option>
              ))}
            </select>
          </Field>
          <Field label={x.text}>
            <input name="text" maxLength={40} defaultValue={query.text} />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" name="lft" value="1" defaultChecked={query.lft} /> {x.lft}
        </label>
        <div className="row">
          <button className="btn btn-primary btn-sm">{x.search}</button>
          <Link href={`/${lang}/scouting`} className="btn btn-ghost btn-sm">
            {x.reset}
          </Link>
        </div>
      </form>

      <div className="quick-grid section-tight">
        <section className="stack-sm">
          <p className="small muted">
            {isEmptyQuery(query) ? x.noQuery : null} {x.results}: {rows.length}
            {rows.length >= SCOUT_LIMIT ? ` ${x.firstN}` : ""}
          </p>
          {rows.length ? (
            <div className="grid grid-2">
              {rows.map((p) => (
                <article key={p.id} className="card stack-sm scout-card">
                  <div className="row-between">
                    <span>
                      <Link href={`/${lang}/players/${p.username}`}>
                        <strong>{p.display_name}</strong>
                      </Link>{" "}
                      <span className="small muted">@{p.username}</span>
                    </span>
                    {query.game && p.rating !== null ? <span className="rating-value">{p.rating}</span> : null}
                  </div>
                  <p className="small muted">
                    {p.country_code ? `${countryName(p.country_code, lang)} · ` : ""}
                    {query.game ? `${gameBySlug(query.game)?.name} · ${x.matches}: ${p.matches} (${p.wins}–${p.losses}) · ` : ""}
                    {x.tournaments}: {p.tournaments} · {x.lastActive}: {p.last_active ? <LocalTime iso={p.last_active} lang={lang} dateOnly /> : x.never}
                  </p>
                  {p.lft ? (
                    <p className="small">
                      <Badge status="works">{x.lftBadge}</Badge> {p.lft_roles ?? ""}
                    </p>
                  ) : null}
                  {p.watched ? (
                    <ActionForm action="scout.unwatch" lang={lang} back={back} hidden={{ username: p.username }} className="row">
                      <Badge status="info">{x.watching}</Badge>
                      <button className="btn btn-ghost btn-xs">{x.unwatch}</button>
                    </ActionForm>
                  ) : (
                    <ActionForm action="scout.watch" lang={lang} back={back} hidden={{ username: p.username }}>
                      <button className="btn btn-ghost btn-xs">{x.watch}</button>
                    </ActionForm>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <Empty title={x.empty} />
          )}
          <p className="small muted">{x.privacy}</p>
        </section>

        <aside className="stack scout-aside">
          <section className="card stack-sm">
            <p className="field-label">{x.saved}</p>
            {filters.length ? (
              <ul className="party-members">
                {filters.map((f) => {
                  const link = new URLSearchParams(scoutParams(f.query)).toString();
                  return (
                    <li key={f.id}>
                      <Link href={`/${lang}/scouting${link ? `?${link}` : ""}`} className="grow text-link">
                        {f.name}
                      </Link>
                      <ActionForm action="scout.delete" lang={lang} back={back} hidden={{ filter: f.id }}>
                        <button className="btn btn-ghost btn-xs">{x.delete}</button>
                      </ActionForm>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="small muted">{x.noSaved}</p>
            )}
            {isEmptyQuery(query) ? null : (
              <ActionForm action="scout.save" lang={lang} back={back} hidden={scoutParams(query)} className="inline-form">
                <input name="name" required minLength={2} maxLength={60} placeholder={x.filterName} aria-label={x.filterName} />
                <button className="btn btn-ghost btn-sm">{x.saveFilter}</button>
              </ActionForm>
            )}
          </section>

          <section className="card stack-sm" id="watchlist">
            <p className="field-label">{x.watchlist}</p>
            {watched.length ? (
              <ul className="party-members">
                {watched.map((w) => (
                  <li key={w.username} className="stack-sm">
                    <span className="grow">
                      <Link href={`/${lang}/players/${w.username}`}>{w.display_name}</Link> <span className="small muted">@{w.username}</span>
                      <br />
                      <span className="small muted">
                        {w.best_rating !== null && w.best_game ? `${x.best} ${w.best_rating} (${gameBySlug(w.best_game)?.name ?? w.best_game}) · ` : ""}
                        {w.lft_games.length ? `${x.lftIn}: ${w.lft_games.map((g) => gameBySlug(g)?.name ?? g).join(", ")} · ` : ""}
                        {x.lastActive}: {w.last_active ? <LocalTime iso={w.last_active} lang={lang} dateOnly /> : x.never}
                      </span>
                      {w.note ? <span className="small prewrap"> — {w.note}</span> : null}
                      <details className="disclosure">
                        <summary className="small">{x.note}</summary>
                        <ActionForm action="scout.watch" lang={lang} back={`${back}#watchlist`} hidden={{ username: w.username }} className="inline-form">
                          <input name="note" maxLength={200} defaultValue={w.note} aria-label={x.note} />
                          <button className="btn btn-ghost btn-xs">{x.save}</button>
                        </ActionForm>
                      </details>
                    </span>
                    <ActionForm action="scout.unwatch" lang={lang} back={`${back}#watchlist`} hidden={{ username: w.username }}>
                      <button className="btn btn-ghost btn-xs">{x.unwatch}</button>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">{x.noWatch}</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
