import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { viewer } from "@/server/viewer.ts";
import { communityHosts, type CommunityHost } from "@/server/community-hosts.ts";
import { ActionForm, DbDown, Field, Flash, PageHead, type SearchParams } from "@/components/ui";
import { MemberAvatar } from "@/components/member-avatar";
import { LocalTime } from "@/components/time";
export const metadata = { title: "MAXIMUS · Community support", robots: { index: false, follow: false } };
export default async function Support({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params; if (!isLocale(lang)) notFound();
  const T = (ru: string, en: string) => lang === "ru" ? ru : en, back = `/${lang}/community/support`;
  const { db, user } = await viewer(); if (!db) return <DbDown lang={lang} />; if (!user) redirect(`/${lang}/signin?next=${back}`);
  const [people, own, sp] = await Promise.all([communityHosts(db), db.query<CommunityHost>("select * from community_hosts where user_id=$1", [user.id]), searchParams]);
  const application = own[0];
  return <div className="container page"><Link className="text-link" href={`/${lang}/community`}>← {T("Среди своих", "My community")}</Link>
    <PageHead title={T("Есть с кем поговорить", "Someone to talk to")} lead={T("Компания для игры, живое общение и отдельный путь к профессиональной поддержке.", "Company for a game, human conversation and a separate route to professional support.")} /><Flash lang={lang} params={sp} />
    <div className="grid grid-2"><section className="card"><h2 className="h3">{T("Ведущие сообщества", "Community hosts")}</h2><p>{T("Реальные люди с открыто обозначенной ролью ведущего. Помогают освоиться, собирают компанию и проводят встречи. Общение и симпатия — только по взаимному желанию.", "Real people with a clearly labelled host role. They welcome newcomers, bring players together and run meetups. Conversation and attraction are always mutual.")}</p></section>
    <section className="card"><h2 className="h3">{T("ПСИХОЛОГИНЯ · профессиональная поддержка", "Professional psychological support")}</h2><p>{T("Специалисты появляются здесь после проверки квалификации, права практиковать и срока действия документов. Обычный игровой чат не является психологической консультацией. Запись, условия, стоимость и конфиденциальность консультации указаны у выбранного специалиста.", "Practitioners appear after review of qualifications, permission to practise and document validity. A gaming chat is not a psychological consultation. Booking, terms, fees and consultation privacy are provided by the selected practitioner.")}</p><p className="small muted">{T("Не публикуйте медицинские документы и личную историю здоровья в общем чате.", "Keep medical records and personal health history out of shared chat.")}</p></section></div>
    {people.length ? <div className="grid grid-3 section-tight">{people.map(p => <article className="card stack-sm" key={p.user_id}><div className="row"><MemberAvatar name={p.display_name} mediaId={p.avatar_media_id} /><h2 className="h3">{p.display_name}</h2></div><span className="badge badge-info">{p.role === "host" ? T("Ведущий сообщества", "Community host") : T("Психолог · квалификация проверена", "Psychologist · credentials reviewed")}</span><p className="prewrap">{p.bio}</p><p className="small">{p.languages} · {p.jurisdiction} · {p.organisation}</p>
      {p.role === "psychologist" && <p className="small"><a className="text-link" href={p.credential_url} target="_blank" rel="noopener noreferrer">{p.credential}</a> · {T("Проверка действует до", "Review valid until")} <LocalTime iso={p.verified_until!} lang={lang} dateOnly /></p>}
      <Link className="btn btn-ghost" href={`/${lang}/community?username=${p.username}#friends`}>{T("Предложить дружбу", "Send friend request")}</Link>
      {p.booking_url && <a className="btn btn-primary" href={p.booking_url} target="_blank" rel="noopener noreferrer">{T("Условия и запись у специалиста ↗", "Provider terms & booking ↗")}</a>}</article>)}</div> : <p className="notice section-tight">{T("Проверенных ведущих и специалистов пока нет. Их карточки появятся после проверки. Пока можно присоединиться к общему чату или найти товарищей для игры.", "No reviewed hosts or practitioners are listed yet. Their profiles will appear after review. You can join shared chat or find teammates meanwhile.")}</p>}
    <p className="row"><Link className="btn btn-primary" href={`/${lang}/community/chat?scope=global`}>{T("В общий чат", "Join shared chat")}</Link><Link className="btn btn-ghost" href={`/${lang}/finder`}>{T("Найти компанию для игры", "Find teammates")}</Link></p>
    <details className="card disclosure section-tight"><summary>{T("Стать ведущим или предложить профессиональную поддержку", "Apply as a host or practitioner")}</summary>
      {application && <p className="notice">{T("Статус заявки", "Application status")}: {({ pending: T("На проверке", "In review"), verified: T("Проверена", "Reviewed"), rejected: T("Отклонена", "Rejected"), suspended: T("Приостановлена", "Suspended") })[application.status]}{application.review_note && ` · ${application.review_note}`}</p>}
      {application?.status !== "suspended" && <ActionForm action="community.host_apply" lang={lang} back={back} className="stack">
        <Field label={T("Роль", "Role")}><select name="role" defaultValue={application?.role ?? "host"}><option value="host">{T("Ведущий сообщества", "Community host")}</option><option value="psychologist">{T("Психолог", "Psychologist")}</option></select></Field>
        <Field label={T("О себе и формате работы", "About you and your work")}><textarea name="bio" required minLength={30} maxLength={600} defaultValue={application?.bio} /></Field>
        <div className="grid grid-2"><Field label={T("Языки общения", "Languages")}><input name="languages" required maxLength={100} defaultValue={application?.languages} /></Field><Field label={T("Страна и регион работы", "Practice location")}><input name="jurisdiction" required maxLength={100} defaultValue={application?.jurisdiction} /></Field></div>
        <Field label={T("Организация или профессиональная практика", "Organisation or professional practice")}><input name="organisation" required maxLength={150} defaultValue={application?.organisation} /></Field>
        <Field label={T("Квалификация и номер лицензии — для психолога", "Qualification and licence number — for a psychologist")}><input name="credential" maxLength={150} defaultValue={application?.credential} /></Field>
        <Field label={T("Официальная страница проверки квалификации", "Official credential verification page")}><input name="credentialUrl" type="url" placeholder="https://" maxLength={500} defaultValue={application?.credential_url} /></Field>
        <Field label={T("Страница условий и записи — для психолога", "Provider terms and booking page — for a psychologist")}><input name="bookingUrl" type="url" placeholder="https://" maxLength={500} defaultValue={application?.booking_url} /></Field>
        <label className="check"><input name="consent" type="checkbox" value="1" required />{T("Разрешаю опубликовать эту карточку после проверки. Подтверждаю достоверность данных и открытое обозначение моей роли. Изменения отправляют карточку на повторную проверку.", "I consent to publication after review, confirm these details are accurate and agree to openly identify my role. Editing sends the profile for a new review.")}</label>
        <button className="btn btn-primary">{T("Отправить на проверку", "Submit for review")}</button>
      </ActionForm>}
    </details>
  </div>;
}
