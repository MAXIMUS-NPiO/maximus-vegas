import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { viewer } from "@/server/viewer.ts";
import { myTeamDesk } from "@/server/my-teams.ts";
import { ActionForm, Badge, DbDown, Field, Flash, PageHead, one, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";
import { InvitationStatusRefresh } from "@/components/invitation-status-refresh";
import { InvitationComposer } from "@/components/invitation-composer";
import { invitationDeliveryOverview, incomingDeliveries } from "@/server/team-invitation-delivery.ts";
import { mailConfigured } from "@/server/mail.ts";

export const metadata = { title: "MAXIMUS · My teams & invitations", robots: { index: false, follow: false } };
export default async function MyTeams({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params; if (!isLocale(lang)) notFound();
  const ru = lang === "ru", T = (a: string, b: string) => ru ? a : b, back = `/${lang}/my-teams`, sp = await searchParams;
  const { db, user } = await viewer(); if (!db) return <DbDown lang={lang} />;
  if (!user) redirect(`/${lang}/signin?next=${back}`);
  const search = one(sp.q).slice(0, 254);
  const data = await myTeamDesk(db, user, search), leaders = data.teams.filter(t => t.leader);
  const [deliveries, directIncoming] = await Promise.all([invitationDeliveryOverview(db, user, search), incomingDeliveries(db, user)]);
  const teamId = leaders.some(t => t.id === one(sp.team)) ? one(sp.team) : leaders[0]?.id;
  const username = one(sp.username).replace(/^@/, "").slice(0, 24);
  const statuses: Record<string, string> = { pending: T("Ожидает ответа", "Awaiting response"), accepted: T("Приглашение принято", "Invitation accepted"), declined: T("Отклонено", "Declined"), revoked: T("Отменено", "Cancelled"), claimed: T("Имя получено при регистрации", "Username claimed at sign-up"), expired: T("Срок резерва истёк", "Reservation expired") };
  return <div className="container page">
    <Link className="text-link" href={`/${lang}/hub`}>← {T("Мой кабинет", "My hub")}</Link>
    <PageHead title={T("Мои команды и приглашения", "My teams & invitations")} lead={T("Составы, приглашённые игроки и зарезервированные имена — в одном месте.", "Your rosters, invited players and reserved usernames in one place.")}>
      <Link className="btn btn-primary" href="#invite-player">{T("Пригласить игрока", "Invite a player")}</Link>
      <Link className="btn btn-ghost" href={`/${lang}/teams/new`}>{dict(lang).teams.create}</Link>
    </PageHead>
    <Flash lang={lang} params={sp} />
    <nav className="row wrap" aria-label={T("Разделы команд", "Team sections")}>
      <a className="btn btn-ghost btn-sm" href="#my-rosters">{T("Мои команды", "My teams")} ({data.teams.length})</a>
      <a className="btn btn-ghost btn-sm" href="#incoming">{T("Приглашения мне", "Invitations to me")} ({data.incoming.length + directIncoming.length})</a>
      <a className="btn btn-ghost btn-sm" href="#delivery-status">{T("Статус отправки", "Sending status")}</a>
      <a className="btn btn-ghost btn-sm" href="#reserved">{T("Зарезервированные имена", "Reserved usernames")} ({data.reservations.filter(r => r.status === "pending").length})</a>
      <a className="btn btn-ghost btn-sm" href="#outgoing">{T("Приглашённые игроки", "Invited players")}</a>
    </nav>
    <section className="card stack section-tight" id="invite-player" style={{ scrollMarginTop: 150 }}>
      <h2>{T("Пригласить игрока", "Invite a player")}</h2>
      <p className="muted">{T("Получатель и способ отправки — здесь, до создания приглашения.", "Choose the recipient and delivery method here, before creating the invitation.")}</p>
      <InvitationComposer key={`${teamId}-${username}-${one(sp.channel)}`} lang={lang} teams={leaders} initialTeam={teamId} initialUsername={username} initialChannel={one(sp.channel) === "email" ? "email" : undefined} emailConfigured={mailConfigured()} />
    </section>
    <form method="get" className="card stack-sm"><Field label={T("Найти приглашённого игрока или резерв имени", "Find an invited player or reserved username")}><input name="q" defaultValue={search} maxLength={254} placeholder="@username / email" /></Field><button className="btn btn-ghost" style={{ alignSelf: "flex-start" }}>{T("Найти", "Find")}</button>{search && <Link className="text-link" href={back}>{T("Сбросить поиск", "Clear search")}</Link>}<p className="small muted">{T("До 100 последних записей в каждом списке. Для старого приглашения используйте поиск по имени или email.", "Up to 100 recent records per list. Search by username or email to find older invitations.")}</p></form>
    <section className="section-tight" id="delivery-status" style={{ scrollMarginTop: 150 }}><div className="row-between wrap"><h2>{T("Приглашения и статус отправки", "Invitations & sending status")}</h2><InvitationStatusRefresh lang={lang} /></div>
      <p className="muted">{T("Почтовый сервис может принять письмо, но это ещё не подтверждает его получение человеком. Ответ игрока показываем отдельно.", "An email service accepting a message does not confirm the recipient received it. The player's response is shown separately.")}</p>
      {!deliveries.length && <p className="notice">{T("Новых приглашений пока нет. Старые резервы и приглашения сохранены ниже.", "No new invitations yet. Earlier reservations and invitations remain below.")}</p>}
      <div className="stack">{deliveries.map(i => <article className="card stack-sm invitation-preview" key={i.id} id={`delivery-${i.id}`} style={{ scrollMarginTop: 150 }}>
        <h3>{i.email ?? `@${i.username}`}</h3>
        <p><Link className="text-link" href={`/${lang}/teams/${i.teamSlug}`}>{i.teamName}</Link>{i.username && <> · @{i.username}</>}</p>
        <dl className="stack-sm"><div><dt className="small muted">{T("Отправка", "Sending")}</dt><dd>{({ site_notification: T("В кабинете игрока", "In the player's hub"), queued: T("В очереди · ещё не отправлено", "Queued · not sent yet"), service_accepted: T("Почтовый сервис принял письмо", "Email service accepted the message"), failed: T("Ошибка отправки", "Sending failed"), cancelled: T("Отправка отменена", "Sending cancelled") } as Record<string,string>)[i.deliveryStatus]}</dd></div><div><dt className="small muted">{T("Ответ игрока", "Player's response")}</dt><dd>{i.status === "expired" ? T("Срок приглашения истёк", "Invitation expired") : statuses[i.status] ?? i.status}</dd></div></dl>
        {i.deliveryStatus === "queued" && !mailConfigured() && <p className="notice notice-warn small">{T("Почтовая отправка не подключена: письмо остаётся в очереди.", "Email is not connected: this message remains queued.")}</p>}
        <p className="small muted">{T("Действует до", "Valid until")}: <LocalTime iso={i.expiresAt} lang={lang} /></p>
        <div className="row wrap">{i.canRetry && <ActionForm action="team.delivery_retry" lang={lang} back={back} hidden={{ invitation: i.id }}><button className="btn btn-ghost btn-sm">{T("Повторить отправку", "Retry sending")}</button></ActionForm>}{i.status === "pending" && <ActionForm action="team.delivery_revoke" lang={lang} back={back} hidden={{ invitation: i.id }}><button className="btn btn-ghost btn-sm">{T("Отозвать приглашение", "Revoke invitation")}</button></ActionForm>}</div>
      </article>)}</div>
    </section>
    <section className="section-tight" id="reserved" style={{ scrollMarginTop: 150 }}><h2>{T("Зарезервированные имена", "Reserved usernames")}</h2>
      <p>{T("Резерв имени сам по себе не отправляет приглашение. Если адрес ещё не указан, добавьте получателя в форме выше.", "A username reservation alone does not send an invitation. If no address was provided, add the recipient in the form above.")}</p>
      {!data.reservations.length && <p className="notice">{T("Зарезервированных имён пока нет.", "No reserved usernames yet.")}</p>}
      <div className="stack">{data.reservations.map(r => <article className="card stack-sm" key={r.id} id={`invitation-${r.username}`} style={{ scrollMarginTop: 150 }}>
        <h3>@{r.username} <Badge status={r.status === "pending" ? "proposed" : r.status}>{r.status === "pending" ? T("Имя зарезервировано", "Username reserved") : statuses[r.status]}</Badge></h3>
        <p><Link className="text-link" href={`/${lang}/teams/${r.team_slug}`}>{r.team_name}</Link> · {T("Срок резерва", "Reserved until")}: <LocalTime iso={r.expires_at} lang={lang} /></p>
        {r.status === "pending" && <div className="row wrap">{r.delivery_id ? <Link className="btn btn-primary btn-sm" href={`#delivery-${r.delivery_id}`}>{T("Открыть статус приглашения", "View invitation status")}</Link> : <Link className="btn btn-primary btn-sm" href={`${back}?team=${r.team_id}&username=${encodeURIComponent(r.username)}&channel=email#invite-player`}>{T("Указать получателя и отправить", "Choose recipient & send")}</Link>}<ActionForm action="team.reservation_revoke" lang={lang} back={back} hidden={{ reservation: r.id }}><button className="btn btn-ghost btn-sm">{T("Отменить резерв", "Cancel reservation")}</button></ActionForm></div>}
      </article>)}</div>
    </section>
    <section className="section-tight" id="outgoing" style={{ scrollMarginTop: 150 }}><h2>{T("Приглашённые игроки", "Invited players")}</h2>
      {!data.outgoing.length ? <p className="muted">{T("Приглашений зарегистрированным игрокам пока нет.", "No invitations to registered players yet.")}</p> : <ul className="list">{data.outgoing.map(i => <li key={i.id} className="row wrap"><span className="grow"><Link href={`/${lang}/players/${i.username}`}>@{i.username}</Link> · <Link href={`/${lang}/teams/${i.team_slug}`}>{i.team_name}</Link></span><Badge status={i.status}>{statuses[i.status]}</Badge>{i.status === "pending" && <ActionForm action="team.revoke" lang={lang} back={back} hidden={{ invite: i.id }}><button className="btn btn-ghost btn-xs">{T("Отозвать", "Revoke")}</button></ActionForm>}</li>)}</ul>}
    </section>
    <section className="section-tight" id="incoming" style={{ scrollMarginTop: 150 }}><h2>{T("Приглашения мне", "Invitations to me")}</h2>
      {directIncoming.length > 0 && <ul className="list">{directIncoming.map(i => <li key={i.id} className="row wrap"><span className="grow">{i.teamName}</span><Link className="btn btn-primary btn-sm" href={`/${lang}/team-invitations/${i.id}`}>{T("Открыть приглашение", "Open invitation")}</Link></li>)}</ul>}
      {!data.incoming.length && !directIncoming.length ? <p className="muted">{T("Новых приглашений в команды нет.", "No new team invitations.")}</p> : <ul className="list">{data.incoming.map(i => <li key={i.id} className="row wrap"><span className="grow"><Link href={`/${lang}/teams/${i.team_slug}`}>{i.team_name}</Link> · @{i.invited_by}</span><ActionForm action="team.respond" lang={lang} back={back} hidden={{ invite: i.id, accept: "1" }}><button className="btn btn-primary btn-sm">{T("Вступить в команду", "Join team")}</button></ActionForm><ActionForm action="team.respond" lang={lang} back={back} hidden={{ invite: i.id, accept: "0" }}><button className="btn btn-ghost btn-sm">{T("Отклонить", "Decline")}</button></ActionForm></li>)}</ul>}
    </section>
    <section className="section-tight" id="my-rosters" style={{ scrollMarginTop: 150 }}><h2>{T("Мои команды", "My teams")}</h2><div className="grid grid-2">{data.teams.map(t => <article key={t.id} className="card stack-sm"><h3><Link href={`/${lang}/teams/${t.slug}`}>{t.name}</Link></h3><p>{gameBySlug(t.game)?.name} · {T("Игроков", "Players")}: {t.members}</p><div className="row wrap"><Link className="btn btn-ghost btn-sm" href={`/${lang}/teams/${t.slug}`}>{T("Открыть состав", "Open roster")}</Link>{t.leader && <Link className="btn btn-primary btn-sm" href={`${back}?team=${t.id}#invite-player`}>{T("Пригласить игрока", "Invite a player")}</Link>}</div></article>)}</div></section>
    <p className="notice section-tight">{T("Для приглашения в команду код не нужен. Игровой ID указывается в настройках профиля, а реферальный код относится к приглашению на платформу — это отдельные функции.", "You do not need a code to invite someone to your team. In-game IDs belong in profile settings; referral codes invite people to the platform. These are separate functions.")}</p>
  </div>;
}
