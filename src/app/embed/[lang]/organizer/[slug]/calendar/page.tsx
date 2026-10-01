import { notFound } from "next/navigation";
import { connection } from "next/server";
import { dict, isLocale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { getDb } from "@/server/db.ts";
import { EmbedFoot, EmbedHead } from "@/components/embed";
import { Badge } from "@/components/ui";
import { LocalTime } from "@/components/time";

/** Embeddable calendar of an organising space: published, open and running tournaments by start time. */
export default async function CalendarWidget({ params }: { params: Promise<{ lang: string; slug: string }> }) {
  await connection();
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  const ru = lang === "ru";
  const d = dict(lang);
  const db = await getDb().catch(() => null);
  if (!db) return <p className="muted">{d.common.dbDownTitle}</p>;
  const [org] = await db.query<{ id: string; slug: string; name: string }>("select id, slug, name from organizations where slug = $1", [slug]);
  if (!org) notFound();
  const events = await db.query<{
    slug: string;
    name: string;
    game: string;
    status: string;
    starts_at: Date | null;
    registered: number;
    max_participants: number;
  }>(
    `select t.slug, t.name, t.game, t.status, t.starts_at, t.max_participants,
            (select count(*)::int from registrations r where r.tournament_id = t.id and r.status = 'registered') as registered
       from tournaments t
      where t.org_id = $1 and t.status in ('PUBLISHED','REGISTRATION_OPEN','REGISTRATION_CLOSED','IN_PROGRESS','PAUSED')
      order by t.starts_at asc nulls last limit 30`,
    [org.id],
  );
  const href = `/${lang}/tournaments`;
  return (
    <div className="stack">
      <EmbedHead lang={lang} title={org.name} subtitle={ru ? "Календарь турниров" : "Tournament calendar"} href={href} />
      {events.length ? (
        <ul className="list">
          {events.map((t) => (
            <li key={t.slug}>
              <span className="grow">
                <a href={`/${lang}/tournaments/${t.slug}`} target="_blank" rel="noopener">
                  {t.name}
                </a>
                <span className="small muted">
                  {" "}
                  · {gameBySlug(t.game)?.name ?? t.game} · {t.registered}/{t.max_participants}
                </span>
              </span>
              <span className="row small">
                {t.starts_at ? <LocalTime iso={t.starts_at} lang={lang} /> : null}
                <Badge status={t.status}>{d.statuses.tournament[t.status] ?? t.status}</Badge>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">{ru ? "Ближайших турниров нет." : "No upcoming tournaments."}</p>
      )}
      <EmbedFoot href={href} />
    </div>
  );
}
