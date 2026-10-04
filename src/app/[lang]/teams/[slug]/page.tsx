import { AutoImageInput } from "@/components/auto-image-input";
import { ShareInvitation } from "@/components/share-invitation";
import { siteOrigin } from "@/lib/site.ts";
import { MemberAvatar } from "@/components/member-avatar";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { teamBySlug } from "@/server/queries.ts";
import { mediaUrl } from "@/server/media.ts";
import { ActionForm, Badge, DbDown, Field, Flash, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";
import { finderText } from "@/lib/finder-text.ts";
import { applicationsToDecide, ledTeams, pendingPostIds, teamVacancies } from "@/server/finder.ts";
import { PostCard } from "@/components/finder-post";
import { TeamTransfers } from "@/components/team-transfers";
import { teamHistory, teamTransfers } from "@/server/transfers.ts";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  const { db } = await viewer();
  const data = db ? await teamBySlug(db, slug).catch(() => null) : null;
  return pageMeta(lang, `teams/${slug}`, data?.team.name ?? dict(lang).teams.title);
}

export default async function TeamPage({ params, searchParams }: { params: Promise<{ lang: string; slug: string }>; searchParams: SearchParams }) {
  const { lang, slug } = await params;
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
  const data = await teamBySlug(db, slug);
  if (!data) notFound();
  const { team, members, invites, tournaments, stats } = data;
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  const isOwner = user?.id === team.owner_id;
  const isLeader = isOwner || user?.id === team.captain_id;
  const isMember = Boolean(user && members.some((m) => m.id === user.id));
  const reservations = isLeader ? await db.query<{id:string;username:string;expires_at:Date}>("select id,username,expires_at from username_reservations where team_id=$1 and status='pending' and expires_at>now() order by created_at desc",[team.id]) : [];
  const back = `/${lang}/teams/${team.slug}`;
  const hidden = { team: team.id };
  const fx = finderText[lang];
  const vacancies = await teamVacancies(db, team.id);
  const vacancyIds = new Set(vacancies.map((p) => p.id));
  const toDecide = isLeader && user ? (await applicationsToDecide(db, user.id)).filter((a) => vacancyIds.has(a.post_id)) : [];
  const applied = user && vacancies.length && !isMember ? await pendingPostIds(db, user.id) : new Set<string>();
  const [transferRows, history, myLedTeams] = await Promise.all([teamTransfers(db, team.id), teamHistory(db, team.id), user ? ledTeams(db, user.id) : Promise.resolve([])]);
  return (
    <div className="container page">
      {team.banner_media_id ? <img src={mediaUrl(team.banner_media_id)!} alt="" className="banner-img" /> : null}
      <p className="eyebrow">
        <Link href={`/${lang}/games/${team.game}`}>{gameBySlug(team.game)?.name ?? team.game}</Link>
      </p>
      <div className="team-head">
        {team.logo_media_id ? <img src={mediaUrl(team.logo_media_id)!} alt="" width={64} height={64} className="team-logo" /> : null}
        <h1>
          {team.name} {team.tag ? <span className="badge badge-muted">{team.tag}</span> : null}
        </h1>
      </div>
      <Flash lang={lang} params={sp} />
      {isMember && <p><Link href={`/${lang}/community/chat?scope=team&id=${team.id}`} className="btn btn-primary btn-sm">{ru ? "Чат нашей команды" : "Our team chat"}</Link></p>}
      {user && <div className="row wrap section-tight"><Link className="btn btn-ghost btn-sm" href={`/${lang}/my-teams`}>{T("Мои команды и приглашения", "My teams & invitations")}</Link>{isLeader && <Link className="btn btn-primary btn-sm" href={`/${lang}/my-teams?team=${team.id}#invite-player`}>{T("Пригласить игрока", "Invite a player")}</Link>}</div>}
      <dl className="stat-row section-tight">
        <div>
          <dt>{T("Матчи", "Matches")}</dt>
          <dd>{stats.played}</dd>
        </div>
        <div>
          <dt>{T("Победы", "Wins")}</dt>
          <dd>{stats.wins}</dd>
        </div>
        <div>
          <dt>{T("Турниры", "Tournaments")}</dt>
          <dd>{tournaments.length}</dd>
        </div>
        <div>
          <dt>{T("Призовые места", "Podiums")}</dt>
          <dd>{stats.podiums}</dd>
        </div>
      </dl>
      <div className="grid grid-2">
        <section>
          <h2 className="h3">
            {d.teams.members} ({members.length})
          </h2>
          <ul className="list">
            {members.map((m) => (
              <li key={m.id} className="member-row">
                <MemberAvatar name={m.display_name} mediaId={m.avatar_media_id} />
                <span className="grow">
                  <Link href={`/${lang}/players/${m.username}`}>{m.display_name}</Link>{" "}
                  <span className="small muted">@{m.username}</span>
                </span>
                <span className="small">
                  {m.id === team.owner_id ? (
                    <Badge status="works">{d.teams.owner}</Badge>
                  ) : m.id === team.captain_id ? (
                    <Badge status="connect">{d.teams.captain}</Badge>
                  ) : (
                    <span className="muted">{d.teams.player}</span>
                  )}
                </span>
                {isOwner && m.id !== team.owner_id ? (
                  <span className="row">
                    {m.id !== team.captain_id ? (
                      <ActionForm action="team.role" lang={lang} back={back} hidden={{ ...hidden, member: m.id, role: "captain" }}>
                        <button className="btn btn-ghost btn-xs">{d.teams.makeCaptain}</button>
                      </ActionForm>
                    ) : null}
                    <ActionForm action="team.role" lang={lang} back={back} hidden={{ ...hidden, member: m.id, role: "owner" }}>
                      <button className="btn btn-ghost btn-xs">{d.teams.makeOwner}</button>
                    </ActionForm>
                  </span>
                ) : null}
                {isLeader && m.id !== team.owner_id && m.id !== user?.id && (isOwner || m.id !== team.captain_id) ? (
                  <ActionForm action="team.remove" lang={lang} back={back} hidden={{ ...hidden, member: m.id }}>
                    <button className="btn btn-ghost btn-xs">{d.teams.remove}</button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
          {isMember && !isOwner ? (
            <ActionForm action="team.leave" lang={lang} back={back} hidden={hidden}>
              <button className="btn btn-ghost btn-sm">{d.teams.leave}</button>
            </ActionForm>
          ) : null}
        </section>
        <section>
          {isLeader ? (
            <>
              <h2 className="h3">{d.teams.invite}</h2>
              <ActionForm action="team.invite" lang={lang} back={back} hidden={hidden} className="inline-form">
                <input name="username" required pattern="@?[A-Za-z0-9_]{3,24}" placeholder={d.teams.inviteUsername} aria-label={d.teams.inviteUsername} autoCapitalize="none" />
                <button className="btn btn-primary btn-sm">{T("Пригласить / зарезервировать имя", "Invite / reserve username")}</button>
              </ActionForm>
              <p className="small muted">{T("Если игрок уже зарегистрирован, приглашение появится в его хабе. Свободное имя резервируется на 7 дней: отправьте ссылку будущему игроку. До 20 действующих резервов на приглашающего.", "Existing players receive an invitation in their hub. An available username is reserved for 7 days: share the link with the future player. Up to 20 active reservations per inviter.")}</p>
              {reservations.map(r => <div className="card stack-sm" id={`invitation-${r.username}`} key={r.id}>
                <h3 className="h4">@{r.username} — {T("ожидает регистрации", "awaiting registration")}</h3>
                <p className="small">{T("Резерв до", "Reserved until")} <LocalTime iso={r.expires_at} lang={lang} /></p>
                <ShareInvitation url={`${siteOrigin() ?? "https://www.maximus.vegas"}/${lang}/signup?reservation=${r.id}`} username={r.username} team={team.name} ru={ru} />
                <ActionForm action="team.reservation_revoke" lang={lang} back={back} hidden={{reservation:r.id}}><button className="btn btn-ghost btn-xs">{T("Отменить резерв", "Cancel reservation")}</button></ActionForm>
              </div>)}
              {invites.length ? (
                <>
                  <h3 className="h4">{d.teams.pendingInvites}</h3>
                  <ul className="list">
                    {invites.map((i) => (
                      <li key={i.id}>
                        <span><Link href={`/${lang}/players/${i.username}`}>@{i.username}</Link> — {T("приглашён на сайте", "invited on the site")}</span>
                        <ActionForm action="team.revoke" lang={lang} back={back} hidden={{ invite: i.id }}>
                          <button className="btn btn-ghost btn-xs">{d.teams.revoke}</button>
                        </ActionForm>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          ) : null}
          {isLeader ? (
            <details className="disclosure card">
              <summary>{T("Логотип и баннер", "Logo and banner")}</summary>
              <ActionForm action="team.media" lang={lang} back={back} hidden={hidden} className="stack-sm" multipart>
                <Field label={T("Логотип — размер настроится автоматически", "Logo — automatically resized")}>
                  <AutoImageInput name="logo" ru={ru} logo />
                </Field>
                <Field label={T("Баннер — размер настроится автоматически", "Banner — automatically resized")}>
                  <AutoImageInput name="banner" ru={ru} />
                </Field>
                <button className="btn btn-primary btn-sm">{T("Загрузить", "Upload")}</button>
              </ActionForm>
              <div className="row">
                {team.logo_media_id ? (
                  <ActionForm action="team.media" lang={lang} back={back} hidden={{ ...hidden, clear: "logo" }}>
                    <button className="btn btn-ghost btn-xs">{T("Убрать логотип", "Remove logo")}</button>
                  </ActionForm>
                ) : null}
                {team.banner_media_id ? (
                  <ActionForm action="team.media" lang={lang} back={back} hidden={{ ...hidden, clear: "banner" }}>
                    <button className="btn btn-ghost btn-xs">{T("Убрать баннер", "Remove banner")}</button>
                  </ActionForm>
                ) : null}
              </div>
            </details>
          ) : null}
          <h2 className="h3">{d.teams.tournaments}</h2>
          {tournaments.length ? (
            <ul className="list">
              {tournaments.map((t) => (
                <li key={t.slug}>
                  <Link href={`/${lang}/tournaments/${t.slug}`}>{t.name}</Link>
                  <span className="small">
                    {t.placement ? (
                      <strong>
                        {d.tournaments.place} {t.placement}
                      </strong>
                    ) : (
                      <Badge status={t.status}>{d.statuses.tournament[t.status]}</Badge>
                    )}{" "}
                    <span className="muted">
                      <LocalTime iso={t.starts_at} lang={lang} dateOnly />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{d.players.noTournaments}</p>
          )}
        </section>
      </div>
      <section className="section-tight" id="vacancies">
        <div className="row-between">
          <h2 className="h3">{fx.teamVacancies}</h2>
          <Link href={`/${lang}/finder?kind=vacancy&game=${team.game}`} className="text-link small">
            {fx.toFinder}
          </Link>
        </div>
        {vacancies.length ? (
          <div className="grid grid-2">
            {vacancies.map((p) => (
              <PostCard
                key={p.id}
                lang={lang}
                p={p}
                viewer={user}
                teams={isLeader ? [{ id: team.id, name: team.name, game: team.game }] : []}
                memberOf={isMember ? [team.id] : []}
                applied={applied.has(p.id)}
                moderator={Boolean(user?.roles.includes("admin"))}
                back={back}
              />
            ))}
          </div>
        ) : (
          <p className="small muted">{fx.noPosts}</p>
        )}
        {isLeader ? (
          <>
            {toDecide.length ? (
              <div className="stack-sm">
                <h3 className="h4">{fx.toDecide}</h3>
                <ul className="list">
                  {toDecide.map((a) => (
                    <li key={a.id}>
                      <span className="grow">
                        <Link href={`/${lang}/players/${a.username}`}>{a.display_name}</Link> <span className="small muted">@{a.username}</span>
                        {a.message ? <span className="small prewrap"> — {a.message}</span> : null}
                      </span>
                      <span className="row">
                        <ActionForm action="finder.decide" lang={lang} back={back} hidden={{ application: a.id, accept: "1" }}>
                          <button className="btn btn-primary btn-xs">{fx.accept}</button>
                        </ActionForm>
                        <ActionForm action="finder.decide" lang={lang} back={back} hidden={{ application: a.id, accept: "0" }}>
                          <button className="btn btn-ghost btn-xs">{fx.decline}</button>
                        </ActionForm>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <details className="disclosure card">
              <summary>{fx.openVacancy}</summary>
              <p className="small muted">{fx.vacancyNote}</p>
              <ActionForm action="finder.post" lang={lang} back={back} hidden={{ kind: "vacancy", team: team.id }} className="stack-sm">
                <div className="form-grid">
                  <Field label={fx.roles}>
                    <input name="roles" maxLength={80} required />
                  </Field>
                  <Field label={fx.slots}>
                    <select name="slots" defaultValue="1">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={fx.level}>
                    <input name="level" maxLength={60} />
                  </Field>
                  <Field label={fx.languages}>
                    <input name="languages" maxLength={60} />
                  </Field>
                  <Field label={fx.region}>
                    <input name="region" maxLength={40} />
                  </Field>
                  <Field label={fx.schedule}>
                    <input name="schedule" maxLength={80} />
                  </Field>
                </div>
                <Field label={fx.note}>
                  <textarea name="note" rows={3} maxLength={500} />
                </Field>
                <button className="btn btn-primary btn-sm">{fx.publish}</button>
              </ActionForm>
            </details>
          </>
        ) : null}
      </section>

      <TeamTransfers
        lang={lang}
        teamId={team.id}
        transfers={transferRows}
        history={history}
        viewerId={user?.id ?? null}
        leader={isLeader}
        leadsTeam={myLedTeams.map((t) => t.id)}
        back={`${back}#transfers`}
      />

      {!user ? (
        <p className="small muted">
          <Link href={`/${lang}/signin?next=${encodeURIComponent(back)}`} className="text-link">
            {d.nav.signIn}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
