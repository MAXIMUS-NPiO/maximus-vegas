import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { listPlayers, listTournaments } from "@/server/queries.ts";
import { DbDown, one, PageHead, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "search", dict(lang).search.title, undefined, { noindex: true });
}

export default async function Search({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const q = one((await searchParams).q).trim().slice(0, 60);
  const { db, dbError } = await viewer();
  const needle = q.toLowerCase();
  let tournaments: Array<{ slug: string; name: string }> = [];
  let players: Array<{ username: string; display_name: string }> = [];
  let teams: Array<{ slug: string; name: string }> = [];
  if (db && q.length >= 2) {
    tournaments = (await listTournaments(db, { filter: "all", limit: 200 })).filter((x) => x.name.toLowerCase().includes(needle)).slice(0, 20);
    players = (await listPlayers(db, q)).slice(0, 20);
    const like = `%${needle.replace(/[%_]/g, "")}%`;
    teams = await db.query<{ slug: string; name: string }>("select slug, name from teams where lower(name) like $1 or lower(tag) like $1 order by name limit 20", [like]);
  }
  const nothing = q.length >= 2 && !tournaments.length && !players.length && !teams.length;
  return (
    <div className="container narrow page">
      <PageHead title={d.search.title} />
      <form method="get" className="inline-form toolbar">
        <input name="q" defaultValue={q} placeholder={d.common.searchPlaceholder} aria-label={d.common.searchPlaceholder} maxLength={60} autoFocus />
        <button className="btn btn-primary btn-sm">{d.common.search}</button>
      </form>
      {dbError ? <DbDown lang={lang} /> : null}
      {q.length > 0 && q.length < 2 ? <p className="muted">{d.search.hint}</p> : null}
      {nothing ? <p className="muted">{d.search.nothing}</p> : null}
      {tournaments.length ? (
        <section className="section-tight">
          <h2 className="h4">{d.search.tournaments}</h2>
          <ul className="link-list">
            {tournaments.map((x) => (
              <li key={x.slug}>
                <Link href={`/${lang}/tournaments/${x.slug}`}>{x.name}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {players.length ? (
        <section className="section-tight">
          <h2 className="h4">{d.search.players}</h2>
          <ul className="link-list">
            {players.map((x) => (
              <li key={x.username}>
                <Link href={`/${lang}/players/${x.username}`}>{x.display_name}</Link> <span className="small muted">@{x.username}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {teams.length ? (
        <section className="section-tight">
          <h2 className="h4">{d.search.teams}</h2>
          <ul className="link-list">
            {teams.map((x) => (
              <li key={x.slug}>
                <Link href={`/${lang}/teams/${x.slug}`}>{x.name}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
