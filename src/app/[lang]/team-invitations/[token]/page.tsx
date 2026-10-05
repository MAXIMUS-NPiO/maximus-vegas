import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { viewer } from "@/server/viewer.ts";
import { teamInvitationByToken } from "@/server/team-invitation-delivery.ts";
import { mailConfigured } from "@/server/mail.ts";
import { ActionForm, DbDown, Flash, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export const metadata = { title: "MAXIMUS · Team invitation", robots: { index: false, follow: false } };
export default async function TeamInvitation({ params, searchParams }: { params: Promise<{ lang: string; token: string }>; searchParams: SearchParams }) {
  const { lang, token } = await params; if (!isLocale(lang)) notFound();
  const T = (a: string, b: string) => lang === "ru" ? a : b, back = `/${lang}/team-invitations/${token}`;
  const { db, user } = await viewer(); if (!db) return <DbDown lang={lang} />;
  const invitation = await teamInvitationByToken(db, token, user?.id);
  if (!invitation) return <div className="container narrow page"><h1>{T("Приглашение недоступно", "Invitation unavailable")}</h1><p>{T("Ссылка недействительна или приглашение удалено. Попросите капитана проверить статус и отправить новое.", "This link is invalid or the invitation has been removed. Ask the captain to check its status and send a new invitation.")}</p><Link className="btn btn-ghost" href={`/${lang}/my-teams`}>{T("Мои приглашения", "My invitations")}</Link></div>;
  return <div className="container narrow page"><h1>{T("Вас пригласили в команду", "You have a team invitation")}</h1><Flash lang={lang} params={await searchParams} /><section className="card stack">
    <h2><Link href={`/${lang}/teams/${invitation.teamSlug}`}>{invitation.teamName}</Link></h2>
    <p>{T("Приглашает", "Invited by")}: @{invitation.invitedBy}</p>
    {invitation.username && <p>{T("Имя игрока", "Player username")}: @{invitation.username}</p>}
    <p className="small muted">{T("Действует до", "Valid until")}: <LocalTime iso={invitation.expiresAt} lang={lang} /></p>
    {invitation.status !== "pending" ? <p className="notice">{({ accepted: T("Вы уже приняли это приглашение.", "This invitation has already been accepted."), declined: T("Приглашение отклонено.", "Invitation declined."), revoked: T("Капитан отозвал приглашение.", "The captain revoked this invitation."), expired: T("Срок приглашения истёк.", "The invitation has expired.") } as Record<string, string>)[invitation.status] ?? T("Приглашение закрыто.", "Invitation closed.")}</p> : !user ? <>
      <p>{T("Войдите или зарегистрируйтесь с email, на который пришло приглашение. Команда не добавит вас без вашего согласия.", "Sign in or register using the email that received this invitation. You choose whether to join the team.")}</p>
      <Link className="btn btn-primary" href={`/${lang}/signin?next=${encodeURIComponent(back)}`}>{T("Войти и ответить", "Sign in & respond")}</Link>
      <Link className="btn btn-ghost" href={`/${lang}/signup${invitation.reservationId ? `?reservation=${invitation.reservationId}` : ""}`}>{T("Создать аккаунт", "Create account")}</Link>
      <p className="small muted">{T("После подтверждения email приглашение также будет в «Мои команды и приглашения».", "After verifying your email, this invitation will also be in My teams & invitations.")}</p>
    </> : invitation.recipientMatches === false ? <p className="notice notice-warn">{T("Это приглашение адресовано другому аккаунту. Выйдите из текущего аккаунта и войдите с email получателя.", "This invitation is for a different account. Sign out, then sign in with the recipient's email.")}</p> : invitation.requiresEmailVerification && !user.emailVerified ? <>
      <p className="notice">{T("Сначала подтвердите email аккаунта, чтобы мы убедились, что приглашение принимает его получатель.", "Verify your account email first so only the intended recipient can accept.")}</p>
      {mailConfigured() ? <ActionForm action="auth.verify_request" lang={lang} back={back}><button className="btn btn-primary">{T("Отправить письмо для подтверждения email", "Send email verification")}</button></ActionForm> : <p className="notice notice-warn">{T("Почтовое подтверждение сейчас недоступно. Приглашение сохранено; его можно принять после подключения почты.", "Email verification is currently unavailable. The invitation is saved and can be accepted once email is connected.")}</p>}
    </> : <div className="row wrap"><ActionForm action="team.delivery_respond" lang={lang} back={back} hidden={{ invitation: token, accept: "1" }}><button className="btn btn-primary">{T("Принять и вступить в команду", "Accept & join the team")}</button></ActionForm><ActionForm action="team.delivery_respond" lang={lang} back={back} hidden={{ invitation: token, accept: "0" }}><button className="btn btn-ghost">{T("Отклонить", "Decline")}</button></ActionForm></div>}
  </section><p><Link className="text-link" href={`/${lang}/my-teams#incoming`}>{T("Все мои приглашения", "All my invitations")} →</Link></p></div>;
}
