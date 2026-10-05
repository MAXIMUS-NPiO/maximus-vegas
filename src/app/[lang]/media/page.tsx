import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { GAMES, isGame, gameBySlug } from "@/lib/games.ts";
import { mediaText } from "@/lib/media-text.ts";
import { viewer } from "@/server/viewer.ts";
import { mediaCentre, type MediaRow } from "@/server/streams.ts";
import { DbDown, Empty, Flash, one, PageHead, type SearchParams } from "@/components/ui";
import { ApplicationForm } from "@/components/application-form";
import { portalHost, StreamCard } from "@/components/streams";
import { publicBroadcasts } from "@/server/broadcasts.ts";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "media", mediaText[lang].title, mediaText[lang].lead);
}

/** Media centre (MV-MEDIA-1): streams of events under way, the schedule and recordings of public tournaments. */
export default async function Media({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const x = mediaText[lang];
  const d = dict(lang);
  const sp = await searchParams;
  const requested = one(sp.game);
  const game = isGame(requested) ? requested : "";
  const { db, user, dbError } = await viewer();
  const data = db ? await mediaCentre(db, game) : { live: [], upcoming: [], vods: [] };
  const host = await portalHost();
  const native = db ? await publicBroadcasts(db) : [];
  const context = (r: MediaRow) => (
    <>
      <Link href={`/${lang}/tournaments/${r.t_slug}`}>{r.t_name}</Link> · {gameBySlug(r.t_game)?.name ?? r.t_game}
      {r.match_id ? (
        <>
          {" "}
          ·{" "}
          <Link href={`/${lang}/matches/${r.match_id}`}>
            {r.a_name ?? x.tbd} — {r.b_name ?? x.tbd}
          </Link>
        </>
      ) : null}
    </>
  );
  const Cards = ({ rows, empty }: { rows: MediaRow[]; empty: string }) =>
    rows.length ? (
      <div className="grid grid-2">
        {rows.map((r) => (
          <StreamCard key={r.id} s={r} lang={lang} host={host} context={context(r)} />
        ))}
      </div>
    ) : (
      <Empty title={empty} />
    );
  return (
    <div className="container page">
      <PageHead title={x.title} lead={x.lead} />
      <Link className="btn btn-primary" href={`/${lang}/studio`}>{lang === "ru" ? "Открыть студию эфиров и POV" : "Open live & POV studio"}</Link>
      <Flash lang={lang} params={sp} />
      {dbError ? (
        <DbDown lang={lang} />
      ) : (
        <>
          <form method="get" action={`/${lang}/media`} className="inline-form toolbar">
            <select name="game" defaultValue={game} aria-label={d.tournaments.game}>
              <option value="">{x.allGames}</option>
              {GAMES.map((g) => (
                <option key={g.slug} value={g.slug}>
                  {g.name}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost btn-sm">{x.show}</button>
          </form>
          <section className="section-tight stack-sm" id="live">
            <h2 className="h3">{x.live}</h2>
            {native.length ? <div className="grid grid-2">{native.map(b => <Link key={b.id} className="card card-link" href={`/${lang}/watch/${b.id}`}><span className="small muted">LIVE · {b.display_name}</span><h3>{b.title}</h3></Link>)}</div> : null}
            {data.live.length || !native.length ? <><p className="small muted">{x.liveNote}</p><Cards rows={data.live} empty={x.noLive} /></> : null}
          </section>
          <section className="section-tight stack-sm" id="schedule">
            <h2 className="h3">{x.upcoming}</h2>
            <Cards rows={data.upcoming} empty={x.noUpcoming} />
          </section>
          <section className="section-tight stack-sm" id="vods">
            <h2 className="h3">{x.vods}</h2>
            <Cards rows={data.vods} empty={x.noVods} />
          </section>
        </>
      )}
      <section className="section-tight split">
        <div className="stack-sm">
          <h2 className="h3">{x.creators}</h2>
          <p className="small muted">{x.creatorsLead}</p>
        </div>
        <ApplicationForm lang={lang} back={`/${lang}/media`} kinds={["media"]} user={user} title={d.partners.apply} />
      </section>
    </div>
  );
}
