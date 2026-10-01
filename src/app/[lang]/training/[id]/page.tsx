import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { gameBySlug } from "@/lib/games.ts";
import { academyText } from "@/lib/academy-text.ts";
import { viewer } from "@/server/viewer.ts";
import { engagement, PROGRESS_KINDS } from "@/server/academy.ts";
import { ratingsFor } from "@/server/rating.ts";
import { recordStaffView } from "@/server/admin.ts";
import { ActionForm, Badge, DbDown, Empty, Field, Flash, type SearchParams } from "@/components/ui";
import { LocalTime, TimeZoneField } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; id: string }> }): Promise<Metadata> {
  const { lang, id } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, `training/${id}`, academyText[lang].myTraining, undefined, { noindex: true });
}

/**
 * One training engagement (MV-ACADEMY-1) for its coach and its player: goal, sessions and progress, with
 * the coach's forms. Academy staff may open it; the view is recorded.
 */
export default async function TrainingPage({ params, searchParams }: { params: Promise<{ lang: string; id: string }>; searchParams: SearchParams }) {
  const { lang, id } = await params;
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
  const back = `/${lang}/training/${id}`;
  if (!user) redirect(`/${lang}/signin?next=${back}`);
  const data = await engagement(db, id, user);
  if (!data) notFound();
  const { request: r, sessions, progress, role } = data;
  if (role === "staff") await recordStaffView(db, user, r.student_id, "training");
  const coach = role === "coach";
  const open = r.status === "accepted";
  const rating = (await ratingsFor(db, r.student_id)).find((x) => x.game === r.game);
  return (
    <div className="container page">
      {role === "staff" ? <p className="notice notice-warn small">{x.staffView}</p> : null}
      <p className="eyebrow">
        <Link href={`/${lang}/${coach ? "coach" : "training"}`}>{coach ? x.workspace : x.myTraining}</Link> · {gameBySlug(r.game)?.name ?? r.game}
        {r.programme_title ? ` · ${r.programme_title}` : ""}
      </p>
      <div className="row-between">
        <h1 className="msg-title">
          {coach ? `${r.student_name} @${r.student_username}` : `${r.coach_name} @${r.coach_username}`}
        </h1>
        <Badge status={r.status}>{x.requestStatuses[r.status]}</Badge>
      </div>
      <Flash lang={lang} params={sp} />
      <div className="grid grid-2 section-tight">
        <div className="card stack-sm">
          <p className="field-label">{x.goalTitle}</p>
          <p className="prewrap">{r.goal}</p>
          {r.availability ? <p className="small muted">{r.availability}</p> : null}
          <p className="small muted">
            {x.coach}: <Link href={`/${lang}/coaches/${r.coach_username}`}>@{r.coach_username}</Link> · {x.student}: @{r.student_username} ·{" "}
            <LocalTime iso={r.created_at} lang={lang} dateOnly />
          </p>
          {r.coach_note ? (
            <p className="small">
              <strong>{x.note}:</strong> {r.coach_note}
            </p>
          ) : null}
          <div className="row">
            {role === "student" && ["pending", "accepted"].includes(r.status) ? (
              <ActionForm action="training.cancel" lang={lang} back={back} hidden={{ request: r.id }}>
                <button className="btn btn-ghost btn-sm">{x.cancel}</button>
              </ActionForm>
            ) : null}
            {coach && open ? (
              <ActionForm action="training.complete" lang={lang} back={back} hidden={{ request: r.id }}>
                <button className="btn btn-ghost btn-sm">{x.complete}</button>
              </ActionForm>
            ) : null}
          </div>
        </div>
        <div className="card stack-sm">
          <p className="field-label">{x.portalFacts}</p>
          <p className="small muted">{x.portalFactsLead}</p>
          {rating ? (
            <p>
              <strong>
                {x.rating} {rating.rating}
              </strong>{" "}
              <span className="small muted">
                · {rating.matches} {x.matches}
              </span>
            </p>
          ) : (
            <p className="small muted">{x.noRating}</p>
          )}
        </div>
      </div>

      <section className="section-tight stack-sm" id="sessions">
        <h2 className="h3">{x.sessionsTitle}</h2>
        {sessions.length ? (
          <ul className="list small">
            {sessions.map((s) => (
              <li key={s.id} className="stack-sm">
                <span className="row">
                  <span className="mono grow">
                    <LocalTime iso={s.starts_at} lang={lang} />
                  </span>
                  <Badge status={s.status === "done" ? "ok" : s.status === "scheduled" ? "info" : "muted"}>{x.sessionStatuses[s.status]}</Badge>
                </span>
                <span className="muted break-all">
                  {s.minutes} min{s.place ? ` · ${s.place}` : ""}
                </span>
                <span className="row">
                  {s.status === "scheduled" && coach && new Date(s.starts_at).getTime() <= Date.now() ? (
                    <>
                      <ActionForm action="training.session_status" lang={lang} back={`${back}#sessions`} hidden={{ session: s.id, status: "done" }}>
                        <button className="btn btn-ghost btn-xs">{x.markDone}</button>
                      </ActionForm>
                      <ActionForm action="training.session_status" lang={lang} back={`${back}#sessions`} hidden={{ session: s.id, status: "no_show" }}>
                        <button className="btn btn-ghost btn-xs">{x.markNoShow}</button>
                      </ActionForm>
                    </>
                  ) : null}
                  {s.status === "scheduled" && (coach || (role === "student" && new Date(s.starts_at).getTime() > Date.now())) ? (
                    <ActionForm action="training.session_status" lang={lang} back={`${back}#sessions`} hidden={{ session: s.id, status: "cancelled" }}>
                      <button className="btn btn-ghost btn-xs">{x.cancelSession}</button>
                    </ActionForm>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">{x.noSessions}</p>
        )}
        {coach && open ? (
          <details className="disclosure card">
            <summary>{x.book}</summary>
            <ActionForm action="training.session" lang={lang} back={`${back}#sessions`} hidden={{ request: r.id }} className="stack-sm">
              <div className="form-grid">
                <Field label={x.when}>
                  <input type="datetime-local" name="startsAt" required />
                </Field>
                <Field label={x.duration}>
                  <input type="number" name="minutes" min={30} max={240} step={15} defaultValue={60} required />
                </Field>
              </div>
              <Field label={x.place}>
                <input name="place" maxLength={300} />
              </Field>
              <TimeZoneField />
              <button className="btn btn-primary btn-sm">{x.book}</button>
            </ActionForm>
          </details>
        ) : null}
      </section>

      <section className="section-tight stack-sm" id="progress">
        <h2 className="h3">{x.progress}</h2>
        <p className="small muted">{x.progressLead}</p>
        {progress.length ? (
          <ul className="list">
            {progress.map((p) => (
              <li key={p.id} className="stack-sm">
                <span className="row">
                  <Badge status={p.kind === "observation" ? "info" : p.kind === "exercise" ? "ok" : "warn"}>{x.kinds[p.kind]}</Badge>
                  <span className="small muted">
                    @{p.author} · <LocalTime iso={p.created_at} lang={lang} />
                    {p.time_mark ? ` · ${p.time_mark}` : ""}
                  </span>
                </span>
                {p.kind === "measure" ? (
                  <p>
                    <strong>
                      {p.metric}: {Number(p.value)}
                    </strong>
                  </p>
                ) : null}
                <p className="small prewrap">{p.body}</p>
                {p.evidence_url ? (
                  <a href={p.evidence_url} target="_blank" rel="noopener nofollow ugc" className="text-link small break-all">
                    {p.evidence_url}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={x.noProgress} />
        )}
        {coach && ["accepted", "completed"].includes(r.status) ? (
          <details className="disclosure card">
            <summary>{x.addRecord}</summary>
            <ActionForm action="training.progress" lang={lang} back={`${back}#progress`} hidden={{ request: r.id }} className="stack-sm">
              <div className="form-grid">
                <Field label={x.kind}>
                  <select name="kind" defaultValue="observation">
                    {PROGRESS_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {x.kinds[k]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={x.session}>
                  <select name="session" defaultValue="">
                    <option value="">{x.noSession}</option>
                    {sessions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {new Date(s.starts_at).toISOString().slice(0, 16).replace("T", " ")} UTC
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={x.timeMark}>
                  <input name="timeMark" maxLength={8} pattern="([0-9]{1,2}:)?[0-9]{1,2}:[0-9]{2}" />
                </Field>
                <Field label={x.evidence}>
                  <input name="evidence" type="url" maxLength={500} placeholder="https://" />
                </Field>
                <Field label={x.metric}>
                  <input name="metric" maxLength={60} />
                </Field>
                <Field label={x.value}>
                  <input name="value" inputMode="decimal" maxLength={20} />
                </Field>
              </div>
              <Field label={x.body}>
                <textarea name="body" required minLength={3} maxLength={1000} rows={3} />
              </Field>
              <button className="btn btn-primary btn-sm">{x.addRecord}</button>
            </ActionForm>
          </details>
        ) : null}
      </section>
    </div>
  );
}
