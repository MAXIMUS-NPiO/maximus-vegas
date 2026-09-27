import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, fill, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { getMatch } from "@/server/queries.ts";
import { canReferee } from "@/server/access.ts";
import { roundName } from "@/server/bracket.ts";
import { ActionForm, Badge, DbDown, Field, Flash, type SearchParams } from "@/components/ui";
import { LocalDateTimeInput, LocalTime, TimeZoneField } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; id: string }> }): Promise<Metadata> {
  const { lang, id } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, `matches/${id}`, dict(lang).match.title, undefined, { noindex: true });
}

export default async function MatchPage({ params, searchParams }: { params: Promise<{ lang: string; id: string }>; searchParams: SearchParams }) {
  const { lang, id } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  const data = await getMatch(db, id);
  if (!data || data.match.t_status === "DRAFT") notFound();
  const { match: m, a, b, results, disputes } = data;
  const referee = await canReferee(db, m.org_id, user);
  const mySide = user ? (a?.leaders.includes(user.id) ? "a" : b?.leaders.includes(user.id) ? "b" : null) : null;
  const live = m.t_status === "IN_PROGRESS";
  const pending = results.find((r) => r.status === "pending");
  const confirmed = results.find((r) => r.status === "confirmed");
  const back = `/${lang}/matches/${m.id}`;
  const hidden = { match: m.id };
  const open = !["completed", "cancelled"].includes(m.status);
  const both = Boolean(a && b);

  const sideCard = (s: typeof a, key: "a" | "b") => {
    const score = key === "a" ? m.score_a : m.score_b;
    const isWinner = m.winner_reg && s && m.winner_reg === s.reg;
    return (
      <div className={`side-card${isWinner ? " is-winner" : ""}${mySide === key ? " is-mine" : ""}`}>
        {s ? (
          <>
            <p className="side-name">
              {s.team_slug ? (
                <Link href={`/${lang}/teams/${s.team_slug}`}>{s.name}</Link>
              ) : s.username ? (
                <Link href={`/${lang}/players/${s.username}`}>{s.name}</Link>
              ) : (
                s.name
              )}
              {mySide === key ? <span className="badge badge-info">{d.common.you}</span> : null}
            </p>
            {s.team_slug ? (
              <p className="small muted">
                {d.match.rosterTitle}: {s.roster.join(", ")}
              </p>
            ) : null}
          </>
        ) : (
          <p className="side-name muted">{d.common.tbd}</p>
        )}
        <p className="side-score">{score ?? (isWinner && m.outcome !== "played" ? "W" : "–")}</p>
      </div>
    );
  };

  return (
    <div className="container page">
      <p className="eyebrow">
        <Link href={`/${lang}/tournaments/${m.t_slug}`}>{m.t_name}</Link> · {roundName(m.round, m.rounds, lang)} · {d.match.gameDay}
      </p>
      <div className="row-between">
        <h1>
          {a?.name ?? d.common.tbd} <span className="muted">{d.common.vs}</span> {b?.name ?? d.common.tbd}
        </h1>
        <Badge status={m.status}>{d.statuses.match[m.status]}</Badge>
      </div>
      <Flash lang={lang} params={sp} />

      <div className="versus">
        {sideCard(a, "a")}
        {sideCard(b, "b")}
      </div>

      <div className="grid grid-3 facts">
        <div className="card">
          <p className="field-label">{d.match.whatNow}</p>
          <p>{m.t_status === "PAUSED" ? d.statuses.tournament.PAUSED : d.match.explain[m.status]}</p>
          {m.outcome && m.outcome !== "played" ? <p className="small muted">{d.statuses.outcome[m.outcome]}</p> : null}
        </div>
        <div className="card">
          <p className="field-label">{d.match.scheduled}</p>
          <p>{m.scheduled_at ? <LocalTime iso={m.scheduled_at} lang={lang} /> : <span className="muted">{d.match.notScheduled}</span>}</p>
          <p className="small muted">{d.common.timeNote}</p>
        </div>
        <div className="card">
          <p className="field-label">{d.match.room}</p>
          {m.room_code ? <p className="mono">{m.room_code}</p> : <p className="muted small">{d.match.noRoom}</p>}
          {open && (mySide || referee) ? (
            <ActionForm action="match.details" lang={lang} back={back} hidden={hidden} className="inline-form">
              <input name="roomCode" maxLength={80} placeholder={d.match.setRoom} aria-label={d.match.setRoom} defaultValue={m.room_code} />
              <button className="btn btn-ghost btn-sm">{d.match.save}</button>
            </ActionForm>
          ) : null}
        </div>
      </div>

      {confirmed ? (
        <p className="notice notice-ok">
          {d.match.verification}: <strong>{d.statuses.source[confirmed.source]}</strong>
          {confirmed.evidence_url ? (
            <>
              {" "}
              ·{" "}
              <a href={confirmed.evidence_url} target="_blank" rel="noopener noreferrer nofollow" className="text-link">
                {lang === "ru" ? "доказательство" : "evidence"}
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      {live && mySide && both ? (
        <section className="card action-card">
          {m.status === "result_submitted" && pending && pending.side !== mySide ? (
            <>
              <h2 className="h3">{d.match.confirmTitle}</h2>
              <p className="big-score">
                {a?.name} {pending.score_a} : {pending.score_b} {b?.name}
              </p>
              {pending.evidence_url ? (
                <a href={pending.evidence_url} target="_blank" rel="noopener noreferrer nofollow" className="text-link">
                  {lang === "ru" ? "Доказательство соперника" : "Opponent's evidence"}
                </a>
              ) : null}
              {pending.note ? <p className="small muted prewrap">{pending.note}</p> : null}
              <ActionForm action="match.confirm" lang={lang} back={back} hidden={hidden}>
                <button className="btn btn-primary">{d.match.confirm}</button>
              </ActionForm>
              <details className="disclosure">
                <summary>{d.match.disputeTitle}</summary>
                <ActionForm action="match.dispute" lang={lang} back={back} hidden={hidden} className="stack">
                  <Field label={d.match.disputeReason}>
                    <textarea name="reason" required minLength={5} maxLength={1000} rows={3} />
                  </Field>
                  <button className="btn btn-danger btn-sm">{d.match.dispute}</button>
                </ActionForm>
              </details>
            </>
          ) : ["ready", "in_progress", "result_submitted"].includes(m.status) ? (
            <>
              {m.status === "result_submitted" && pending?.side === mySide ? <p className="notice">{d.match.waitingOpponent}</p> : null}
              <h2 className="h3">{d.match.reportTitle}</h2>
              <ActionForm action="match.submit" lang={lang} back={back} hidden={hidden} className="stack">
                <div className="score-inputs">
                  <Field label={`${d.match.scoreFor}: ${a?.name}`}>
                    <input name="scoreA" type="number" min={0} max={999} required inputMode="numeric" />
                  </Field>
                  <Field label={`${d.match.scoreFor}: ${b?.name}`}>
                    <input name="scoreB" type="number" min={0} max={999} required inputMode="numeric" />
                  </Field>
                </div>
                <Field label={d.match.evidence}>
                  <input name="evidence" type="url" maxLength={500} placeholder="https://" />
                </Field>
                <Field label={d.match.note}>
                  <textarea name="note" rows={2} maxLength={1000} />
                </Field>
                <button className="btn btn-primary">{d.match.submit}</button>
              </ActionForm>
              {m.status === "ready" ? (
                <ActionForm action="match.details" lang={lang} back={back} hidden={{ ...hidden, live: "1" }}>
                  <button className="btn btn-ghost btn-sm">{d.match.markLive}</button>
                </ActionForm>
              ) : null}
            </>
          ) : m.status === "disputed" ? (
            <p>{d.match.explain.disputed}</p>
          ) : null}
        </section>
      ) : null}

      {referee && (live || m.t_status === "COMPLETED") ? (
        <section className="card action-card referee">
          {open && live && both ? (
            <>
              <h2 className="h3">{d.match.refereeTitle}</h2>
              <p className="small muted">{d.match.refereeNote}</p>
              <ActionForm action="match.official" lang={lang} back={back} hidden={hidden} className="stack">
                <div className="score-inputs">
                  <Field label={`${d.match.scoreFor}: ${a?.name}`}>
                    <input name="scoreA" type="number" min={0} max={999} required defaultValue={pending?.score_a ?? undefined} />
                  </Field>
                  <Field label={`${d.match.scoreFor}: ${b?.name}`}>
                    <input name="scoreB" type="number" min={0} max={999} required defaultValue={pending?.score_b ?? undefined} />
                  </Field>
                </div>
                <Field label={d.match.resolution}>
                  <textarea name="resolution" rows={2} maxLength={1000} />
                </Field>
                <Field label={d.match.evidence}>
                  <input name="evidence" type="url" maxLength={500} placeholder="https://" />
                </Field>
                <button className="btn btn-primary">{d.match.decide}</button>
              </ActionForm>
              <div className="row">
                <span className="field-label">{d.match.noShowTitle}:</span>
                <ActionForm action="match.noshow" lang={lang} back={back} hidden={{ ...hidden, absent: "a" }}>
                  <button className="btn btn-ghost btn-sm">{fill(d.match.noShowA, { a: a?.name })}</button>
                </ActionForm>
                <ActionForm action="match.noshow" lang={lang} back={back} hidden={{ ...hidden, absent: "b" }}>
                  <button className="btn btn-ghost btn-sm">{fill(d.match.noShowB, { b: b?.name })}</button>
                </ActionForm>
              </div>
            </>
          ) : null}
          {open ? (
            <ActionForm action="match.details" lang={lang} back={back} hidden={hidden} className="inline-form">
              <TimeZoneField />
              <label className="field-label" htmlFor="sched">
                {d.match.scheduleTitle}
              </label>
              <span id="sched">
                <LocalDateTimeInput name="scheduledAt" iso={m.scheduled_at ? new Date(m.scheduled_at).toISOString() : null} />
              </span>
              <button className="btn btn-ghost btn-sm">{d.match.save}</button>
            </ActionForm>
          ) : null}
          {m.status === "completed" && m.outcome !== "bye" && both ? (
            <details className="disclosure">
              <summary>{d.match.correctTitle}</summary>
              <p className="small muted">{d.match.correctNote}</p>
              <ActionForm action="match.correct" lang={lang} back={back} hidden={hidden} className="stack">
                <div className="score-inputs">
                  <Field label={`${d.match.scoreFor}: ${a?.name}`}>
                    <input name="scoreA" type="number" min={0} max={999} required defaultValue={m.score_a ?? undefined} />
                  </Field>
                  <Field label={`${d.match.scoreFor}: ${b?.name}`}>
                    <input name="scoreB" type="number" min={0} max={999} required defaultValue={m.score_b ?? undefined} />
                  </Field>
                </div>
                <Field label={d.match.correctReason}>
                  <textarea name="note" required minLength={5} rows={2} maxLength={1000} />
                </Field>
                <button className="btn btn-danger btn-sm">{d.match.correct}</button>
              </ActionForm>
            </details>
          ) : null}
        </section>
      ) : null}

      <section className="section-tight">
        <h2 className="h3">{d.match.history}</h2>
        {results.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{d.match.scoreFor}</th>
                  <th>{d.match.verification}</th>
                  <th>{d.match.status}</th>
                  <th>{d.common.createdAt}</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.id}>
                    <td>v{r.version}</td>
                    <td>
                      {r.outcome === "no_show" ? d.statuses.outcome.no_show : `${r.score_a} : ${r.score_b}`}
                      {r.evidence_url ? (
                        <>
                          {" "}
                          <a href={r.evidence_url} target="_blank" rel="noopener noreferrer nofollow" className="text-link small">
                            ↗
                          </a>
                        </>
                      ) : null}
                      {r.note ? <div className="small muted prewrap">{r.note}</div> : null}
                    </td>
                    <td className="small">
                      {d.statuses.source[r.source]} · {d.match.by} {r.submitted_by}
                    </td>
                    <td>
                      <Badge status={r.status}>{d.match.versionStatus[r.status]}</Badge>
                    </td>
                    <td className="small">
                      <LocalTime iso={r.created_at} lang={lang} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{d.match.noHistory}</p>
        )}
      </section>

      {disputes.length ? (
        <section className="section-tight">
          <h2 className="h3">{d.match.disputes}</h2>
          <ul className="list">
            {disputes.map((x) => (
              <li key={x.id} className="stack-sm">
                <div className="row-between">
                  <span className="small">
                    {x.opened_by} · <LocalTime iso={x.created_at} lang={lang} />
                  </span>
                  <Badge status={x.status}>{d.match.disputeStatus[x.status]}</Badge>
                </div>
                <p className="prewrap">{x.reason === "conflicting_results" ? (lang === "ru" ? "Стороны отправили разные результаты" : "The sides submitted different results") : x.reason}</p>
                {x.resolution && x.resolution !== "result_confirmed" ? <p className="small muted prewrap">{x.resolution}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="row">
        <Link href={`/${lang}/tournaments/${m.t_slug}#bracket`} className="btn btn-ghost btn-sm">
          {d.match.toTournament}
        </Link>
        {data.nextMatch ? (
          <Link href={`/${lang}/matches/${data.nextMatch.id}`} className="btn btn-ghost btn-sm">
            {d.match.next}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
