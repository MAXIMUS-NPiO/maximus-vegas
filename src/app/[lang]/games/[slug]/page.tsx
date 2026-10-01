import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { GAMES, gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { listTeams, listTournaments } from "@/server/queries.ts";
import { DbDown, Empty, PageHead } from "@/components/ui";
import { TournamentCard } from "@/components/tournament";

export function generateStaticParams() {
  return GAMES.map((g) => ({ slug: g.slug }));
}
export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  const game = gameBySlug(slug);
  if (!isLocale(lang) || !game) return {};
  return pageMeta(lang, `games/${slug}`, game.name, `${game.name} — ${game.genre[lang]}`);
}

export default async function GamePage({ params }: { params: Promise<{ lang: string; slug: string }> }) {
  const { lang, slug } = await params;
  const game = gameBySlug(slug);
  if (!isLocale(lang) || !game) notFound();
  const d = dict(lang);
  const { db, dbError } = await viewer();
  const tournaments = db ? await listTournaments(db, { game: game.slug, filter: "all", limit: 24 }).catch(() => []) : [];
  const teams = db ? (await listTeams(db, game.slug).catch(() => [])).slice(0, 12) : [];
  return (
    <div className="container page">
      <PageHead eyebrow={`${game.genre[lang]} · ${game.platforms.map((p) => d.games.platforms[p]).join(" · ")}`} title={game.name}>
        <span className="badge badge-ok">{game.bracket ? d.games.formatBracket : d.games.formatFfa}</span>
      </PageHead>
      <div className="split">
        <section>
          <h2 className="h3">{d.games.verificationTitle}</h2>
          <p>{game.bracket ? d.games.verificationManual : d.games.verificationFfa}</p>
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
            {(game.bracket ? d.games.matrix : d.games.matrixFfa).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
            <div>
              <dt>{d.games.teamSize}</dt>
              <dd>{game.teamSize === 1 ? d.games.solo : game.bracket ? `${game.teamSize}v${game.teamSize}` : d.games.squads.replace("{n}", String(game.teamSize))}</dd>
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
