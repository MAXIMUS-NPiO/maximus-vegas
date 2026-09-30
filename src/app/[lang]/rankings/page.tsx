import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { GAMES, gameBySlug, isGame } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { rankings } from "@/server/queries.ts";
import { DbDown, Empty, one, PageHead, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "rankings", dict(lang).rankings.title, dict(lang).rankings.lead);
}

export default async function Rankings({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const sp = await searchParams;
  const game = isGame(one(sp.game)) ? one(sp.game) : "cs2";
  const { db, dbError } = await viewer();
  const data = db ? await rankings(db, game).catch(() => ({ solo: [], teams: [] })) : { solo: [], teams: [] };
  const table = (rows: typeof data.solo, kind: "players" | "teams") =>
    rows.length ? (
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>{kind === "players" ? d.rankings.solo : d.rankings.teams}</th>
              <th>{d.rankings.titles}</th>
              <th>{d.rankings.wins}</th>
              <th>{lang === "ru" ? "Ничьи" : "Draws"}</th>
              <th>{d.rankings.losses}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.link}>
                <td>{i + 1}</td>
                <td>
                  <Link href={`/${lang}/${kind}/${r.link}`}>{r.name}</Link>
                </td>
                <td>{r.titles}</td>
                <td>{r.wins}</td>
                <td>{r.draws}</td>
                <td>{r.losses}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty title={d.rankings.empty} />
    );
  return (
    <div className="container page">
      <PageHead title={d.rankings.title} lead={d.rankings.lead} />
      <nav className="chips" aria-label={d.tournaments.game}>
        {GAMES.filter((g) => g.bracket).map((g) => (
          <Link key={g.slug} href={`/${lang}/rankings?game=${g.slug}`} className={g.slug === game ? "chip is-active" : "chip"}>
            {g.name}
          </Link>
        ))}
      </nav>
      <h2 className="h3">{gameBySlug(game)?.name}</h2>
      {dbError ? (
        <DbDown lang={lang} />
      ) : (
        <div className="grid grid-2">
          <section>
            <h3 className="h4">{d.rankings.solo}</h3>
            {table(data.solo, "players")}
          </section>
          <section>
            <h3 className="h4">{d.rankings.teams}</h3>
            {table(data.teams, "teams")}
          </section>
        </div>
      )}
    </div>
  );
}
