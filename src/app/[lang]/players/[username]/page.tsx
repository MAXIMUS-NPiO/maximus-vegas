import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { playerProfile } from "@/server/queries.ts";
import { Badge, DbDown, Empty } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; username: string }> }): Promise<Metadata> {
  const { lang, username } = await params;
  if (!isLocale(lang)) return {};
  const { db, user } = await viewer();
  const p = db ? await playerProfile(db, username, user).catch(() => null) : null;
  if (!p || p.hidden) return pageMeta(lang, `players/${username}`, dict(lang).players.title, undefined, { noindex: true });
  return pageMeta(lang, `players/${username}`, p.user.display_name, `@${p.user.username}`);
}

export default async function Player({ params }: { params: Promise<{ lang: string; username: string }> }) {
  const { lang, username } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  const p = await playerProfile(db, username, user);
  if (!p) notFound();
  if (p.hidden)
    return (
      <div className="container page">
        <h1>@{p.user.username}</h1>
        <p className="muted">{d.players.hidden}</p>
      </div>
    );
  const wins = p.history.filter((h) => h.won).length;
  return (
    <div className="container page">
      <header className="profile-head">
        <span className="avatar avatar-xl" aria-hidden="true">
          {p.user.display_name.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <h1>{p.user.display_name}</h1>
          <p className="muted">
            @{p.user.username}
            {p.user.country ? ` · ${p.user.country}` : ""} · {d.players.since} <LocalTime iso={p.user.created_at} lang={lang} dateOnly />
          </p>
          {p.user.bio ? <p className="prewrap">{p.user.bio}</p> : null}
          {p.self ? (
            <Link href={`/${lang}/settings`} className="btn btn-ghost btn-sm">
              {d.players.edit}
            </Link>
          ) : null}
        </div>
        <dl className="stat-row">
          <div>
            <dt>{d.players.history}</dt>
            <dd>{p.history.length}</dd>
          </div>
          <div>
            <dt>{d.players.win}</dt>
            <dd>{wins}</dd>
          </div>
          <div>
            <dt>{d.players.tournaments}</dt>
            <dd>{p.tournaments.length}</dd>
          </div>
        </dl>
      </header>

      <section className="section-tight">
        <h2 className="h3">{d.players.passport}</h2>
        <p className="small muted">{d.players.passportNote}</p>
        {p.tournaments.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{d.players.tournaments}</th>
                  <th>{d.tournaments.game}</th>
                  <th>{d.tournaments.place}</th>
                  <th>{d.tournaments.starts}</th>
                </tr>
              </thead>
              <tbody>
                {p.tournaments.map((x) => (
                  <tr key={x.slug}>
                    <td>
                      <Link href={`/${lang}/tournaments/${x.slug}`}>{x.name}</Link>
                      {x.team_name ? <div className="small muted">{x.team_name}</div> : null}
                    </td>
                    <td>{gameBySlug(x.game)?.name ?? x.game}</td>
                    <td>{x.placement ? <strong>{x.placement}</strong> : <Badge status={x.status}>{d.statuses.tournament[x.status]}</Badge>}</td>
                    <td className="small">
                      <LocalTime iso={x.starts_at} lang={lang} dateOnly />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={d.players.noTournaments} />
        )}
      </section>

      <section className="section-tight">
        <h2 className="h3">{d.players.history}</h2>
        {p.history.length ? (
          <ul className="list">
            {p.history.map((h) => (
              <li key={h.id} className="history-row">
                <span className={h.won ? "result-pill win" : "result-pill loss"}>{h.won ? d.players.win : d.players.loss}</span>
                <span className="grow">
                  <Link href={`/${lang}/matches/${h.id}`}>
                    {h.opponent ? `${d.common.vs} ${h.opponent}` : d.match.title}
                  </Link>
                  <span className="small muted">
                    {" "}
                    · <Link href={`/${lang}/tournaments/${h.t_slug}`}>{h.t_name}</Link> · {gameBySlug(h.t_game)?.name ?? h.t_game}
                  </span>
                </span>
                <span className="mono">{h.my_score !== null && h.their_score !== null ? `${h.my_score}:${h.their_score}` : d.statuses.outcome[h.outcome]}</span>
                <span className="small muted">
                  {h.source ? d.statuses.source[h.source] : d.statuses.outcome[h.outcome]}
                  {h.versions > 1 ? ` · ${h.versions} ${d.players.versions}` : ""}
                </span>
                <span className="small muted">
                  <LocalTime iso={h.completed_at} lang={lang} dateOnly />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={d.players.noHistory} />
        )}
        <p className="small muted">{d.players.appeal}</p>
      </section>

      <div className="grid grid-2">
        <section>
          <h2 className="h3">{d.players.teams}</h2>
          {p.teams.length ? (
            <ul className="list">
              {p.teams.map((t) => (
                <li key={t.slug}>
                  <Link href={`/${lang}/teams/${t.slug}`}>{t.name}</Link>
                  <span className="small muted">{gameBySlug(t.game)?.name ?? t.game}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{d.teams.noTeams}</p>
          )}
        </section>
        <section>
          <h2 className="h3">{d.players.accounts}</h2>
          {p.accounts.length ? (
            <>
              <ul className="list">
                {p.accounts.map((a) => (
                  <li key={a.game}>
                    <span>{gameBySlug(a.game)?.name ?? a.game}</span>
                    <span className="mono">{a.handle}</span>
                  </li>
                ))}
              </ul>
              <p className="small muted">{d.players.accountsNote}</p>
            </>
          ) : (
            <p className="muted">—</p>
          )}
        </section>
      </div>
    </div>
  );
}
