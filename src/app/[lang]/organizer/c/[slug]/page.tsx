import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { canManageOrg } from "@/server/access.ts";
import { circuitBySlug } from "@/server/circuits.ts";
import { ActionForm, Badge, Check, DbDown, Field, Flash, type SearchParams } from "@/components/ui";
import { CircuitForm } from "@/components/circuit-form";
import { formatLabel } from "@/components/tournament";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, `organizer/c/${slug}`, lang === "ru" ? "Управление серией" : "Manage circuit", undefined, { noindex: true });
}

export default async function ManageCircuit({ params, searchParams }: { params: Promise<{ lang: string; slug: string }>; searchParams: SearchParams }) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const o = d.organizer;
  const ru = lang === "ru";
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user) redirect(`/${lang}/signin?next=/${lang}/organizer/c/${slug}`);
  const data = await circuitBySlug(db, slug);
  if (!data) notFound();
  const c = data.circuit;
  if (!(await canManageOrg(db, c.org_id, user)))
    return (
      <div className="container page">
        <h1>
          {c.name} · {c.season}
        </h1>
        <p className="notice notice-warn">{o.notAllowed}</p>
      </div>
    );
  const active = c.status === "active";
  const back = `/${lang}/organizer/c/${c.slug}`;
  const hidden = { circuit: c.id };
  // Drafts included: every event that is not finished blocks the season close.
  const events = await db.query<{ id: string; slug: string; name: string; status: string; format: string; circuit_division: number | null; circuit_weight: number }>(
    "select id, slug, name, status, format, circuit_division, circuit_weight from tournaments where circuit_id = $1 order by starts_at asc",
    [c.id],
  );
  const open = events.filter((t) => !["COMPLETED", "CANCELLED", "ARCHIVED"].includes(t.status));
  const members = await db.query<{ division: number; source: string; name: string; handle: string }>(
    `select m.division, m.source, coalesce(tm.name, u.display_name) as name, coalesce(tm.slug, u.username) as handle
       from circuit_members m left join users u on u.id = m.user_id left join teams tm on tm.id = m.team_id
      where m.circuit_id = $1 order by m.division, name`,
    [c.id],
  );
  const sourceLabel = (s: string) =>
    ({ assigned: ru ? "назначен" : "assigned", promoted: ru ? "повышен" : "promoted", relegated: ru ? "понижен" : "relegated", stayed: ru ? "остался" : "stayed" })[s] ?? s;
  return (
    <div className="container page">
      <p className="eyebrow">
        <Link href={`/${lang}/organizer/${c.org_slug}`}>{c.org_name}</Link> · {ru ? "Управление серией" : "Manage circuit"} · {gameBySlug(c.game)?.name ?? c.game}
      </p>
      <div className="row-between">
        <h1>
          {c.name} · {c.season}
        </h1>
        <Badge status={active ? "ok" : "muted"}>{active ? (ru ? "Сезон идёт" : "Season on") : ru ? "Сезон закрыт" : "Season closed"}</Badge>
      </div>
      <p className="row">
        <Link href={`/${lang}/circuits/${c.slug}`} className="text-link">
          {ru ? "Публичная страница и таблица" : "Public page and standings"}
        </Link>
        {data.previous ? (
          <Link href={`/${lang}/organizer/c/${data.previous.slug}`} className="text-link">
            {ru ? "Предыдущий сезон" : "Previous season"}: {data.previous.season}
          </Link>
        ) : null}
        {data.next ? (
          <Link href={`/${lang}/organizer/c/${data.next.slug}`} className="text-link">
            {ru ? "Следующий сезон" : "Next season"}: {data.next.season}
          </Link>
        ) : null}
      </p>
      <Flash lang={lang} params={sp} />

      <section className="section-tight">
        <h2 className="h3">{ru ? "Турниры серии" : "Circuit events"}</h2>
        <p className="small muted">
          {ru
            ? "Турнир привязывается к серии в его настройках (раздел «Серия и отбор») до первой регистрации."
            : "A tournament is linked in its settings (the “Circuit and qualification” section) before the first registration."}
        </p>
        {events.length ? (
          <ul className="list">
            {events.map((t) => (
              <li key={t.id}>
                <span className="grow">
                  <Link href={`/${lang}/organizer/t/${t.slug}`}>{t.name}</Link>
                  <span className="small muted">
                    {" "}
                    · {formatLabel(t.format, lang)}
                    {t.circuit_division ? ` · ${ru ? "дивизион" : "division"} ${t.circuit_division}` : ""} · ×{(t.circuit_weight / 100).toLocaleString(ru ? "ru-RU" : "en-US")}
                  </span>
                </span>
                <Badge status={t.status}>{d.statuses.tournament[t.status]}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">{ru ? "Пока нет привязанных турниров." : "No linked events yet."}</p>
        )}
      </section>

      {c.divisions > 1 ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Составы дивизионов" : "Division members"}</h2>
          <p className="small muted">
            {ru
              ? `Турнир дивизиона принимает только его участников. ${c.participant_type === "team" ? "Команда указывается по адресу страницы (slug)." : "Игрок указывается по имени пользователя."}`
              : `A division's events admit only its members. ${c.participant_type === "team" ? "A team is identified by its page address (slug)." : "A player is identified by username."}`}
          </p>
          {members.length ? (
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{ru ? "Дивизион" : "Division"}</th>
                    <th>{ru ? "Участник" : "Member"}</th>
                    <th>{ru ? "Откуда" : "Source"}</th>
                    {active ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={`${m.division}-${m.handle}`}>
                      <td>{m.division}</td>
                      <td>
                        {m.name} <span className="small muted">{c.participant_type === "team" ? m.handle : `@${m.handle}`}</span>
                      </td>
                      <td className="small">{sourceLabel(m.source)}</td>
                      {active ? (
                        <td>
                          <ActionForm action="circuit.member_remove" lang={lang} back={back} hidden={{ ...hidden, handle: m.handle }}>
                            <button className="btn btn-ghost btn-xs">{o.remove}</button>
                          </ActionForm>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted small">{ru ? "Составы пока пусты." : "No members yet."}</p>
          )}
          {active ? (
            <ActionForm action="circuit.member" lang={lang} back={back} hidden={hidden} className="inline-form">
              <input
                name="handle"
                required
                maxLength={60}
                placeholder={c.participant_type === "team" ? (ru ? "slug команды" : "team slug") : ru ? "имя пользователя" : "username"}
                aria-label={ru ? "Участник" : "Member"}
                autoCapitalize="none"
              />
              <select name="division" aria-label={ru ? "Дивизион" : "Division"} defaultValue="1">
                {Array.from({ length: c.divisions }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {ru ? `Дивизион ${n}` : `Division ${n}`}
                  </option>
                ))}
              </select>
              <button className="btn btn-ghost btn-sm">{ru ? "Добавить или перевести" : "Add or move"}</button>
            </ActionForm>
          ) : null}
        </section>
      ) : null}

      {active ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Параметры серии" : "Circuit settings"}</h2>
          <CircuitForm lang={lang} back={back} c={c} locked={{ table: c.completed > 0, divisions: events.length > 0 || members.length > 0 }} />
        </section>
      ) : null}

      {active ? (
        <section className="section-tight">
          <details className="disclosure">
            <summary className="h3">{ru ? "Закрыть сезон" : "Close the season"}</summary>
            <p className="small muted">
              {ru
                ? "Таблица фиксируется навсегда, квалифицированные и перешедшие между дивизионами получают уведомления. Можно сразу открыть следующий сезон: составы перенесутся с учётом повышений и понижений."
                : "The table is frozen for good; qualified entrants and those moving between divisions are notified. You can open the next season at once: members carry over with promotions and relegations applied."}
            </p>
            {open.length ? (
              <p className="notice notice-warn">
                {ru ? "Сначала завершите или отмените: " : "Complete or cancel first: "}
                {open.map((t) => t.name).join(", ")}
              </p>
            ) : (
              <ActionForm action="circuit.close" lang={lang} back={back} hidden={hidden} className="stack-sm">
                <div className="form-grid">
                  <Field label={ru ? "Название следующего сезона" : "Next season name"} hint={ru ? "Нужно, если открываете следующий сезон; должно отличаться от текущего" : "Needed to open the next season; must differ from this one"}>
                    <input name="nextSeason" maxLength={40} defaultValue={/^\d{4}$/.test(c.season) ? String(Number(c.season) + 1) : ""} />
                  </Field>
                </div>
                <Check name="createNext" label={ru ? "Открыть следующий сезон" : "Open the next season"} defaultChecked />
                <button className="btn btn-danger btn-sm">{ru ? "Закрыть сезон и зафиксировать таблицу" : "Close the season and freeze the table"}</button>
              </ActionForm>
            )}
          </details>
        </section>
      ) : null}
    </div>
  );
}
