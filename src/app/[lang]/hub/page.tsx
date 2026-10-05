import { profileExperience } from "@/server/player-experience.ts";
import { PlayerExperienceCard } from "@/components/player-experience";
import Link from "next/link";
import { lobbyTitle } from "@/components/tournament";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { notificationLink, notificationText } from "@/lib/notify-text.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { hub, notifications } from "@/server/queries.ts";
import { needsTermsAcceptance } from "@/server/accounts.ts";
import { mailConfigured } from "@/server/mail.ts";
import { balance, rankFor, totalXp } from "@/server/progression.ts";
import { ActionForm, Badge, DbDown, Empty, Flash, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";
import { Arrow } from "@/components/icons";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "hub", dict(lang).hub.title, undefined, { noindex: true });
}

export default async function Hub({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user) redirect(`/${lang}/signin?next=/${lang}/hub`);
  const [data, notes, termsUpdate, xp, coins, [waiting], experience] = await Promise.all([
    hub(db, user),
    notifications(db, user.id, 8),
    needsTermsAcceptance(db, user.id),
    totalXp(db, user.id),
    balance(db, user.id),
    db.query<{ n: number }>(
      `select count(*)::int as n from challenges
        where (opponent_id = $1 and status = 'pending') or (status = 'accepted' and $1 in (challenger_id, opponent_id))
           or (status = 'reported' and reported_by <> $1 and $1 in (challenger_id, opponent_id))`,
      [user.id],
    ),
    profileExperience(db, user.id, user.id),
  ]);
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  const { rank } = rankFor(xp);
  const back = `/${lang}/hub`;
  const active = data.registrations.filter((r) => !["COMPLETED", "CANCELLED"].includes(r.status));
  const needsCheckIn = active.find((r) => r.check_in_open && r.reg_status === "registered" && !r.checked_in_at);
  const step = data.matches.length || data.lobbies.length
    ? { text: d.hub.steps.match, href: `/${lang}/gameday` }
    : needsCheckIn
      ? { text: d.hub.steps.checkin, href: `/${lang}/tournaments/${needsCheckIn.slug}` }
      : !active.length
        ? { text: d.hub.steps.tournament, href: `/${lang}/tournaments?f=open` }
        : !data.teams.length
          ? { text: d.hub.steps.team, href: `/${lang}/teams/new` }
          : { text: d.hub.steps.profile, href: `/${lang}/settings` };
  return (
    <div className="container page">
      <h1>
        {d.hub.hello}, {user.displayName}
      </h1>
      <Flash lang={lang} params={sp} />
      <nav className="grid grid-3 section-tight" aria-label={T("Быстрые действия", "Quick actions")}>
        <Link className="card card-link" href={`/${lang}/my-teams`}><strong>{T("Мои команды и приглашения", "My teams & invitations")}</strong><span className="small muted">{T("Игроки, составы, зарезервированные имена", "Players, rosters and reserved usernames")}</span></Link>
        <Link className="card card-link" href={`/${lang}/my-teams#invite-player`}><strong>{T("Пригласить игрока", "Invite a player")}</strong><span className="small muted">{T("Команда, получатель, отправка и статус", "Team, recipient, sending and status")}</span></Link>
        <Link className="card card-link" href={`/${lang}/community`}><strong>{T("Моё сообщество", "My community")}</strong><span className="small muted">{T("Друзья, чаты, кланы и поддержка", "Friends, chats, clans and support")}</span></Link>
      </nav>
      <PlayerExperienceCard lang={lang} data={experience} />
      <Link className="btn btn-secondary" href={`/${lang}/studio`}>{T("Студия эфиров и POV", "Live & POV studio")}</Link>
      {termsUpdate ? (
        <div className="notice notice-warn" role="status">
          <p>
            {T("Мы обновили условия использования и уведомление о конфиденциальности.", "We have updated the terms of use and the privacy notice.")}{" "}
            <Link href={`/${lang}/terms`} className="text-link">
              {T("Условия", "Terms")}
            </Link>{" "}
            ·{" "}
            <Link href={`/${lang}/privacy`} className="text-link">
              {T("Конфиденциальность", "Privacy")}
            </Link>
          </p>
          <ActionForm action="account.accept_terms" lang={lang} back={back}>
            <button className="btn btn-primary btn-sm">{T("Принять новую редакцию", "Accept the new version")}</button>
          </ActionForm>
        </div>
      ) : null}
      {!user.emailVerified && mailConfigured() ? (
        <div className="notice" role="status">
          <p>{T("Подтвердите email — это нужно для восстановления доступа и оплаты членства.", "Confirm your email — it is needed for account recovery and membership payments.")}</p>
          <ActionForm action="auth.verify_request" lang={lang} back={back}>
            <button className="btn btn-ghost btn-sm">{T("Отправить письмо", "Send the email")}</button>
          </ActionForm>
        </div>
      ) : null}
      {!user.onboarded ? (
        <p className="small">
          <Link href={`/${lang}/welcome`} className="text-link">
            {T("Завершите первые шаги: страна, игровые ники, команда", "Finish getting started: country, in-game names, team")}
          </Link>
        </p>
      ) : null}
      <div className="grid grid-3 section-tight">
        <Link href={`/${lang}/progress`} className="card card-link">
          <span className="field-label">{T("Прогресс в MAXIMUS", "MAXIMUS progression")}</span>
          <strong>{ru ? rank.ru : rank.en}</strong>
          <span className="small muted">{xp} XP</span>
        </Link>
        <Link href={`/${lang}/progress#shop`} className="card card-link">
          <span className="field-label">{T("Монеты", "Coins")}</span>
          <strong>{coins}</strong>
          <span className="small muted">{T("только косметика, без вывода", "cosmetics only, no cash-out")}</span>
        </Link>
        <Link href={`/${lang}/challenges`} className="card card-link">
          <span className="field-label">{T("Вызовы 1v1", "1v1 challenges")}</span>
          <strong>{waiting?.n ?? 0}</strong>
          <span className="small muted">{T("ждут вашего действия", "waiting for you")}</span>
        </Link>
      </div>
      <Link href={step.href} className="card card-link next-step">
        <span className="field-label">{d.hub.nextStep}</span>
        <span className="next-step-text">{step.text}</span>
        <Arrow />
      </Link>

      <section className="section-tight">
        <div className="row-between">
          <h2 className="h3">{d.hub.nextMatch}</h2>
          <Link href={`/${lang}/gameday`} className="text-link small">
            {d.x.nav.gameDay} →
          </Link>
        </div>
        {data.matches.length ? (
          <div className="grid grid-2">
            {data.matches.map((m) => (
              <Link key={m.id} href={`/${lang}/matches/${m.id}`} className="card card-link">
                <div className="row-between">
                  <span className="small muted">
                    {m.t_name} · {gameBySlug(m.t_game)?.name}
                  </span>
                  <Badge status={m.status}>{d.statuses.match[m.status]}</Badge>
                </div>
                <h3>
                  {m.a_name ?? d.common.tbd} <span className="muted">{d.common.vs}</span> {m.b_name ?? d.common.tbd}
                </h3>
                <p className="small">
                  {m.scheduled_at ? <LocalTime iso={m.scheduled_at} lang={lang} /> : d.match.notScheduled}
                  {m.room_code ? ` · ${d.match.room}: ${m.room_code}` : ""}
                </p>
              </Link>
            ))}
          </div>
        ) : data.lobbies.length ? null : (
          <Empty
            title={d.hub.noMatches}
            action={
              <Link href={`/${lang}/tournaments?f=open`} className="btn btn-primary btn-sm">
                {d.home.ctaTournaments}
              </Link>
            }
          />
        )}
      </section>

      {data.lobbies.length ? (
        <section className="section-tight">
          <h2 className="h3">{lang === "ru" ? "Мои лобби" : "My lobbies"}</h2>
          <div className="grid grid-2">
            {data.lobbies.map((l) => (
              <Link key={l.id} href={`/${lang}/lobbies/${l.id}`} className="card card-link">
                <div className="row-between">
                  <span className="small muted">
                    {l.t_name} · {gameBySlug(l.t_game)?.name}
                  </span>
                  <Badge status="in_progress">FFA</Badge>
                </div>
                <h3>{lobbyTitle(l.round, l.lobby_no, l.lobbies, lang)}</h3>
                <p className="small">
                  {l.scheduled_at ? <LocalTime iso={l.scheduled_at} lang={lang} /> : d.match.notScheduled}
                  {` · ${lang === "ru" ? "игр осталось" : "games left"}: ${l.games_left}`}
                  {l.room_code ? ` · ${lang === "ru" ? "код" : "code"}: ${l.room_code}` : ""}
                </p>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {data.invites.length ? (
        <section className="section-tight">
          <h2 className="h3">{d.hub.invites}</h2>
          <ul className="list">
            {data.invites.map((i) => (
              <li key={i.id}>
                <span className="grow">
                  <Link href={`/${lang}/teams/${i.team_slug}`}>{i.team_name}</Link>{" "}
                  <span className="small muted">
                    {gameBySlug(i.game)?.name} · @{i.invited_by}
                  </span>
                </span>
                <span className="row">
                  <ActionForm action="team.respond" lang={lang} back={back} hidden={{ invite: i.id, accept: "1" }}>
                    <button className="btn btn-primary btn-xs">{d.hub.accept}</button>
                  </ActionForm>
                  <ActionForm action="team.respond" lang={lang} back={back} hidden={{ invite: i.id, accept: "0" }}>
                    <button className="btn btn-ghost btn-xs">{d.hub.decline}</button>
                  </ActionForm>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid grid-2 section-tight">
        <section>
          <h2 className="h3">{d.hub.registrations}</h2>
          {data.registrations.length ? (
            <ul className="list">
              {data.registrations.map((r) => (
                <li key={r.slug}>
                  <span className="grow">
                    <Link href={`/${lang}/tournaments/${r.slug}`}>{r.name}</Link>
                    <span className="small muted">
                      {" "}
                      · {r.team_name ?? gameBySlug(r.game)?.name} · <LocalTime iso={r.starts_at} lang={lang} />
                    </span>
                  </span>
                  <span>
                    {r.placement ? (
                      <strong>
                        {d.tournaments.place} {r.placement}
                      </strong>
                    ) : (
                      <Badge status={r.reg_status === "registered" ? r.status : r.reg_status}>
                        {r.reg_status === "registered" ? d.statuses.tournament[r.status] : d.statuses.registration[r.reg_status]}
                      </Badge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{d.hub.noRegistrations}</p>
          )}
          <p>
            <Link href={`/${lang}/calendar`} className="text-link small">
              {d.hub.calendar}
            </Link>
          </p>
        </section>
        <section>
          <h2 className="h3">{d.hub.notifications}</h2>
          {notes.length ? (
            <ul className="list">
              {notes.map((n) => (
                <li key={n.id} className={n.read_at ? undefined : "is-unread"}>
                  <Link href={notificationLink(lang, n.data)} className="grow">
                    {notificationText(lang, n.kind, n.data)}
                  </Link>
                  <span className="small muted">
                    <LocalTime iso={n.created_at} lang={lang} withZone={false} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{d.notifications.empty}</p>
          )}
          <Link href={`/${lang}/notifications`} className="text-link small">
            {d.hub.allNotifications}
          </Link>
        </section>
      </div>

      <div className="grid grid-2 section-tight">
        <section>
          <h2 className="h3">{d.hub.teams}</h2>
          <p><Link className="text-link" href={`/${lang}/my-teams`}>{T("Все мои команды и приглашения", "All my teams & invitations")} →</Link></p>
          {data.teams.length ? (
            <ul className="list">
              {data.teams.map((t) => (
                <li key={t.slug}>
                  <Link href={`/${lang}/teams/${t.slug}`}>{t.name}</Link>
                  <span className="small muted">
                    {gameBySlug(t.game)?.name} · {t.role === "owner" ? d.teams.owner : t.role === "captain" ? d.teams.captain : d.teams.player}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <Link href={`/${lang}/teams/new`} className="btn btn-ghost btn-sm">
            {d.teams.create}
          </Link>
        </section>
        <section>
          <h2 className="h3">{d.hub.orgs}</h2>
          {data.orgs.length ? (
            <ul className="list">
              {data.orgs.map((o) => (
                <li key={o.slug}>
                  <Link href={`/${lang}/organizer/${o.slug}`}>{o.name}</Link>
                  <span className="small muted">{d.organizer.roles[o.role]}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <Link href={`/${lang}/organizer`} className="btn btn-ghost btn-sm">
            {d.home.runTournament}
          </Link>
        </section>
      </div>
    </div>
  );
}
