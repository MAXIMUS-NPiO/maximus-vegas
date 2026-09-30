import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, type Locale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { listCircuits, type CircuitCard } from "@/server/circuits.ts";
import { Badge, DbDown, Empty, Flash, PageHead, type SearchParams } from "@/components/ui";

const TITLE = { ru: "Серии и сезоны", en: "Circuits and seasons" };
const LEAD = {
  ru: "Накопительные очки нескольких турниров, квалификация в финалы, дивизионы с повышением и понижением. Таблица закрытого сезона зафиксирована.",
  en: "Cumulative points across tournaments, qualification to finals, divisions with promotion and relegation. A closed season's table is frozen.",
};

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "circuits", TITLE[lang], LEAD[lang]);
}

function CircuitTile({ lang, c }: { lang: Locale; c: CircuitCard }) {
  const ru = lang === "ru";
  return (
    <Link href={`/${lang}/circuits/${c.slug}`} className="card card-link t-card">
      <div className="t-card-top">
        <span className="t-card-game">{gameBySlug(c.game)?.name ?? c.game}</span>
        <Badge status={c.status === "active" ? "ok" : "muted"}>{c.status === "active" ? (ru ? "Сезон идёт" : "Season on") : ru ? "Сезон закрыт" : "Season closed"}</Badge>
      </div>
      <h3>
        {c.name} · {c.season}
      </h3>
      <dl className="t-card-meta">
        <div>
          <dt>{ru ? "Турниры" : "Events"}</dt>
          <dd>
            {c.completed} / {c.events}
          </dd>
        </div>
        <div>
          <dt>{ru ? "Участие" : "Entry"}</dt>
          <dd>{c.participant_type === "team" ? (ru ? "Команды" : "Teams") : ru ? "Игроки" : "Players"}</dd>
        </div>
        <div>
          <dt>{ru ? "Дивизионы" : "Divisions"}</dt>
          <dd>{c.divisions}</dd>
        </div>
      </dl>
      <p className="t-card-org">{c.org_name}</p>
    </Link>
  );
}

export default async function Circuits({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const ru = lang === "ru";
  const sp = await searchParams;
  const { db, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  const list = await listCircuits(db).catch(() => []);
  const active = list.filter((c) => c.status === "active");
  const closed = list.filter((c) => c.status === "closed");
  return (
    <div className="container page">
      <PageHead title={TITLE[lang]} lead={LEAD[lang]}>
        <Link href={`/${lang}/organizer`} className="btn btn-ghost btn-sm">
          {ru ? "Создать серию" : "Create a circuit"}
        </Link>
      </PageHead>
      <Flash lang={lang} params={sp} />
      {list.length ? (
        <>
          <section className="section-tight">
            <h2 className="h3">{ru ? "Идут сейчас" : "Running now"}</h2>
            {active.length ? (
              <div className="grid grid-3">
                {active.map((c) => (
                  <CircuitTile key={c.id} lang={lang} c={c} />
                ))}
              </div>
            ) : (
              <p className="muted">{ru ? "Активных сезонов нет." : "No active seasons."}</p>
            )}
          </section>
          {closed.length ? (
            <section className="section-tight">
              <h2 className="h3">{ru ? "История сезонов" : "Season history"}</h2>
              <div className="grid grid-3">
                {closed.map((c) => (
                  <CircuitTile key={c.id} lang={lang} c={c} />
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : (
        <Empty title={ru ? "Серий пока нет" : "No circuits yet"}>
          <p className="muted">
            {ru
              ? "Организаторы создают серии в своём пространстве и привязывают к ним турниры. Здесь появятся только реальные серии."
              : "Organisers create circuits in their space and link tournaments to them. Only real circuits appear here."}
          </p>
        </Empty>
      )}
    </div>
  );
}
