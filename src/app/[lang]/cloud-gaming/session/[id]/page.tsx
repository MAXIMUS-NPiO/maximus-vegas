import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { viewer } from "@/server/viewer.ts";
import { peerSession, iceConfiguration } from "@/server/p2p.ts";
import { DbDown, PageHead } from "@/components/ui";
import { P2pRoom } from "@/components/p2p-room";
export const metadata = { title: "MAXIMUS · P2P session", robots: { index: false, follow: false } };
export default async function SessionPage({ params }: { params: Promise<{ lang: string; id: string }> }) {
  const { lang, id } = await params; if (!isLocale(lang)) notFound(); const T = (ru: string, en: string) => lang === "ru" ? ru : en;
  const { db, user } = await viewer(); if (!db) return <DbDown lang={lang} />; if (!user) redirect(`/${lang}/signin?next=/${lang}/cloud-gaming/session/${id}`);
  const s = await peerSession(db, user, id).catch(() => null); if (!s) notFound();
  return <div className="container page"><Link className="text-link" href={`/${lang}/cloud-gaming`}>← P2P</Link><PageHead title={s.name} lead={`${s.game} · ${s.role === "host" ? T("Вы — хост", "You are the host") : T("Вы — игрок", "You are the player")}`} /><P2pRoom initial={{ id: s.id, status: s.status, role: s.role, game: s.game, connected_seconds: s.connected_seconds, host_confirmed: s.host_confirmed, client_confirmed: s.client_confirmed }} configuration={iceConfiguration(user.id)} lang={lang} /></div>;
}
