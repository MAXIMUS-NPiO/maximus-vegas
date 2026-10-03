import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { viewer } from "@/server/viewer.ts";
import { broadcastId } from "@/server/broadcasts.ts";
import { BroadcastViewer } from "@/components/broadcast-viewer";
import { DbDown, PageHead } from "@/components/ui";
export const metadata = { robots: { index: false, follow: false } };

export default async function Watch({ params }: { params: Promise<{ lang: string; id: string }> }) {
  const { lang, id } = await params;
  if (!isLocale(lang)) notFound();
  try { broadcastId(id); } catch { notFound(); }
  const { db, user, dbError } = await viewer();
  if (dbError || !db) return <div className="container page"><DbDown lang={lang} /></div>;
  const [b] = await db.query<{ title: string; state: string; expires_at: Date }>(`select b.title,b.state,b.expires_at from native_broadcasts b
    join users u on u.id=b.owner_id where b.id=$1 and b.mode<>'record' and b.delete_requested_at is null and u.status='active'
    and not exists(select 1 from sanctions s where s.user_id=u.id and s.kind='suspension' and s.revoked_at is null
      and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now()))`, [id]);
  if (!b) notFound();
  const live = b.state === "live" && new Date(b.expires_at).getTime() > Date.now();
  return <div className="container page stack">
    <Link className="text-link small" href={`/${lang}/media`}>← {lang === "ru" ? "Медиатека" : "Media"}</Link>
    <PageHead title={b.title} lead={live ? (lang === "ru" ? "Прямой эфир MAXIMUS VEGAS" : "Live on MAXIMUS VEGAS") : (lang === "ru" ? "Эфир сейчас не идёт." : "This broadcast is not live.")} />
    {live && user ? <BroadcastViewer id={id} lang={lang} /> : live ? <Link className="btn btn-primary" href={`/${lang}/signin?next=/${lang}/watch/${id}`}>{lang === "ru" ? "Войти и смотреть" : "Sign in to watch"}</Link> : null}
  </div>;
}
