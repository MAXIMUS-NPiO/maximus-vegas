import { randomUUID } from "node:crypto";
import { MemberAvatar } from "@/components/member-avatar";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { viewer } from "@/server/viewer.ts";
import { conversation } from "@/server/social.ts";
import { ActionForm, DbDown, Field, Flash, PageHead, one, type SearchParams } from "@/components/ui";
import { SocialCall } from "@/components/social-call";
import { socialCallsAvailable } from "@/server/social-calls.ts";
import { LocalTime } from "@/components/time";
export const metadata = { title: "MAXIMUS · Conversation", robots: { index: false, follow: false } };
export default async function Conversation({ params, searchParams }: { params: Promise<{ lang: string; id: string }>; searchParams: SearchParams }) {
  const { lang, id } = await params; if (!isLocale(lang) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const T = (ru: string, en: string) => lang === "ru" ? ru : en, sp = await searchParams, back = `/${lang}/dating/${id}`;
  const { db, user } = await viewer(); if (!db) return <DbDown lang={lang} />; if (!user) redirect(`/${lang}/signin?next=${back}`);
  const before = Number(one(sp.before));
  const data = await conversation(db, user, id, Number.isSafeInteger(before) && before > 0 ? before : 0).catch(() => null); if (!data) notFound();
  const other = data.match.user_a === user.id ? data.match.user_b : data.match.user_a;
  const [person] = await db.query<{ display_name: string; avatar_media_id: string | null }>("select display_name,avatar_media_id from users where id=$1", [other]);
  return <div className="container page narrow"><Link className="text-link" href={`/${lang}/community#conversations`}>← {T("Моё сообщество", "My community")}</Link><div className="section-tight"><MemberAvatar name={person.display_name} mediaId={person.avatar_media_id} size="lg" /></div><PageHead title={person.display_name} lead={data.match.status === "active" ? T("Общение по взаимному согласию", "Conversation by mutual consent") : T("Общение закрыто", "Conversation closed")} /><Flash lang={lang} params={sp} />
    {data.match.status === "active" && <SocialCall lang={lang} matchId={id} available={socialCallsAvailable()} />}
    <div className="row"><Link href={back} className="btn btn-ghost">{T("Обновить сообщения", "Refresh messages")}</Link>{data.messages.length === 50 && <Link className="btn btn-ghost" href={`${back}?before=${data.messages[0].id}`}>{T("Более ранние сообщения", "Earlier messages")}</Link>}</div>
    <ol className="list section-tight">{data.messages.map(m => <li className="stack" key={m.id}><strong>{m.sender_id === user.id ? T("Вы", "You") : person.display_name}</strong><p className="prewrap">{m.body}</p><small><LocalTime iso={m.created_at} lang={lang} /></small>{m.sender_id !== user.id && <details><summary>{T("Пожаловаться на сообщение", "Report message")}</summary><ActionForm action="social.report" lang={lang} back={back} hidden={{ user: other, message: String(m.id) }}><Field label={T("Причина жалобы", "Report reason")}><textarea name="reason" minLength={10} maxLength={1200} required /></Field><button className="btn btn-ghost">{T("Передать модератору и заблокировать", "Report to moderator and block")}</button></ActionForm></details>}</li>)}</ol>
    {data.match.status === "active" && <><ActionForm action="social.message" lang={lang} back={back} hidden={{ match: id, clientId: randomUUID() }}><Field label={T("Ваше сообщение", "Your message")}><textarea name="body" maxLength={1000} required /></Field><button className="btn btn-primary">{T("Отправить", "Send")}</button></ActionForm><div className="row section-tight"><ActionForm action="social.close" lang={lang} back={back} hidden={{ match: id }}><button className="btn btn-ghost">{T("Закрыть общение", "Close conversation")}</button></ActionForm><ActionForm action="social.block" lang={lang} back={back} hidden={{ user: other }}><button className="btn btn-ghost">{T("Заблокировать", "Block")}</button></ActionForm></div></>}
  </div>;
}
