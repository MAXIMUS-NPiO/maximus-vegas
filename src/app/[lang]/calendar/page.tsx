import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { hub } from "@/server/queries.ts";
import { upcomingSessions } from "@/server/academy.ts";
import { Badge, DbDown, Empty } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "calendar", dict(lang).hub.calendar, undefined, { noindex: true });
}

export default async function Calendar({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user) redirect(`/${lang}/signin?next=/${lang}/calendar`);
  const [data, sessions] = await Promise.all([hub(db, user), upcomingSessions(db, user.id)]);
  const ru = lang === "ru";
  const items = [
    ...data.matches
      .filter((m) => m.scheduled_at)
      .map((m) => ({ at: new Date(m.scheduled_at!), key: m.id, href: `/${lang}/matches/${m.id}`, title: `${m.a_name ?? d.common.tbd} ${d.common.vs} ${m.b_name ?? d.common.tbd}`, sub: m.t_name, status: m.status, label: d.statuses.match[m.status] })),
    ...data.registrations
      .filter((r) => !["COMPLETED", "CANCELLED"].includes(r.status))
      .map((r) => ({ at: new Date(r.starts_at), key: r.slug, href: `/${lang}/tournaments/${r.slug}`, title: r.name, sub: d.tournaments.starts, status: r.status, label: d.statuses.tournament[r.status] })),
    // Training sessions as coach or player (MV-ACADEMY-1).
    ...sessions.map((s) => ({
      at: new Date(s.starts_at),
      key: s.id,
      href: `/${lang}/training/${s.request_id}`,
      title: s.coach_id === user.id ? `${ru ? "Занятие с" : "Session with"} @${s.student_username}` : `${ru ? "Занятие с тренером" : "Session with coach"} @${s.coach_username}`,
      sub: `${s.minutes} ${ru ? "мин" : "min"}`,
      status: "scheduled",
      label: ru ? "Занятие" : "Session",
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  return (
    <div className="container narrow page">
      <h1>{d.hub.calendar}</h1>
      <p className="small muted">{d.common.timeNote}</p>
      {items.length ? (
        <ul className="list">
          {items.map((i) => (
            <li key={i.key}>
              <span className="mono small">
                <LocalTime iso={i.at} lang={lang} />
              </span>
              <span className="grow">
                <Link href={i.href}>{i.title}</Link> <span className="small muted">· {i.sub}</span>
              </span>
              <Badge status={i.status}>{i.label}</Badge>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title={d.hub.noRegistrations} />
      )}
    </div>
  );
}
