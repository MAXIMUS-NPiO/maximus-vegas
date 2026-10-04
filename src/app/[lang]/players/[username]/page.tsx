import { profileExperience } from "@/server/player-experience.ts";
import { PlayerExperienceCard } from "@/components/player-experience";
import { MemberAvatar } from "@/components/member-avatar";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { playerProfile } from "@/server/queries.ts";
import { avatarColor, hasActiveMembership, rankFor, totalXp } from "@/server/progression.ts";
import { reputation } from "@/server/disputes.ts";
import { seasonHistory } from "@/server/circuits.ts";
import { ratingHistory, ratingsFor } from "@/server/rating.ts";
import { playerHistory } from "@/server/transfers.ts";
import { clanOf } from "@/server/clans.ts";
import { recordStaffView } from "@/server/admin.ts";
import { transferText } from "@/lib/transfer-text.ts";
import { RatingBlock } from "@/components/rating-block";
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
  const ru = lang === "ru";
  // A private profile opened by staff is marked and recorded before it is shown (MV-STAFF-1).
  if (p.staffView && user) await recordStaffView(db, user, p.user.id, "profile");
  const [xp, rep, member, seasons, ratings, ratingEvents] = await Promise.all([
    totalXp(db, p.user.id),
    reputation(db, p.user.id),
    hasActiveMembership(db, p.user.id),
    seasonHistory(db, { userId: p.user.id, teamId: null }),
    ratingsFor(db, p.user.id),
    ratingHistory(db, p.user.id, "", 120),
  ]);
  const [teamEvents, clan, experience] = await Promise.all([playerHistory(db, p.user.id), clanOf(db, p.user.id), profileExperience(db, p.user.id, user?.id)]);
  const draws = p.history.filter((h) => h.drawn).length;
  const { rank } = rankFor(xp);
  return (
    <div className="container page">
      {p.staffView ? (
        <p className="notice notice-warn small">
          {ru
            ? "Закрытый профиль: вы видите его как сотрудник портала. Просмотр записан в журнал."
            : "Private profile: you see it as portal staff. This view is recorded in the log."}
        </p>
      ) : null}
      <header className="profile-head">
        <MemberAvatar name={p.user.display_name} mediaId={p.user.avatar_media_id} size="xl" color={avatarColor(p.user.avatar_color)} />
        <div>
          <h1>{p.user.display_name}</h1>
          <p className="muted">
            @{p.user.username}
            {p.user.country ? ` · ${p.user.country}` : ""} · {d.players.since} <LocalTime iso={p.user.created_at} lang={lang} dateOnly />
          </p>
          <p className="row">
            <Badge status="info">{ru ? "Прогресс в MAXIMUS" : "MAXIMUS progression"}: {ru ? rank.ru : rank.en}</Badge>
            {member ? <Badge status="ok">{ru ? "Членство VEGAS" : "VEGAS member"}</Badge> : null}
            {clan ? (
              <Link href={`/${lang}/clans/${clan.slug}`} className="badge badge-muted">
                {ru ? "Клан" : "Clan"} [{clan.tag}] {clan.name}
              </Link>
            ) : null}
          </p>
          {p.user.bio ? <p className="prewrap">{p.user.bio}</p> : null}
          {p.self ? (
            <Link href={`/${lang}/settings`} className="btn btn-ghost btn-sm">
              {d.players.edit}
            </Link>
          ) : user ? (
            <span className="row">
              <Link href={`/${lang}/my-teams?username=${p.user.username}#invite-player`} className="btn btn-primary btn-sm">{ru ? "Пригласить в команду" : "Invite to team"}</Link>
              <Link href={`/${lang}/community?username=${p.user.username}#friends`} className="btn btn-ghost btn-sm">{ru ? "Добавить в друзья" : "Add friend"}</Link>
              <Link href={`/${lang}/challenges?to=${p.user.username}`} className="btn btn-ghost btn-sm">
                {ru ? "Вызвать на матч 1v1" : "Challenge to a 1v1"}
              </Link>
              <Link href={`/${lang}/conduct?user=${p.user.username}#report`} className="text-link small">
                {ru ? "Сообщить о нарушении" : "Report a violation"}
              </Link>
            </span>
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
          {draws ? (
            <div>
              <dt>{ru ? "Ничьи" : "Draws"}</dt>
              <dd>{draws}</dd>
            </div>
          ) : null}
          <div>
            <dt>{d.players.tournaments}</dt>
            <dd>{p.tournaments.length}</dd>
          </div>
          <div>
            <dt>XP</dt>
            <dd>{xp}</dd>
          </div>
          <div>
            <dt title={ru ? "100 минус 5 за каждое оспаривание, оставленное без удовлетворения" : "100 minus 5 for each dispute rejected after review"}>{ru ? "Репутация" : "Reputation"}</dt>
            <dd>{rep}</dd>
          </div>
        </dl>
      </header>

      <PlayerExperienceCard lang={lang} data={experience} />

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

      {seasons.length ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Сезоны серий" : "Circuit seasons"}</h2>
          <ul className="list">
            {seasons.map((s) => (
              <li key={`${s.slug}-${s.division}`}>
                <span className="grow">
                  <Link href={`/${lang}/circuits/${s.slug}`}>
                    {s.name} · {s.season}
                  </Link>
                  <span className="small muted">
                    {" "}
                    · {s.divisions > 1 ? `${ru ? "дивизион" : "division"} ${s.division} · ` : ""}
                    {ru ? `${s.rank}-е место, ${s.points} очк.` : `#${s.rank}, ${s.points} pts`}
                  </span>
                </span>
                {s.qualified ? <Badge status="ok">{ru ? "Квалификация" : "Qualified"}</Badge> : null}
                {s.movement === "promoted" ? <Badge status="ok">{ru ? "Повышение" : "Promoted"}</Badge> : s.movement === "relegated" ? <Badge status="warn">{ru ? "Понижение" : "Relegated"}</Badge> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {ratings.length || p.self ? <RatingBlock lang={lang} ratings={ratings} history={ratingEvents} /> : null}

      {teamEvents.length ? (
        <section className="section-tight" id="teams-history">
          <h2 className="h3">{transferText[lang].teams}</h2>
          <ul className="list small">
            {teamEvents.map((h, i) => (
              <li key={i}>
                <span className="grow">
                  <Link href={`/${lang}/teams/${h.team_slug}`}>{h.team_name}</Link> — {transferText[lang].events[h.event] ?? h.event}
                </span>
                <span className="muted">
                  <LocalTime iso={h.at} lang={lang} dateOnly />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="section-tight">
        <h2 className="h3">{d.players.history}</h2>
        {p.history.length ? (
          <ul className="list">
            {p.history.map((h) => (
              <li key={h.id} className="history-row">
                <span className={h.drawn ? "result-pill draw" : h.won ? "result-pill win" : "result-pill loss"}>{h.drawn ? (ru ? "Ничья" : "Draw") : h.won ? d.players.win : d.players.loss}</span>
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
                  <li key={JSON.stringify([a.game, a.handle])}>
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
