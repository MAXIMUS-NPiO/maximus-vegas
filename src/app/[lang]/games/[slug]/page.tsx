import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { publicGames } from "@/server/catalog.ts";
import { gameModeLabel, gameRosterLabel, gameFormatsLabel } from "@/lib/catalog-labels.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { listTeams, listTournaments } from "@/server/queries.ts";
import { DbDown, Empty, PageHead } from "@/components/ui";
import { TournamentCard } from "@/components/tournament";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  const game = (await publicGames((await viewer()).db,true)).find(g=>g.slug===slug);
  if (!isLocale(lang) || !game) return {};
  return pageMeta(lang, `games/${slug}`, game.name, `${game.name} — ${game.genre[lang]}`);
}

export default async function GamePage({ params }: { params: Promise<{ lang: string; slug: string }> }) {
  const { lang, slug } = await params;
  const game = (await publicGames((await viewer()).db,true)).find(g=>g.slug===slug);
  if (!isLocale(lang) || !game) notFound();
  const d = dict(lang);
  const { db, dbError } = await viewer();
  const tournaments = db ? await listTournaments(db, { game: game.slug, filter: "all", limit: 24 }).catch(() => []) : [];
  const teams = db ? (await listTeams(db, game.slug).catch(() => [])).slice(0, 12) : [];
  return (
    <div className="container page">
      <PageHead eyebrow={`${game.genre[lang]} · ${game.platforms.map((p) => d.games.platforms[p]).join(" · ")}`} title={game.name}>
        <span className="badge badge-ok">{gameModeLabel(game.mode,lang) + " · " + gameFormatsLabel(game.formats,lang)}</span>
      </PageHead>
      {game.retired ? <p className="notice">{lang==="ru"?"Игра выведена из каталога. История турниров сохранена; новые турниры и команды не создаются.":"This game is retired. Tournament history remains available; new events and teams are disabled."}</p> : null}
      <div className="split">
        <section>
          <h2 className="h3">{d.games.verificationTitle}</h2>
          <p>{lang==="ru" ? "Результаты подтверждают участники и судьи. Для таблицы результатов участник отправляет статистику с доказательствами; в многосторонних лобби судья вводит места и очки. Автоматический сбор зависит от отдельно подключённого источника данных." : "Results are confirmed by participants and referees. Leaderboard entrants submit statistics with evidence; referees enter placements and points in multi-party lobbies. Automatic collection requires a separately connected data source."}</p>
          {game.apiNote ? (
            <div className="notice">
              <strong>{d.games.apiTitle}</strong>
              <p>{game.apiNote[lang]}</p>
            </div>
          ) : null}
        </section>
        <section>
          <h2 className="h3">{d.games.matrixTitle}</h2>
          <dl className="kv">
            <div><dt>{lang==="ru"?"Игровой режим":"Game mode"}</dt><dd>{gameModeLabel(game.mode,lang)}</dd></div>
            <div><dt>{lang==="ru"?"Форматы турниров":"Tournament formats"}</dt><dd>{gameFormatsLabel(game.formats,lang)}</dd></div>
            <div><dt>{lang==="ru"?"Подтверждение результатов":"Result verification"}</dt><dd>{lang==="ru"?"Участники и судьи; спорные результаты рассматриваются отдельно":"Participants and referees; disputed results are reviewed separately"}</dd></div>
            <div>
              <dt>{d.games.teamSize}</dt>
              <dd>{gameRosterLabel(game,lang)}</dd>
            </div>
          </dl>
        </section>
      </div>
      <section className="section-tight">
        <h2 className="h3">{d.games.tournamentsTitle}</h2>
        {dbError ? (
          <DbDown lang={lang} />
        ) : tournaments.length ? (
          <div className="grid grid-3">
            {tournaments.map((x) => (
              <TournamentCard key={x.id} lang={lang} t={x} />
            ))}
          </div>
        ) : (
          <Empty title={d.games.noTournaments}>
            <Link href={`/${lang}/organizer`} className="text-link">
              {d.tournaments.create}
            </Link>
          </Empty>
        )}
      </section>
      {teams.length ? (
        <section className="section-tight">
          <h2 className="h3">{d.games.teamsTitle}</h2>
          <ul className="list">
            {teams.map((tm) => (
              <li key={tm.slug}>
                <Link href={`/${lang}/teams/${tm.slug}`} className="text-link">
                  {tm.name}
                </Link>
                <span className="muted small">
                  {tm.members} · {tm.wins} {d.teams.wins}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
