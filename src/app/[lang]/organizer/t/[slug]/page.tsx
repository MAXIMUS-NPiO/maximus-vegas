import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { flagLabel, reviewLabel } from "@/lib/labels.ts";
import { viewer } from "@/server/viewer.ts";
import { bracket, getTournament, participants } from "@/server/queries.ts";
import { canManageOrg } from "@/server/access.ts";
import { allowedTransitions, canManageTournament, canRefereeTournament, type TournamentStatus } from "@/server/tournaments.ts";
import { roundName } from "@/server/bracket.ts";
import { deRoundName } from "@/server/double.ts";
import { scoreLog } from "@/server/leaderboard.ts";
import { ActionForm, Badge, DbDown, Field, Flash, type SearchParams } from "@/components/ui";
import { TournamentForm } from "@/components/tournament-form";
import { BracketView, formatLabel } from "@/components/tournament";

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
  const ru = lang === "ru";
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
  const manager = await canManageTournament(db, t, user);
  const referee = await canRefereeTournament(db, t, user);
  if (!manager && !referee)
    return (
      <div className="container page">
        <h1>{t.name}</h1>
        <p className="notice notice-warn">{o.notAllowed}</p>
      </div>
    );
  const primary = t.created_by === user.id || user.roles.includes("admin") || (await canManageOrg(db, t.org_id, user));
  const leaderboard = t.format === "leaderboard";
  const [list, matches] = await Promise.all([participants(db, t.id), leaderboard ? Promise.resolve([]) : bracket(db, t.id)]);
  const [stats] = await db.query<{ disputes: number; no_shows: number; entries: number; pending: number }>(
    `select (select count(*)::int from disputes x join matches m on m.id = x.match_id where m.tournament_id = $1) as disputes,
            (select count(*)::int from matches where tournament_id = $1 and outcome = 'no_show') as no_shows,
            (select count(*)::int from score_entries where tournament_id = $1) as entries,
            (select count(*)::int from score_entries where tournament_id = $1 and review = 'pending') as pending`,
    [t.id],
  );
  const coorgs = await db.query<{ id: string; username: string; display_name: string }>(
    "select u.id, u.username, u.display_name from tournament_organizers c join users u on u.id = c.user_id where c.tournament_id = $1 order by u.username",
    [t.id],
  );
  const openPostDisputes = await db.query<{ id: string; match_id: string; reason: string }>(
    "select d.id, d.match_id, d.reason from disputes d join matches m on m.id = d.match_id where m.tournament_id = $1 and d.status = 'open' and d.kind = 'post_result'",
    [t.id],
  );
  const lines = leaderboard ? await scoreLog(db, t.id) : [];
  const pendingLines = lines.filter((l) => l.review === "pending");
  const back = `/${lang}/organizer/t/${t.slug}`;
  const hidden = { tournament: t.id };
  const status = t.status as TournamentStatus;
  const editable = ["DRAFT", "PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(status);
  const preStart = ["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(status);
  const wRounds = Math.max(0, ...matches.filter((m) => (m.bracket ?? "W") === "W").map((m) => m.round));
  const lRounds = Math.max(0, ...matches.filter((m) => m.bracket === "L").map((m) => m.round));
  const label = (m: (typeof matches)[number]) =>
    t.format === "double_elimination" ? deRoundName((m.bracket ?? "W") as "W" | "L" | "GF", m.round, wRounds, lRounds, lang) : roundName(m.round, wRounds, lang);
  const openMatches = matches.filter((m) => ["ready", "in_progress", "result_submitted", "disputed"].includes(m.status));
  const report: Array<[string, number]> = leaderboard
    ? [
        ["registered", t.registered],
        ["waitlisted", t.waitlisted],
        ["checkedIn", t.checked_in],
      ]
    : [
        ["registered", t.registered],
        ["waitlisted", t.waitlisted],
        ["checkedIn", t.checked_in],
        ["matchesDone", matches.filter((m) => m.status === "completed" && m.outcome !== "bye").length],
        ["matchesTotal", matches.filter((m) => m.outcome !== "bye" && !(m.a_void && m.b_void)).length],
        ["disputes", stats?.disputes ?? 0],
        ["noShows", stats?.no_shows ?? 0],
      ];

  return (
    <div className="container page">
      <p className="eyebrow">
        <Link href={`/${lang}/organizer/${t.org_slug}`}>{t.org_name}</Link> · {o.manageTitle} · {formatLabel(t.format, lang)}
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
          <p className="small muted">
            {o.lifecycleNote}
            {leaderboard ? (ru ? " Leaderboard завершается вручную, когда все отмеченные результаты проверены." : " A leaderboard is completed manually once every flagged result is reviewed.") : ""}
          </p>
          <div className="row">
            {allowedTransitions(t.format, status).map((to) => (
              <ActionForm key={to} action="tournament.transition" lang={lang} back={back} hidden={{ ...hidden, to }}>
                <button className={to === "CANCELLED" ? "btn btn-danger btn-sm" : to === "IN_PROGRESS" || to === "COMPLETED" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}>
                  {status === "PAUSED" && to === "IN_PROGRESS" ? d.transitions.resume : to === "COMPLETED" ? (ru ? "Завершить и опубликовать итоги" : "Complete and publish results") : d.transitions[to]}
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
          {leaderboard ? (
            <>
              <div>
                <dt>{ru ? "Строк результатов" : "Result lines"}</dt>
                <dd>{stats?.entries ?? 0}</dd>
              </div>
              <div>
                <dt>{ru ? "Ждут проверки" : "Awaiting review"}</dt>
                <dd>{stats?.pending ?? 0}</dd>
              </div>
            </>
          ) : null}
        </dl>
      </section>

      {openPostDisputes.length ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Оспаривания решённых матчей" : "Disputes of decided matches"}</h2>
          <ul className="list">
            {openPostDisputes.map((x) => (
              <li key={x.id}>
                <span className="grow small prewrap">{x.reason}</span>
                <Link href={`/${lang}/matches/${x.match_id}`} className="btn btn-ghost btn-xs">
                  {o.open}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {leaderboard && (referee || manager) ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Проверка результатов" : "Result review"}</h2>
          <p className="small muted">{ru ? "Это проверка целостности данных, а не античит. Решение фиксируется в журнале." : "This is a data integrity check, not anti-cheat. Each decision is recorded in the log."}</p>
          {pendingLines.length ? (
            <ul className="list">
              {pendingLines.map((l) => (
                <li key={l.id} className="stack-sm">
                  <div className="row-between">
                    <strong>{l.name}</strong>
                    <span className="small">{l.flags.map((f) => flagLabel(f, lang)).join("; ")}</span>
                  </div>
                  <p className="small">
                    K {l.kills} · A {l.assists} · D {l.deaths} · HS {l.headshots} · DMG {l.damage} · {l.distance} m{l.placement ? ` · #${l.placement}` : ""}
                    {l.match_ref ? ` · ${l.match_ref}` : ""}
                    {l.evidence_url ? (
                      <>
                        {" "}
                        ·{" "}
                        <a href={l.evidence_url} target="_blank" rel="noopener noreferrer nofollow" className="text-link">
                          {ru ? "доказательство" : "evidence"} ↗
                        </a>
                      </>
                    ) : null}
                  </p>
                  <div className="row">
                    <ActionForm action="score.review" lang={lang} back={back} hidden={{ entry: l.id, decision: "approve" }} className="inline-form">
                      <input name="note" maxLength={500} placeholder={ru ? "Комментарий" : "Note"} aria-label={ru ? "Комментарий" : "Note"} />
                      <button className="btn btn-primary btn-xs">{ru ? "Учесть" : "Approve"}</button>
                    </ActionForm>
                    <ActionForm action="score.review" lang={lang} back={back} hidden={{ entry: l.id, decision: "reject" }} className="inline-form">
                      <input name="note" maxLength={500} placeholder={ru ? "Причина" : "Reason"} aria-label={ru ? "Причина" : "Reason"} />
                      <button className="btn btn-danger btn-xs">{ru ? "Отклонить" : "Reject"}</button>
                    </ActionForm>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{ru ? "Нет результатов на проверке." : "Nothing awaiting review."}</p>
          )}
          {t.status === "IN_PROGRESS" ? (
            <details className="disclosure card">
              <summary>{ru ? "Внести результат за участника" : "Log a result for a participant"}</summary>
              <ActionForm action="score.log" lang={lang} back={back} hidden={hidden} className="stack">
                <Field label={d.tournaments.participants}>
                  <select name="registration" required>
                    {list
                      .filter((p) => p.status === "registered")
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <div className="form-grid form-grid-4">
                  {(["kills", "assists", "deaths", "headshots", "damage", "distance"] as const).map((k) => (
                    <Field key={k} label={k}>
                      <input name={k} type="number" min={0} max={k === "damage" ? 99999 : k === "distance" ? 999999 : 999} defaultValue={0} required />
                    </Field>
                  ))}
                  <Field label={ru ? "Место" : "Placement"}>
                    <select name="placement" defaultValue="">
                      <option value="">—</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                    </select>
                  </Field>
                  <Field label={ru ? "ID матча" : "Match ID"}>
                    <input name="matchRef" maxLength={80} />
                  </Field>
                </div>
                <button className="btn btn-primary btn-sm">{ru ? "Внести" : "Log result"}</button>
              </ActionForm>
            </details>
          ) : null}
          {lines.length ? (
            <details className="disclosure">
              <summary>
                {ru ? "Все строки" : "All lines"} ({lines.length})
              </summary>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{d.tournaments.participants}</th>
                      <th>K / A / D / HS</th>
                      <th>DMG · m · #</th>
                      <th>{ru ? "Источник" : "Source"}</th>
                      <th>{d.match.status}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.id}>
                        <td>{l.name}</td>
                        <td>
                          {l.kills} / {l.assists} / {l.deaths} / {l.headshots}
                        </td>
                        <td>
                          {l.damage} · {l.distance} · {l.placement ?? "—"}
                        </td>
                        <td className="small">
                          {l.source === "organizer" ? (ru ? "организатор" : "organiser") : ru ? "участник" : "participant"} · {l.submitted_by}
                        </td>
                        <td>
                          <Badge status={l.review === "pending" ? "warn" : l.review === "rejected" ? "bad" : "ok"}>{reviewLabel(l.review, lang)}</Badge>
                        </td>
                        <td>
                          {["accepted", "approved"].includes(l.review) && ["IN_PROGRESS", "PAUSED"].includes(t.status) ? (
                            <details className="disclosure">
                              <summary>{ru ? "Отклонить" : "Reject"}</summary>
                              <ActionForm action="score.review" lang={lang} back={back} hidden={{ entry: l.id, decision: "reject" }} className="inline-form">
                                <input name="note" required minLength={5} maxLength={500} placeholder={ru ? "Причина" : "Reason"} aria-label={ru ? "Причина" : "Reason"} />
                                <button className="btn btn-danger btn-xs">{ru ? "Отклонить" : "Reject"}</button>
                              </ActionForm>
                            </details>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </section>
      ) : null}

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
            {preStart ? (
              <p className="small muted">
                {ru
                  ? "Без ручного посева порядок определяет игровой опыт (XP) в этой игре, затем порядок регистрации. Посев никогда не случайный."
                  : "Without manual seeds, order follows experience (XP) in this game, then registration order. Seeding is never random."}
              </p>
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
                    {label(m)}: {m.a_name ?? d.common.tbd} {d.common.vs} {m.b_name ?? d.common.tbd}
                  </span>
                  <Badge status={m.status}>{d.statuses.match[m.status]}</Badge>
                  <Link href={`/${lang}/matches/${m.id}`} className="btn btn-ghost btn-xs">
                    {o.open}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          <BracketView lang={lang} matches={matches} format={t.format} />
        </section>
      ) : null}

      {manager ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Со-организаторы" : "Co-organisers"}</h2>
          <p className="small muted">
            {ru
              ? "Со-организатор управляет этим турниром: участники, результаты, споры. Список ведёт только основной организатор или руководитель пространства."
              : "A co-organiser manages this tournament: entrants, results, disputes. Only the primary organiser or the space's managers edit this list."}
          </p>
          {coorgs.length ? (
            <ul className="list">
              {coorgs.map((c) => (
                <li key={c.id}>
                  <span className="grow">
                    {c.display_name} <span className="muted">@{c.username}</span>
                  </span>
                  {primary ? (
                    <ActionForm action="tournament.coorg_remove" lang={lang} back={back} hidden={{ ...hidden, member: c.id }}>
                      <button className="btn btn-ghost btn-xs">{ru ? "Убрать доступ" : "Remove access"}</button>
                    </ActionForm>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{ru ? "Со-организаторов нет." : "No co-organisers."}</p>
          )}
          {primary ? (
            <ActionForm action="tournament.coorg_add" lang={lang} back={back} hidden={hidden} className="inline-form">
              <input name="username" required pattern="[A-Za-z0-9_]{3,24}" placeholder={ru ? "имя пользователя" : "username"} aria-label={ru ? "Имя пользователя со-организатора" : "Co-organiser username"} />
              <button className="btn btn-ghost btn-sm">{ru ? "Добавить со-организатора" : "Add co-organiser"}</button>
            </ActionForm>
          ) : null}
        </section>
      ) : null}

      {manager ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Баннер турнира" : "Tournament banner"}</h2>
          <form method="post" action={`/api/a/tournament.banner?lang=${lang}`} encType="multipart/form-data" className="inline-form">
            <input type="hidden" name="lang" value={lang} />
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="tournament" value={t.id} />
            <input name="banner" type="file" accept="image/png,image/jpeg,image/webp" aria-label={ru ? "Файл баннера" : "Banner file"} />
            <button className="btn btn-ghost btn-sm">{ru ? "Загрузить (до 1 МБ)" : "Upload (up to 1 MB)"}</button>
          </form>
          {t.banner_media_id ? (
            <ActionForm action="tournament.banner" lang={lang} back={back} hidden={{ ...hidden, clear: "1" }}>
              <button className="btn btn-ghost btn-xs">{ru ? "Убрать баннер" : "Remove banner"}</button>
            </ActionForm>
          ) : null}
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
