import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { fill, isLocale, type Locale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { GAMES, gameBySlug } from "@/lib/games.ts";
import { academyText } from "@/lib/academy-text.ts";
import { viewer } from "@/server/viewer.ts";
import { COACH_FORMATS, COACH_LANGUAGES, coachQueue, LEVELS, myCoach, upcomingSessions, type Coach, type Programme } from "@/server/academy.ts";
import { ActionForm, Badge, Check, DbDown, Empty, Field, Flash, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";
import { FeatureNotice } from "@/components/feature-notice";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "coach", academyText[lang].workspace, undefined, { noindex: true });
}

function ProfileFields({ lang, c }: { lang: Locale; c?: Coach }) {
  const x = academyText[lang];
  return (
    <>
      <Field label={x.headline}>
        <input name="headline" required minLength={3} maxLength={80} defaultValue={c?.headline} />
      </Field>
      <Field label={x.experienceField}>
        <textarea name="experience" required minLength={20} maxLength={1000} rows={4} defaultValue={c?.experience} />
      </Field>
      <Field label={x.bio}>
        <textarea name="bio" maxLength={1500} rows={3} defaultValue={c?.bio} />
      </Field>
      <div className="stack-sm" role="group" aria-label={x.gamesField}>
        <span className="field-label">{x.gamesField}</span>
        <div className="check-grid">
          {GAMES.map((g) => (
            <Check key={g.slug} name="games" value={g.slug} defaultChecked={c?.games.includes(g.slug)} label={g.name} />
          ))}
        </div>
      </div>
      <div className="form-grid">
        <div className="stack-sm" role="group" aria-label={x.languagesField}>
          <span className="field-label">{x.languagesField}</span>
          {COACH_LANGUAGES.map((l) => (
            <Check key={l} name="languages" value={l} defaultChecked={c ? c.languages.includes(l) : l === lang} label={x.languages[l]} />
          ))}
        </div>
        <div className="stack-sm" role="group" aria-label={x.formatsField}>
          <span className="field-label">{x.formatsField}</span>
          {COACH_FORMATS.map((f) => (
            <Check key={f} name="formats" value={f} defaultChecked={c ? c.formats.includes(f) : f === "online"} label={x.formats[f]} />
          ))}
        </div>
      </div>
      <Field label={x.city}>
        <input name="city" maxLength={80} defaultValue={c?.city} />
      </Field>
      <Check name="accepting" value="1" defaultChecked={c ? c.accepting : true} label={x.acceptingField} />
    </>
  );
}

function ProgrammeFields({ lang, games, p }: { lang: Locale; games: string[]; p?: Programme }) {
  const x = academyText[lang];
  return (
    <>
      <div className="form-grid">
        <Field label={x.title}>
          <input name="title" required minLength={3} maxLength={80} defaultValue={p?.title} />
        </Field>
        <Field label={x.game}>
          <select name="game" defaultValue={p?.game ?? games[0]}>
            {games.map((g) => (
              <option key={g} value={g}>
                {gameBySlug(g)?.name ?? g}
              </option>
            ))}
          </select>
        </Field>
        <Field label={x.level}>
          <select name="level" defaultValue={p?.level ?? "beginner"}>
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {x.levels[l]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={x.format}>
          <select name="format" defaultValue={p?.format ?? "online"}>
            {COACH_FORMATS.map((f) => (
              <option key={f} value={f}>
                {x.formats[f]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={x.sessions}>
          <input name="sessions" type="number" min={1} max={50} required defaultValue={p?.sessions ?? 4} />
        </Field>
        <Field label={x.minutes}>
          <input name="minutes" type="number" min={30} max={240} step={15} required defaultValue={p?.session_minutes ?? 60} />
        </Field>
      </div>
      <Field label={x.description}>
        <textarea name="description" maxLength={2000} rows={3} defaultValue={p?.description} />
      </Field>
    </>
  );
}

/** Coach workspace (MV-ACADEMY-1): profile and its review, programmes, the request queue and sessions. */
export default async function CoachWorkspace({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
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
  const back = `/${lang}/coach`;
  if (!user) redirect(`/${lang}/signin?next=${back}`);
  const mine = await myCoach(db, user.id);
  const [queue, sessions] = mine ? await Promise.all([coachQueue(db, user.id), upcomingSessions(db, user.id)]) : [null, []];
  const c = mine?.coach;
  return (
    <div className="container page">
      <h1>{x.workspace}</h1>
      <p className="lead">{x.workspaceLead}</p>
      <Flash lang={lang} params={sp} />
      <FeatureNotice db={db} lang={lang} feature="academy" />
      <p className="notice small">{x.boundaries}</p>

      <section className="section-tight card stack-sm" id="profile">
        <div className="row-between">
          <h2 className="h3">{x.profile}</h2>
          {c ? <Badge status={c.status === "verified" ? "ok" : c.status === "submitted" ? "info" : c.status === "draft" ? "muted" : "bad"}>{x.statuses[c.status]}</Badge> : null}
        </div>
        {c?.review_note && c.status !== "verified" ? (
          <p className="small">
            <strong>{x.reviewNote}:</strong> {c.review_note}
          </p>
        ) : null}
        {c ? (
          <p className="row small">
            <Link href={`/${lang}/coaches/${c.username}`} className="text-link">
              {x.publicPage}
            </Link>
            {["draft", "rejected", "suspended"].includes(c.status) ? (
              <ActionForm action="coach.submit" lang={lang} back={`${back}#profile`}>
                <button className="btn btn-primary btn-sm">{x.submit}</button>
              </ActionForm>
            ) : null}
          </p>
        ) : null}
        <details className="disclosure" open={!c}>
          <summary>{c ? x.edit : x.becomeCoach}</summary>
          <ActionForm action="coach.save" lang={lang} back={`${back}#profile`} className="stack-sm">
            <ProfileFields lang={lang} c={c} />
            <button className="btn btn-primary btn-sm">{x.save}</button>
          </ActionForm>
        </details>
      </section>

      {mine && c ? (
        <>
          <section className="section-tight stack-sm" id="queue">
            <h2 className="h3">{x.queue}</h2>
            {queue!.pending.length ? (
              <ul className="list">
                {queue!.pending.map((r) => (
                  <li key={r.id} className="stack-sm">
                    <span className="msg-title">
                      <strong>
                        {r.student_name} @{r.student_username}
                      </strong>{" "}
                      · {gameBySlug(r.game)?.name ?? r.game}
                      {r.programme_title ? ` · ${r.programme_title}` : ""} · <LocalTime iso={r.created_at} lang={lang} />
                    </span>
                    <p className="small prewrap">{r.goal}</p>
                    {r.availability ? <p className="small muted">{r.availability}</p> : null}
                    <ActionForm action="training.answer" lang={lang} back={`${back}#queue`} hidden={{ request: r.id }} className="stack-sm">
                      <Field label={x.answerNote}>
                        <input name="note" maxLength={500} />
                      </Field>
                      <div className="row">
                        <button className="btn btn-primary btn-sm" name="decision" value="accept">
                          {x.accept}
                        </button>
                        <button className="btn btn-ghost btn-sm" name="decision" value="decline">
                          {x.decline}
                        </button>
                      </div>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title={x.noQueue} />
            )}
            <h3 className="h4">{x.active}</h3>
            {queue!.active.length ? (
              <ul className="list small">
                {queue!.active.map((r) => (
                  <li key={r.id}>
                    <span className="grow">
                      {r.student_name} @{r.student_username} · {gameBySlug(r.game)?.name ?? r.game}
                      {r.programme_title ? ` · ${r.programme_title}` : ""}
                    </span>
                    <Link href={`/${lang}/training/${r.id}`} className="btn btn-ghost btn-xs">
                      {x.open}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">{x.noActive}</p>
            )}
            {queue!.closed.length ? (
              <details className="disclosure">
                <summary>{x.closed}</summary>
                <ul className="list small">
                  {queue!.closed.map((r) => (
                    <li key={r.id}>
                      <span className="grow">
                        @{r.student_username} · {gameBySlug(r.game)?.name ?? r.game}
                      </span>
                      <Badge status={r.status}>{x.requestStatuses[r.status]}</Badge>
                      <Link href={`/${lang}/training/${r.id}`} className="text-link">
                        {x.open}
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>

          <section className="section-tight stack-sm" id="sessions">
            <h2 className="h3">{x.upcoming}</h2>
            {sessions.length ? (
              <ul className="list small">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <span className="mono">
                      <LocalTime iso={s.starts_at} lang={lang} />
                    </span>
                    <span className="grow">
                      {s.coach_id === user.id ? `@${s.student_username}` : `${x.coach} @${s.coach_username}`} · {s.minutes} min
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

          <section className="section-tight stack-sm" id="programmes">
            <h2 className="h3">{x.programmes}</h2>
            {mine.programmes.length ? (
              <ul className="list">
                {mine.programmes.map((p) => (
                  <li key={p.id} className="stack-sm">
                    <span className="row">
                      <strong className="grow msg-title">{p.title}</strong>
                      <Badge status={p.status === "published" ? "ok" : "muted"}>{x.programmeStatuses[p.status]}</Badge>
                    </span>
                    <span className="small muted">
                      {gameBySlug(p.game)?.name ?? p.game} · {x.levels[p.level]} · {x.formats[p.format]} · {fill(x.sessionsOf, { n: p.sessions, m: p.session_minutes })}
                    </span>
                    <div className="row">
                      {p.status !== "published" && c.status === "verified" ? (
                        <ActionForm action="programme.status" lang={lang} back={`${back}#programmes`} hidden={{ programme: p.id, status: "published" }}>
                          <button className="btn btn-primary btn-xs">{x.publish}</button>
                        </ActionForm>
                      ) : null}
                      {p.status === "published" ? (
                        <ActionForm action="programme.status" lang={lang} back={`${back}#programmes`} hidden={{ programme: p.id, status: "draft" }}>
                          <button className="btn btn-ghost btn-xs">{x.toDraft}</button>
                        </ActionForm>
                      ) : null}
                      {p.status !== "archived" ? (
                        <ActionForm action="programme.status" lang={lang} back={`${back}#programmes`} hidden={{ programme: p.id, status: "archived" }}>
                          <button className="btn btn-ghost btn-xs">{x.archive}</button>
                        </ActionForm>
                      ) : null}
                    </div>
                    <details className="disclosure">
                      <summary>{x.edit}</summary>
                      <ActionForm action="programme.save" lang={lang} back={`${back}#programmes`} hidden={{ programme: p.id }} className="stack-sm">
                        <ProgrammeFields lang={lang} games={c.games} p={p} />
                        <button className="btn btn-ghost btn-sm">{x.save}</button>
                      </ActionForm>
                    </details>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">{x.noProgrammes}</p>
            )}
            <details className="disclosure card" open={!mine.programmes.length}>
              <summary>{x.newProgramme}</summary>
              <ActionForm action="programme.save" lang={lang} back={`${back}#programmes`} className="stack-sm">
                <ProgrammeFields lang={lang} games={c.games} />
                <button className="btn btn-primary btn-sm">{x.save}</button>
              </ActionForm>
            </details>
          </section>
        </>
      ) : null}
    </div>
  );
}
