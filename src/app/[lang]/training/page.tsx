import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { gameBySlug } from "@/lib/games.ts";
import { academyText } from "@/lib/academy-text.ts";
import { viewer } from "@/server/viewer.ts";
import { studentRequests, upcomingSessions } from "@/server/academy.ts";
import { Badge, DbDown, Empty, Flash, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "training", academyText[lang].myTraining, undefined, { noindex: true });
}

/** The player's side of the academy (MV-ACADEMY-1): requests to coaches and the next sessions. */
export default async function Training({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const x = academyText[lang];
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user) redirect(`/${lang}/signin?next=/${lang}/training`);
  const [requests, sessions] = await Promise.all([studentRequests(db, user.id), upcomingSessions(db, user.id)]);
  const mine = sessions.filter((s) => s.coach_id !== user.id);
  return (
    <div className="container narrow page">
      <h1>{x.myTraining}</h1>
      <p className="lead">{x.myTrainingLead}</p>
      <Flash lang={lang} params={sp} />
      <p className="row">
        <Link href={`/${lang}/coaches`} className="btn btn-ghost btn-sm">
          {x.findCoach}
        </Link>
        <Link href={`/${lang}/academy`} className="btn btn-ghost btn-sm">
          {x.programmes}
        </Link>
      </p>
      <section className="section-tight stack-sm">
        <h2 className="h3">{x.upcoming}</h2>
        {mine.length ? (
          <ul className="list small">
            {mine.map((s) => (
              <li key={s.id}>
                <span className="mono">
                  <LocalTime iso={s.starts_at} lang={lang} />
                </span>
                <span className="grow">
                  {x.coach} @{s.coach_username} · {s.minutes} min
                </span>
                <Link href={`/${lang}/training/${s.request_id}`} className="text-link">
                  {x.open}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">{x.noUpcoming}</p>
        )}
      </section>
      <section className="section-tight stack-sm">
        <h2 className="h3">{x.requestTitle}</h2>
        {requests.length ? (
          <ul className="list">
            {requests.map((r) => (
              <li key={r.id}>
                <span className="grow">
                  <Link href={`/${lang}/training/${r.id}`}>
                    {r.coach_name} @{r.coach_username}
                  </Link>
                  <span className="small muted">
                    {" "}
                    · {gameBySlug(r.game)?.name ?? r.game}
                    {r.programme_title ? ` · ${r.programme_title}` : ""} · <LocalTime iso={r.created_at} lang={lang} dateOnly />
                  </span>
                </span>
                <Badge status={r.status}>{x.requestStatuses[r.status]}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={x.noRequests} />
        )}
      </section>
    </div>
  );
}
