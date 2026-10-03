import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { broadcastAvailability } from "@/server/broadcast-config.ts";
import { myBroadcasts } from "@/server/broadcasts.ts";
import { BroadcastStudio } from "@/components/broadcast-studio";
import { PageHead, DbDown } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  return isLocale(lang) ? pageMeta(lang, "studio", lang === "ru" ? "Студия эфиров и POV" : "Live & POV studio", undefined, { noindex: true }) : {};
}
export default async function Studio({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const ru = lang === "ru";
  const { db, user, dbError } = await viewer();
  return <div className="container page">
    <Link className="text-link small" href={`/${lang}/media`}>← {ru ? "Медиатека" : "Media"}</Link>
    <PageHead title={ru ? "Студия эфиров и POV" : "Live & POV studio"} lead={ru ? "Ваш игровой экран. В прямом эфире или в личном архиве." : "Your gameplay. Live or in your private archive."} />
    {dbError || !db ? <DbDown lang={lang} /> : !user ? <section className="card stack">
      <h2>{ru ? "Эфир начинается в вашем кабинете" : "Your broadcast starts in your account"}</h2>
      <p>{ru ? "Выберите длительность, режим записи и срок хранения. После входа можно проверить захват экрана и доступность услуги." : "Choose a duration, recording mode and retention period. Sign in to test screen capture and check service availability."}</p>
      <Link className="btn btn-primary" href={`/${lang}/signin?next=/${lang}/studio`}>{ru ? "Войти в студию" : "Sign in to the studio"}</Link>
    </section> : <BroadcastStudio lang={lang} initial={{ ...await broadcastAvailability(db), broadcasts: JSON.parse(JSON.stringify(await myBroadcasts(db, user.id))) }} />}
  </div>;
}
