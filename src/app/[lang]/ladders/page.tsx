import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { GAMES, gameBySlug, isGame } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { clanText } from "@/lib/clan-text.ts";
import { viewer } from "@/server/viewer.ts";
import { clanLadder, clanOf, ladderSeasons, playerLadder, settleWars } from "@/server/clans.ts";
import { isSeason } from "@/server/ladder-rules.ts";
import { Badge, DbDown, Empty, one, PageHead, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "ladders", clanText[lang].laddersTitle, clanText[lang].laddersLead);
}

export default async function Ladders({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const x = clanText[lang];
  const sp = await searchParams;
  const game = isGame(one(sp.game)) ? (one(sp.game) as string) : "cs2";
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <PageHead title={x.laddersTitle} lead={x.laddersLead} />
        <DbDown lang={lang} />
      </div>
    );
  await settleWars(db).catch(() => undefined);
  const seasons = await ladderSeasons(db);
  const asked = one(sp.season);
  const season = isSeason(asked) && seasons.includes(asked) ? asked : seasons[0];
  const duel = Boolean(gameBySlug(game)?.bracket);
  const [clans, players, mine] = await Promise.all([
    duel ? clanLadder(db, season, game) : Promise.resolve([]),
    playerLadder(db, season, game),
    user ? clanOf(db, user.id) : Promise.resolve(null),
  ]);
  const link = (g: string, s = season) => `/${lang}/ladders?season=${s}&game=${g}`;
  return (
    <div className="container page">
      <PageHead title={x.laddersTitle} lead={x.laddersLead}>
        <Link href={`/${lang}/clans`} className="btn btn-ghost btn-sm">
          {x.title}
        </Link>
      </PageHead>
      <form method="get" action={`/${lang}/ladders`} className="inline-form toolbar">
        <input type="hidden" name="game" value={game} />
        <select name="season" defaultValue={season} aria-label={x.season}>
          {seasons.map((s) => (
            <option key={s} value={s}>
              {x.seasonLabel(s)}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost btn-sm">{x.find}</button>
      </form>
      <nav className="chips" aria-label={x.game}>
        {GAMES.filter((g) => !g.legacy).map((g) => (
          <Link key={g.slug} href={link(g.slug)} className={g.slug === game ? "chip is-active" : "chip"}>
            {g.name}
          </Link>
        ))}
      </nav>
      <h2 className="h3">
        {gameBySlug(game)?.name} · {x.seasonLabel(season)}
      </h2>
      <div className="grid grid-2 board-grid">
        <section>
          <h3 className="h4">{x.clansBoard}</h3>
          {!duel ? (
            <p className="small muted">{x.noDuel}</p>
          ) : clans.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{x.clan}</th>
                    <th>{x.rating}</th>
                    <th>{x.warsCol}</th>
                    <th>{x.wins}</th>
                    <th>{x.losses}</th>
                  </tr>
                </thead>
                <tbody>
                  {clans.map((c, i) => (
                    <tr key={c.clan_id}>
                      <td>{i + 1}</td>
                      <td>
                        <Link href={`/${lang}/clans/${c.slug}`}>
                          [{c.tag}] {c.name}
                        </Link>{" "}
                        {mine?.id === c.clan_id ? <Badge status="info">{x.mine}</Badge> : null}
                      </td>
                      <td>
                        <strong>{c.rating}</strong>
                      </td>
                      <td>{c.wars}</td>
                      <td>{c.wins}</td>
                      <td>{c.losses}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title={x.noClanBoard} />
          )}
        </section>
        <section>
          <h3 className="h4">{x.playersBoard}</h3>
          {players.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{x.player}</th>
                    <th>{x.rating}</th>
                    <th>{x.matches}</th>
                    <th>{x.wins}</th>
                    <th>{x.losses}</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((p, i) => (
                    <tr key={p.username}>
                      <td>{i + 1}</td>
                      <td>
                        <Link href={`/${lang}/players/${p.username}`}>{p.display_name}</Link>{" "}
                        {user?.username === p.username ? <Badge status="info">{x.mine}</Badge> : null}
                      </td>
                      <td>
                        <strong>{p.rating}</strong>
                      </td>
                      <td>{p.matches}</td>
                      <td>{p.wins}</td>
                      <td>{p.losses}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title={x.noPlayerBoard} />
          )}
        </section>
      </div>
    </div>
  );
}
