import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { viewer } from "@/server/viewer.ts";
import { p2pOverview } from "@/server/p2p.ts";
import { DbDown, Flash, PageHead, type SearchParams } from "@/components/ui";
import { HostControl } from "@/components/p2p-host-control";
export const metadata = { title: "MAXIMUS · Host workspace", robots: { index: false, follow: false } };
export default async function HostPage({ params, searchParams }: { params: Promise<{ lang: string; id: string }>; searchParams: SearchParams }) {
  const { lang, id } = await params; if (!isLocale(lang)) notFound(); const T = (ru: string, en: string) => lang === "ru" ? ru : en;
  const { db, user } = await viewer(); if (!db) return <DbDown lang={lang} />; if (!user) redirect(`/${lang}/signin?next=/${lang}/cloud-gaming/host/${id}`);
  const data = await p2pOverview(db, user.id), host = data.mine.find(h => h.id === id); if (!host) notFound();
  return <div className="container page"><Link href={`/${lang}/cloud-gaming`} className="text-link">← P2P</Link><PageHead title={host.name} lead={`${host.cpu} · ${host.gpu} · ${host.ram_gb} GB · ${host.region}`} /><Flash lang={lang} params={await searchParams} /><p>{host.status === "approved" ? T("Хост прошёл проверку", "Host approved") : host.status === "pending" ? T("Ожидает проверки оборудования и прав на игры", "Awaiting hardware and game-rights review") : T("Хост приостановлен", "Host suspended")}</p>{host.review_note && <p className="notice">{host.review_note}</p>}<HostControl hostId={id} lang={lang} approved={host.status === "approved"} />
    <section className="section-tight"><h2>{T("Запросы и сеансы машины", "Host requests and sessions")}</h2><ul className="list">{data.sessions.filter(s => s.host_id === id).map(s => <li key={s.id}><Link href={`/${lang}/cloud-gaming/session/${s.id}`}>{s.game} · {s.status === "requested" ? T("Ответить на запрос", "Respond to request") : T("Открыть сеанс", "Open session")}</Link><span>{s.connected_seconds}s</span></li>)}</ul></section>
    <a className="text-link" href="https://github.com/MAXIMUS-NPiO/maximus-vegas/tree/main/host-agent" target="_blank" rel="noopener">{T("Хост-агент и инструкция установки", "Host agent and setup instructions")} ↗</a>
  </div>;
}
