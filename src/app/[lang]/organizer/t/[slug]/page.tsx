import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { bracket, getTournament, participants } from "@/server/queries.ts";
import { canManageOrg, canReferee } from "@/server/access.ts";
import { TRANSITIONS, type TournamentStatus } from "@/server/tournaments.ts";
import { roundName } from "@/server/bracket.ts";
import { ActionForm, Badge, DbDown, Flash, type SearchParams } from "@/components/ui";
import { TournamentForm } from "@/components/tournament-form";
import { BracketView } from "@/components/tournament";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, `organizer/t/${slug}`, dict(lang).tournaments.manage, undefined, { noindex: true });
}

export default async function ManageTournament({ params, searchParams }: { params: Promise<{ lang: string; slug: string }>; searchParams: SearchParams }) {
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
  if (!user) redirect(`/${lang}/signin?next=/${lang}/organizer/t/${slug}`);
  const t = await getTournament(db, slug);
  if (!t) notFound();
  const manager = await canManageOrg(db, t.org_id, user);
  const referee = await canReferee(db, t.org_id, user);
  if (!manager && !referee)
    return (
      <div className="container page">
        <h1>{t.name}</h1>
        <p className="notice notice-warn">{o.notAllowed}</p>
      </div>
    );
  const [list, matches] = await Promise.all([participants(db, t.id), bracket(db, t.id)]);
  const [stats] = await db.query<{ disputes: number; no_shows: number }>(
    `select (select count(*)::int from disputes x join matches m on m.id = x.match_id where m.tournament_id = $1) as disputes,
            (select count(*)::int from matches where tournament_id = $1 and outcome = 'no_show') as no_shows`,
    [t.id],
  );
  const back = `/${lang}/organizer/t/${t.slug}`;
  const hidden = { tournament: t.id };
  const status = t.status as TournamentStatus;
  const editable = ["DRAFT", "PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(status);
  const preStart = ["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(status);
  const rounds = Math.max(0, ...matches.map((m) => m.round));
  const openMatches = matches.filter((m) => ["ready", "in_progress", "result_submitted", "disputed"].includes(m.status));
  const report: Array<[string, number]> = [
    ["registered", t.registered],
    ["waitlisted", t.waitlisted],
    ["checkedIn", t.checked_in],
    ["matchesDone", matches.filter((m) => m.status === "completed" && m.outcome !== "bye").length],
    ["matchesTotal", matches.filter((m) => m.outcome !== "bye").length],
    ["disputes", stats?.disputes ?? 0],
    ["noShows", stats?.no_shows ?? 0],
  ];

  return (
    <div className="container page">
      <p className="eyebrow">
        <Link href={`/${lang}/organizer/${t.org_slug}`}>{t.org_name}</Link> · {o.manageTitle}
      </p>
      <div className="row-between">
        <h1>{t.name}</h1>
        <Badge status={t.status}>{d.statuses.tournament[t.status]}</Badge>
      </div>
      <p>
        <Link href={`/${lang}/tournaments/${t.slug}`} className="text-link">
          {o.publicPage}
        </Link>
      </p>
      <Flash lang={lang} params={sp} />

      {manager ? (
        <section className="card section-card">
          <h2 className="h3">{o.lifecycle}</h2>
          <p className="small muted">{o.lifecycleNote}</p>
          <div className="row">
            {TRANSITIONS[status].map((to) => (
              <ActionForm key={to} action="tournament.transition" lang={lang} back={back} hidden={{ ...hidden, to }}>
                <button className={to === "CANCELLED" ? "btn btn-danger btn-sm" : to === "IN_PROGRESS" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}>
                  {status === "PAUSED" && to === "IN_PROGRESS" ? d.transitions.resume : d.transitions[to]}
                </button>
              </ActionForm>
            ))}
          </div>
          {["REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(status) ? (
            <div className="row">
              <span className="field-label">{o.checkInWindow}:</span>
              <Badge status={t.check_in_open ? "works" : "closed"}>{t.check_in_open ? d.tournaments.checkInOpenNow : "—"}</Badge>
              <ActionForm action="tournament.checkin_window" lang={lang} back={back} hidden={{ ...hidden, open: t.check_in_open ? "0" : "1" }}>
                <button className="btn btn-ghost btn-sm">{t.check_in_open ? o.closeCheckIn : o.openCheckIn}</button>
              </ActionForm>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="section-tight">
        <h2 className="h3">{o.report}</h2>
        <dl className="stat-grid">
          {report.map(([k, v]) => (
            <div key={k}>
              <dt>{o.reportItems[k]}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="section-tight">
        <h2 className="h3">{o.participantsTitle}</h2>
        {preStart && manager ? <p className="small muted">{o.seedsNote}</p> : null}
        {list.length ? (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{d.tournaments.seed}</th>
                    <th>{d.tournaments.participants}</th>
                    <th>{d.match.status}</th>
                    <th>{d.tournaments.checkIn}</th>
                    {manager ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <tr key={p.id}>
                      <td>
                        {preStart && manager && p.status === "registered" ? (
                          <input className="seed-input" form="seeds-form" name={`seed_${p.id}`} type="number" min={1} max={512} defaultValue={p.seed ?? ""} aria-label={`${d.tournaments.seed}: ${p.name}`} />
                        ) : (
                          p.seed ?? "—"
                        )}
                      </td>
                      <td>
                        {p.name}
                        {p.team_slug ? <div className="small muted">{p.roster.join(", ")}</div> : null}
                      </td>
                      <td>
                        <Badge status={p.status}>{d.statuses.registration[p.status]}</Badge>
                        {p.placement ? <strong> #{p.placement}</strong> : null}
                      </td>
                      <td>
                        {p.checked_in_at ? "✓" : "—"}
                        {manager && preStart && p.status === "registered" && status !== "PUBLISHED" ? (
                          <ActionForm action="tournament.checkin_override" lang={lang} back={back} hidden={{ ...hidden, registration: p.id, checked: p.checked_in_at ? "0" : "1" }}>
                            <button className="btn btn-ghost btn-xs">{p.checked_in_at ? o.unmarkCheckedIn : o.markCheckedIn}</button>
                          </ActionForm>
                        ) : null}
                      </td>
                      {manager ? (
                        <td>
                          {["registered", "waitlisted"].includes(p.status) && !["COMPLETED", "CANCELLED", "ARCHIVED"].includes(status) ? (
                            <details className="disclosure">
                              <summary>{o.disqualify}</summary>
                              <ActionForm action="tournament.disqualify" lang={lang} back={back} hidden={{ ...hidden, registration: p.id }} className="inline-form">
                                <input name="reason" required minLength={3} maxLength={300} placeholder={o.reason} aria-label={o.reason} />
                                <button className="btn btn-danger btn-xs">{o.disqualify}</button>
                              </ActionForm>
                            </details>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preStart && manager ? (
              <form id="seeds-form" method="post" action={`/api/a/tournament.seeds?lang=${lang}`}>
                <input type="hidden" name="lang" value={lang} />
                <input type="hidden" name="back" value={back} />
                <input type="hidden" name="tournament" value={t.id} />
                <button className="btn btn-ghost btn-sm">{o.saveSeeds}</button>
              </form>
            ) : null}
          </>
        ) : (
          <p className="muted">{d.tournaments.noParticipants}</p>
        )}
      </section>

      {matches.length ? (
        <section className="section-tight">
          <h2 className="h3">{o.matchesTitle}</h2>
          {openMatches.length ? (
            <ul className="list">
              {openMatches.map((m) => (
                <li key={m.id}>
                  <span className="grow">
                    {roundName(m.round, rounds, lang)}: {m.a_name ?? d.common.tbd} {d.common.vs} {m.b_name ?? d.common.tbd}
                  </span>
                  <Badge status={m.status}>{d.statuses.match[m.status]}</Badge>
                  <Link href={`/${lang}/matches/${m.id}`} className="btn btn-ghost btn-xs">
                    {o.open}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          <BracketView lang={lang} matches={matches} />
        </section>
      ) : null}

      {manager && editable ? (
        <section className="section-tight">
          <h2 className="h3">{o.edit}</h2>
          <TournamentForm lang={lang} back={back} t={t} structuralLocked={list.length > 0} />
        </section>
      ) : null}
    </div>
  );
}
