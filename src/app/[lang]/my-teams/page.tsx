import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { siteOrigin } from "@/lib/site.ts";
import { viewer } from "@/server/viewer.ts";
import { myTeamDesk } from "@/server/my-teams.ts";
import { ActionForm, Badge, DbDown, Field, Flash, PageHead, one, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";
import { ShareInvitation } from "@/components/share-invitation";

export const metadata = { title: "MAXIMUS · My teams & invitations", robots: { index: false, follow: false } };
export default async function MyTeams({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params; if (!isLocale(lang)) notFound();
  const ru = lang === "ru", T = (a: string, b: string) => ru ? a : b, back = `/${lang}/my-teams`, sp = await searchParams;
  const { db, user } = await viewer(); if (!db) return <DbDown lang={lang} />;
  if (!user) redirect(`/${lang}/signin?next=${back}`);
  const search = one(sp.q).slice(0, 40);
  const data = await myTeamDesk(db, user, search), leaders = data.teams.filter(t => t.leader);
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
      <a className="btn btn-ghost btn-sm" href="#incoming">{T("Приглашения мне", "Invitations to me")} ({data.incoming.length})</a>
      <a className="btn btn-ghost btn-sm" href="#reserved">{T("Зарезервированные имена", "Reserved usernames")} ({data.reservations.filter(r => r.status === "pending").length})</a>
      <a className="btn btn-ghost btn-sm" href="#outgoing">{T("Приглашённые игроки", "Invited players")}</a>
    </nav>
    <section className="card stack section-tight" id="invite-player" style={{ scrollMarginTop: 150 }}>
      <h2>{T("1. Пригласить игрока или зарезервировать имя", "1. Invite a player or reserve a username")}</h2>
      {leaders.length ? <ActionForm action="team.invite" lang={lang} back={back} className="stack">
        <Field label={T("В какую команду", "Choose your team")}><select name="team" defaultValue={teamId} required>{leaders.map(t => <option value={t.id} key={t.id}>{t.name} · {gameBySlug(t.game)?.name}</option>)}</select></Field>
        <Field label={T("Имя игрока на MAXIMUS VEGAS", "Player username on MAXIMUS VEGAS")} hint={T("Введите существующий @username или придумайте свободное имя для нового игрока: 3–24 латинских символа, цифры или _. Email вводится на шаге отправки ниже.", "Enter an existing @username or choose an available name for a new player: 3–24 letters, digits or _. Enter the email in the delivery step below.")}>
          <input name="username" defaultValue={username} required pattern="@?[A-Za-z0-9_]{3,24}" maxLength={25} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="@player_name" />
        </Field>
        <button className="btn btn-primary">{T("Создать приглашение", "Create invitation")}</button>
        <p className="small muted">{T("Зарегистрированный игрок получит приглашение на сайте и сам подтвердит вступление. Новому игроку резервируем имя на 7 дней; вы получите ссылку для ручной отправки.", "Registered players receive an invitation on the site and choose whether to join. A new player's name is reserved for 7 days; you get a link to share yourself.")}</p>
      </ActionForm> : <div className="stack-sm"><p>{T("Приглашать в команду могут её владелец и капитан. Создайте свою команду или попросите капитана пригласить игрока.", "Only a team's owner and captain can invite players. Create your team or ask its captain to invite the player.")}</p><Link className="btn btn-primary" href={`/${lang}/teams/new`}>{dict(lang).teams.create}</Link></div>}
    </section>
    <form method="get" className="card stack-sm"><Field label={T("Найти приглашённого игрока или резерв имени", "Find an invited player or reserved username")}><input name="q" defaultValue={search} maxLength={40} placeholder="@username" /></Field><button className="btn btn-ghost" style={{ alignSelf: "flex-start" }}>{T("Найти", "Find")}</button>{search && <Link className="text-link" href={back}>{T("Сбросить поиск", "Clear search")}</Link>}<p className="small muted">{T("До 100 последних записей в каждом списке. Для старого приглашения используйте поиск по имени.", "Up to 100 recent records per list. Search by username to find older invitations.")}</p></form>
    <section className="section-tight" id="reserved" style={{ scrollMarginTop: 150 }}><h2>{T("2. Зарезервированные имена и отправка", "2. Reserved usernames & delivery")}</h2>
      <p>{T("Email, WhatsApp, Telegram, SMS, Discord или Steam: выберите способ внутри нужного приглашения. Сообщение отправляете вы.", "Choose email, WhatsApp, Telegram, SMS, Discord or Steam inside the invitation. You send the message yourself.")}</p>
      {!data.reservations.length && <p className="notice">{T("Резервов пока нет. Создайте приглашение выше — свободное имя появится здесь.", "No reservations yet. Create an invitation above; an available username appears here.")}</p>}
      <div className="stack">{data.reservations.map(r => <article className="card stack-sm" key={r.id} id={`invitation-${r.username}`} style={{ scrollMarginTop: 150 }}>
        <h3>@{r.username} <Badge status={r.status === "pending" ? "proposed" : r.status}>{r.status === "pending" ? T("Ожидает регистрации", "Awaiting registration") : statuses[r.status]}</Badge></h3>
        <p><Link className="text-link" href={`/${lang}/teams/${r.team_slug}`}>{r.team_name}</Link> · {T("Срок резерва", "Reserved until")}: <LocalTime iso={r.expires_at} lang={lang} /></p>
        {r.status === "pending" ? <><details className="disclosure" open={one(sp.ok) === "username_reserved" && username.toLowerCase() === r.username}><summary>{T("Отправить приглашение / ввести email", "Share invitation / enter email")}</summary><ShareInvitation url={`${siteOrigin() ?? "https://www.maximus.vegas"}/${lang}/signup?reservation=${r.id}`} username={r.username} team={r.team_name} ru={ru} /></details><ActionForm action="team.reservation_revoke" lang={lang} back={back} hidden={{ reservation: r.id }}><button className="btn btn-ghost btn-sm">{T("Отменить резерв", "Cancel reservation")}</button></ActionForm></> : null}
      </article>)}</div>
    </section>
    <section className="section-tight" id="outgoing" style={{ scrollMarginTop: 150 }}><h2>{T("Приглашённые игроки", "Invited players")}</h2>
      {!data.outgoing.length ? <p className="muted">{T("Приглашений зарегистрированным игрокам пока нет.", "No invitations to registered players yet.")}</p> : <ul className="list">{data.outgoing.map(i => <li key={i.id} className="row wrap"><span className="grow"><Link href={`/${lang}/players/${i.username}`}>@{i.username}</Link> · <Link href={`/${lang}/teams/${i.team_slug}`}>{i.team_name}</Link></span><Badge status={i.status}>{statuses[i.status]}</Badge>{i.status === "pending" && <ActionForm action="team.revoke" lang={lang} back={back} hidden={{ invite: i.id }}><button className="btn btn-ghost btn-xs">{T("Отозвать", "Revoke")}</button></ActionForm>}</li>)}</ul>}
    </section>
    <section className="section-tight" id="incoming" style={{ scrollMarginTop: 150 }}><h2>{T("Приглашения мне", "Invitations to me")}</h2>
      {!data.incoming.length ? <p className="muted">{T("Новых приглашений в команды нет.", "No new team invitations.")}</p> : <ul className="list">{data.incoming.map(i => <li key={i.id} className="row wrap"><span className="grow"><Link href={`/${lang}/teams/${i.team_slug}`}>{i.team_name}</Link> · @{i.invited_by}</span><ActionForm action="team.respond" lang={lang} back={back} hidden={{ invite: i.id, accept: "1" }}><button className="btn btn-primary btn-sm">{T("Вступить в команду", "Join team")}</button></ActionForm><ActionForm action="team.respond" lang={lang} back={back} hidden={{ invite: i.id, accept: "0" }}><button className="btn btn-ghost btn-sm">{T("Отклонить", "Decline")}</button></ActionForm></li>)}</ul>}
    </section>
    <section className="section-tight" id="my-rosters" style={{ scrollMarginTop: 150 }}><h2>{T("Мои команды", "My teams")}</h2><div className="grid grid-2">{data.teams.map(t => <article key={t.id} className="card stack-sm"><h3><Link href={`/${lang}/teams/${t.slug}`}>{t.name}</Link></h3><p>{gameBySlug(t.game)?.name} · {T("Игроков", "Players")}: {t.members}</p><div className="row wrap"><Link className="btn btn-ghost btn-sm" href={`/${lang}/teams/${t.slug}`}>{T("Открыть состав", "Open roster")}</Link>{t.leader && <Link className="btn btn-primary btn-sm" href={`${back}?team=${t.id}#invite-player`}>{T("Пригласить игрока", "Invite a player")}</Link>}</div></article>)}</div></section>
    <p className="notice section-tight">{T("Для приглашения в команду код не нужен. Игровой ID указывается в настройках профиля, а реферальный код относится к приглашению на платформу — это отдельные функции.", "You do not need a code to invite someone to your team. In-game IDs belong in profile settings; referral codes invite people to the platform. These are separate functions.")}</p>
  </div>;
}
