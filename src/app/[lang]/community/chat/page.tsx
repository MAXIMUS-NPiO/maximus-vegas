import { CommunityVoice } from "@/components/community-voice";
import { voiceAvailable } from "@/server/community-voice.ts";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { viewer } from "@/server/viewer.ts";
import { communityRoom, roomMessages, roomScope } from "@/server/community.ts";
import { CommunityChat } from "@/components/community-chat";
import { errorCode } from "@/server/http.ts";
import { DbDown, PageHead, one, type SearchParams } from "@/components/ui";
export const metadata = { title: "MAXIMUS · Community chat", robots: { index: false, follow: false } };
export default async function Chat({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params; if (!isLocale(lang)) notFound(); const T = (a: string, b: string) => lang === "ru" ? a : b;
  const sp = await searchParams, { db, user } = await viewer(); if (!db) return <DbDown lang={lang} />;
  const chatQuery = new URLSearchParams({ scope: one(sp.scope) || "global", ...(one(sp.id) ? { id: one(sp.id) } : {}) });
  if (!user) redirect(`/${lang}/signin?next=${encodeURIComponent(`/${lang}/community/chat?${chatQuery}`)}`);
  let room, name, messages;
  try { room = roomScope(one(sp.scope) || "global", one(sp.id)); name = await communityRoom(db, user, room); messages = await roomMessages(db, user, room); } catch (error) {
    const code = errorCode(error);
    if (["invalid_input", "not_found", "forbidden", "unauthorized", "account_restricted"].includes(code)) notFound();
    if (code === "db_unavailable") return <DbDown lang={lang} />;
    throw error;
  }
  return <div className="container page narrow"><Link className="text-link" href={`/${lang}/community`}>← {T("Моё сообщество", "My community")}</Link><PageHead title={room.scope === "global" ? T("Общий чат", "Global chat") : name.name} lead={room.scope === "global" ? T("Гостиная для участников MAXIMUS VEGAS. Обсуждаем игры, собираем компанию, знакомимся.", "The MAXIMUS VEGAS members' lounge. Talk about games, find a group and get to know people.") : T("Закрытая комната текущих участников команды или клана.", "A private room for current team or clan members.")} /><CommunityVoice key={`voice-${room.scope}-${room.id}`} lang={lang} scope={room} available={await voiceAvailable(db)} /><CommunityChat key={`chat-${room.scope}-${room.id}`} lang={lang} room={room} userId={user.id} initial={messages.map(m => ({ ...m, created_at: new Date(m.created_at).toISOString() }))} /></div>;
}
