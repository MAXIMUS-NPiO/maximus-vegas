import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale, type Locale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { circuitBySlug, type CircuitStanding } from "@/server/circuits.ts";
import { canManageOrg } from "@/server/access.ts";
import { Badge, DbDown, Empty, Flash, type SearchParams } from "@/components/ui";
import { formatLabel } from "@/components/tournament";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  const { db } = await viewer();
  const data = db ? await circuitBySlug(db, slug).catch(() => null) : null;
  const title = data ? `${data.circuit.name} · ${data.circuit.season}` : lang === "ru" ? "Серия" : "Circuit";
  return pageMeta(lang, `circuits/${slug}`, title, data ? `${gameBySlug(data.circuit.game)?.name ?? data.circuit.game} · ${data.circuit.org_name}` : undefined);
}

const place = (n: number, ru: boolean) => (ru ? `${n}-е` : n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);

function DivisionTable({ lang, rows, divisions, active }: { lang: Locale; rows: CircuitStanding[]; divisions: number; active: boolean }) {
  const ru = lang === "ru";
  if (!rows.length) return <p className="muted small">{ru ? "Пока нет результатов и участников." : "No results or members yet."}</p>;
  return (
    <div className="table-wrap">
      <table className="table table-compact">
        <thead>
          <tr>
            <th>#</th>
            <th>{ru ? "Участник" : "Entrant"}</th>
            <th className="num">{ru ? "Очки" : "Points"}</th>
            <th className="num">{ru ? "Турниров" : "Events"}</th>
            <th className="num">{ru ? "Побед" : "Wins"}</th>
            <th className="num">{ru ? "Лучшее место" : "Best"}</th>
            <th>{ru ? "Итог" : "Outcome"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.rank === 1 && r.events > 0 ? "is-first" : undefined}>
              <td>{r.rank}</td>
              <td>
                {r.link ? <Link href={r.teamId ? `/${lang}/teams/${r.link}` : `/${lang}/players/${r.link}`}>{r.name}</Link> : r.name}
                {divisions > 1 && !r.member ? <span className="small muted"> · {ru ? "не в составе дивизиона" : "not a division member"}</span> : null}
              </td>
              <td className="num">
                <strong>{r.points}</strong>
              </td>
              <td className="num">{r.events}</td>
              <td className="num">{r.titles}</td>
              <td className="num">{r.best ?? "—"}</td>
              <td>
                {r.qualified ? <Badge status="ok">{ru ? "Квалификация" : "Qualified"}</Badge> : null}{" "}
                {r.movement === "promoted" ? (
                  <Badge status="ok">{active ? (ru ? "Зона повышения" : "Promotion zone") : ru ? "Повышение" : "Promoted"}</Badge>
                ) : r.movement === "relegated" ? (
                  <Badge status="warn">{active ? (ru ? "Зона понижения" : "Relegation zone") : ru ? "Понижение" : "Relegated"}</Badge>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function CircuitPage({ params, searchParams }: { params: Promise<{ lang: string; slug: string }>; searchParams: SearchParams }) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const ru = lang === "ru";
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  const data = await circuitBySlug(db, slug);
  if (!data) notFound();
  const { circuit: c, events, finals, previous, next, standings } = data;
  const manager = user ? await canManageOrg(db, c.org_id, user) : false;
  const active = c.status === "active";
  const game = gameBySlug(c.game);
  return (
    <div className="container page">
      <header className="t-head">
        <div className="row">
          <Link href={`/${lang}/circuits`} className="eyebrow">
            {ru ? "Серии и сезоны" : "Circuits and seasons"}
          </Link>
          <Badge status={active ? "ok" : "muted"}>{active ? (ru ? "Сезон идёт" : "Season on") : ru ? "Сезон закрыт" : "Season closed"}</Badge>
        </div>
        <h1>
          {c.name} · {c.season}
        </h1>
        {c.description ? <p className="lead prewrap">{c.description}</p> : null}
        <dl className="t-facts">
          <div>
            <dt>{ru ? "Игра" : "Game"}</dt>
            <dd>
              <Link href={`/${lang}/games/${c.game}`}>{game?.name ?? c.game}</Link>
            </dd>
          </div>
          <div>
            <dt>{d.tournaments.organizer}</dt>
            <dd>{c.org_name}</dd>
          </div>
          <div>
            <dt>{d.tournaments.type}</dt>
            <dd>{c.participant_type === "team" ? d.tournaments.team : d.tournaments.solo}</dd>
          </div>
          <div>
            <dt>{ru ? "Турниры" : "Events"}</dt>
            <dd>
              {c.completed} / {c.events}
            </dd>
          </div>
          {c.qualify_top > 0 ? (
            <div>
              <dt>{ru ? "Квалификация" : "Qualification"}</dt>
              <dd>{ru ? `топ ${c.qualify_top}${c.divisions > 1 ? " первого дивизиона" : ""}` : `top ${c.qualify_top}${c.divisions > 1 ? " of division 1" : ""}`}</dd>
            </div>
          ) : null}
          {c.divisions > 1 ? (
            <div>
              <dt>{ru ? "Дивизионы" : "Divisions"}</dt>
              <dd>
                {c.divisions} · {ru ? `повышение ${c.promote}, понижение ${c.relegate}` : `promote ${c.promote}, relegate ${c.relegate}`}
              </dd>
            </div>
          ) : null}
          {!active && c.closed_at ? (
            <div>
              <dt>{ru ? "Сезон закрыт" : "Closed"}</dt>
              <dd>
                <LocalTime iso={c.closed_at} lang={lang} />
              </dd>
            </div>
          ) : null}
        </dl>
        <div className="row">
          {previous ? (
            <Link href={`/${lang}/circuits/${previous.slug}`} className="btn btn-ghost btn-sm">
              ← {previous.season}
            </Link>
          ) : null}
          {next ? (
            <Link href={`/${lang}/circuits/${next.slug}`} className="btn btn-ghost btn-sm">
              {next.season} →
            </Link>
          ) : null}
          {manager ? (
            <Link href={`/${lang}/organizer/c/${c.slug}`} className="btn btn-ghost btn-sm">
              {d.tournaments.manage}
            </Link>
          ) : null}
        </div>
      </header>
      <Flash lang={lang} params={sp} />

      <section className="section-tight">
        <h2 className="h3">{ru ? "Таблица" : "Standings"}</h2>
        <p className="small muted">
          {active
            ? ru
              ? "Считается по завершённым турнирам серии. Зоны повышения и понижения показывают, куда перейдут участники, если сезон закроется сейчас."
              : "Computed from the circuit's completed events. Promotion and relegation zones show where members would go if the season closed now."
            : ru
              ? "Зафиксирована при закрытии сезона и не пересчитывается."
              : "Frozen when the season closed; never recomputed."}
        </p>
        <div className="circuit-divisions">
          {[...standings.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([division, rows]) => (
              <div key={division} className="stack-sm">
                {c.divisions > 1 ? <h3 className="h4">{ru ? `Дивизион ${division}` : `Division ${division}`}</h3> : null}
                <DivisionTable lang={lang} rows={rows} divisions={c.divisions} active={active} />
              </div>
            ))}
        </div>
      </section>

      <section className="section-tight">
        <h2 className="h3">{ru ? "Очки за места" : "Points per place"}</h2>
        <ul className="kv-list">
          {c.points_table.map((p, i) => (
            <li key={i}>
              <span>{place(i + 1, ru)}</span>
              <strong>{p}</strong>
            </li>
          ))}
          <li>
            <span>{ru ? "Ниже таблицы (участие)" : "Below the table (participation)"}</span>
            <strong>{c.participation_points}</strong>
          </li>
        </ul>
        <p className="small muted">
          {ru
            ? `Очки турнира = очки места × вес турнира / 100 (0,5 округляется вверх). Разделённое место (например, два третьих места в сетке) получает очки своей строки. Без места — без очков. Порядок: очки → победы в турнирах → лучшее место → число турниров. Правила ${c.rules_version}.`
            : `Event points = place points × event weight / 100 (0.5 rounds up). A shared place (for example, two third places in a bracket) earns its own row. No place, no points. Order: points → event wins → best place → events played. Rules ${c.rules_version}.`}
        </p>
      </section>

      <section className="section-tight">
        <h2 className="h3">{ru ? "Турниры серии" : "Circuit events"}</h2>
        {events.length ? (
          <ul className="list">
            {events.map((t) => (
              <li key={t.id}>
                <span className="grow">
                  <Link href={`/${lang}/tournaments/${t.slug}`}>{t.name}</Link>
                  <span className="small muted">
                    {" "}
                    · {formatLabel(t.format, lang)}
                    {t.circuit_division ? ` · ${ru ? "дивизион" : "division"} ${t.circuit_division}` : ""}
                    {t.circuit_weight !== 100 ? ` · ×${(t.circuit_weight / 100).toLocaleString(ru ? "ru-RU" : "en-US")}` : ""} · <LocalTime iso={t.starts_at} lang={lang} />
                  </span>
                </span>
                <Badge status={t.status}>{d.statuses.tournament[t.status]}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={ru ? "Турниров пока нет" : "No events yet"} />
        )}
      </section>

      {finals.length ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Турниры для квалифицированных" : "Events for qualifiers"}</h2>
          <ul className="list">
            {finals.map((t) => (
              <li key={t.slug}>
                <span className="grow">
                  <Link href={`/${lang}/tournaments/${t.slug}`}>{t.name}</Link> <span className="small muted">· <LocalTime iso={t.starts_at} lang={lang} /></span>
                </span>
                <Badge status={t.status}>{d.statuses.tournament[t.status]}</Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
