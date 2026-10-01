import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { orgBySlug } from "@/server/queries.ts";
import { canManageOrg, orgRole } from "@/server/access.ts";
import { listCircuits } from "@/server/circuits.ts";
import { listTemplates } from "@/server/templates.ts";
import { ActionForm, Badge, DbDown, Empty, Flash, type SearchParams } from "@/components/ui";
import { TournamentForm } from "@/components/tournament-form";
import { CircuitForm } from "@/components/circuit-form";
import { LocalDateTimeInput, LocalTime, TimeZoneField } from "@/components/time";
import { formatLabel } from "@/components/tournament";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, `organizer/${slug}`, dict(lang).organizer.title, undefined, { noindex: true });
}

export default async function OrgPage({ params, searchParams }: { params: Promise<{ lang: string; slug: string }>; searchParams: SearchParams }) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const o = d.organizer;
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user) redirect(`/${lang}/signin?next=/${lang}/organizer/${slug}`);
  const data = await orgBySlug(db, slug);
  if (!data) notFound();
  const role = await orgRole(db, data.org.id, user.id);
  const manager = await canManageOrg(db, data.org.id, user);
  if (!role && !user.roles.includes("admin")) notFound();
  const owner = role === "owner" || user.roles.includes("admin");
  const back = `/${lang}/organizer/${slug}`;
  const ru = lang === "ru";
  const circuits = await listCircuits(db, { orgId: data.org.id });
  const templates = await listTemplates(db, data.org.id);
  const categories = [...new Set(templates.map((x) => x.category))];
  return (
    <div className="container page">
      <p className="eyebrow">
        <Link href={`/${lang}/organizer`}>{o.title}</Link>
      </p>
      <h1>{data.org.name}</h1>
      {data.org.description ? <p className="lead prewrap">{data.org.description}</p> : null}
      <Flash lang={lang} params={sp} />

      <section className="section-tight">
        <h2 className="h3">{o.tournaments}</h2>
        {data.tournaments.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{o.tName}</th>
                  <th>{o.game}</th>
                  <th>{o.status}</th>
                  <th>{d.tournaments.starts}</th>
                  <th>{d.tournaments.participants}</th>
                </tr>
              </thead>
              <tbody>
                {data.tournaments.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/${lang}/organizer/t/${t.slug}`}>{t.name}</Link>
                    </td>
                    <td>{gameBySlug(t.game)?.name ?? t.game}</td>
                    <td>
                      <Badge status={t.status}>{d.statuses.tournament[t.status]}</Badge>
                    </td>
                    <td className="small">
                      <LocalTime iso={t.starts_at} lang={lang} />
                    </td>
                    <td>{t.registered}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={d.common.emptyTitle} />
        )}
      </section>

      <section className="section-tight">
        <h2 className="h3">{ru ? "Серии и сезоны" : "Circuits and seasons"}</h2>
        <p className="small muted">
          {ru
            ? "Серия объединяет турниры сезона: накопительные очки, квалификация в финал, дивизионы с повышением и понижением. Закрытый сезон фиксируется и не пересчитывается."
            : "A circuit links a season's tournaments: cumulative points, qualification to finals, divisions with promotion and relegation. A closed season is frozen and never recomputed."}
        </p>
        {circuits.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{ru ? "Серия" : "Circuit"}</th>
                  <th>{o.game}</th>
                  <th>{o.status}</th>
                  <th>{ru ? "Турниры" : "Events"}</th>
                </tr>
              </thead>
              <tbody>
                {circuits.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/${lang}/organizer/c/${c.slug}`}>
                        {c.name} · {c.season}
                      </Link>
                    </td>
                    <td>{gameBySlug(c.game)?.name ?? c.game}</td>
                    <td>
                      <Badge status={c.status === "active" ? "ok" : "muted"}>{c.status === "active" ? (ru ? "Идёт" : "Active") : ru ? "Закрыт" : "Closed"}</Badge>
                    </td>
                    <td>
                      {c.completed} / {c.events}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small">{ru ? "Серий пока нет." : "No circuits yet."}</p>
        )}
        {manager ? (
          <details className="disclosure">
            <summary>{ru ? "Создать серию" : "Create a circuit"}</summary>
            <CircuitForm lang={lang} back={back} orgId={data.org.id} />
          </details>
        ) : null}
      </section>

      <section className="section-tight">
        <h2 className="h3">{ru ? "Шаблоны турниров" : "Tournament templates"}</h2>
        <p className="small muted">
          {ru
            ? "Шаблон сохраняется со страницы управления турниром. Статистика — только по турнирам, действительно созданным из шаблона."
            : "Save a template from a tournament's management page. Statistics count only tournaments actually created from the template."}
        </p>
        {templates.length ? (
          categories.map((category) => (
            <div key={category} className="stack-sm">
              <h3 className="h4">{category || (ru ? "Без категории" : "No category")}</h3>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{ru ? "Шаблон" : "Template"}</th>
                      <th>{o.game}</th>
                      <th>{ru ? "Создано турниров" : "Created"}</th>
                      <th>{ru ? "Завершено" : "Completed"}</th>
                      <th>{ru ? "Участников в среднем" : "Avg entrants"}</th>
                      {manager ? <th /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {templates
                      .filter((x) => x.category === category)
                      .map((x) => (
                        <tr key={x.id}>
                          <td>
                            {x.name}
                            <div className="small muted">{formatLabel(x.format, lang)}</div>
                          </td>
                          <td>{gameBySlug(x.game)?.name ?? x.game}</td>
                          <td>{x.created}</td>
                          <td>{x.completed}</td>
                          <td>{x.avg_entrants ?? "—"}</td>
                          {manager ? (
                            <td>
                              <details className="disclosure">
                                <summary>{ru ? "Создать турнир" : "Create a tournament"}</summary>
                                <ActionForm action="template.create" lang={lang} back={back} hidden={{ template: x.id }} className="stack-sm">
                                  <TimeZoneField />
                                  <input name="name" required minLength={2} maxLength={80} defaultValue={x.name} aria-label={o.tName} />
                                  <LocalDateTimeInput name="startsAt" />
                                  <button className="btn btn-primary btn-xs">{ru ? "Создать черновик" : "Create draft"}</button>
                                </ActionForm>
                              </details>
                              <ActionForm action="template.delete" lang={lang} back={back} hidden={{ template: x.id }}>
                                <button className="btn btn-ghost btn-xs">{ru ? "Удалить шаблон" : "Delete template"}</button>
                              </ActionForm>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        ) : (
          <p className="muted small">{ru ? "Шаблонов пока нет." : "No templates yet."}</p>
        )}
      </section>

      <div className="split">
        {manager ? (
          <section>
            <h2 className="h3">{o.newTournament}</h2>
            <TournamentForm lang={lang} back={back} orgId={data.org.id} circuits={circuits} />
          </section>
        ) : null}
        <section>
          <h2 className="h3">{o.members}</h2>
          <ul className="list">
            {data.members.map((m) => (
              <li key={m.id}>
                <span className="grow">
                  <Link href={`/${lang}/players/${m.username}`}>{m.display_name}</Link> <span className="small muted">@{m.username}</span>
                </span>
                <span className="small">{o.roles[m.role]}</span>
                {owner && m.id !== user.id ? (
                  <ActionForm action="org.remove" lang={lang} back={back} hidden={{ org: data.org.id, member: m.id }}>
                    <button className="btn btn-ghost btn-xs">{o.remove}</button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
          {manager ? (
            <ActionForm action="org.member" lang={lang} back={back} hidden={{ org: data.org.id }} className="inline-form">
              <input name="username" required pattern="[A-Za-z0-9_]{3,24}" placeholder={d.teams.inviteUsername} aria-label={d.teams.inviteUsername} autoCapitalize="none" />
              <select name="role" defaultValue="referee" aria-label={o.members}>
                <option value="referee">{o.roles.referee}</option>
                <option value="admin">{o.roles.admin}</option>
                {owner ? <option value="owner">{o.roles.owner}</option> : null}
              </select>
              <button className="btn btn-ghost btn-sm">{o.addMember}</button>
            </ActionForm>
          ) : null}
          <p className="small muted">{o.staffNote}</p>
        </section>
      </div>
    </div>
  );
}
