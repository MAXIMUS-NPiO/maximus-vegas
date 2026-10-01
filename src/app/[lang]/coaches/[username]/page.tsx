import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fill, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { gameBySlug } from "@/lib/games.ts";
import { academyText } from "@/lib/academy-text.ts";
import { viewer } from "@/server/viewer.ts";
import { coachByUsername, studentRequests } from "@/server/academy.ts";
import { ActionForm, Badge, DbDown, Field, Flash, SignInPrompt, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";
import { FeatureNotice } from "@/components/feature-notice";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; username: string }> }): Promise<Metadata> {
  const { lang, username } = await params;
  if (!isLocale(lang)) return {};
  const { db } = await viewer();
  const data = db ? await coachByUsername(db, username, null).catch(() => null) : null;
  return pageMeta(lang, `coaches/${username}`, data ? `${data.coach.display_name} — ${academyText[lang].coaches}` : academyText[lang].coaches, data?.coach.headline, {
    noindex: !data,
  });
}

/** A coach's page (MV-ACADEMY-1): verified experience, programmes and the training request form. */
export default async function CoachPage({ params, searchParams }: { params: Promise<{ lang: string; username: string }>; searchParams: SearchParams }) {
  const { lang, username } = await params;
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
  const data = await coachByUsername(db, username, user);
  if (!data) notFound();
  const { coach: c, programmes, own } = data;
  const back = `/${lang}/coaches/${c.username}`;
  const existing = user && !own ? (await studentRequests(db, user.id)).find((r) => r.coach_id === c.user_id && ["pending", "accepted"].includes(r.status)) : undefined;
  return (
    <div className="container page">
      <p className="eyebrow">
        <Link href={`/${lang}/coaches`}>{x.coaches}</Link> · {c.games.map((g) => gameBySlug(g)?.name ?? g).join(" · ")}
      </p>
      <h1>
        {c.display_name} {c.status !== "verified" ? <Badge status="warn">{x.statuses[c.status]}</Badge> : null}
      </h1>
      <Flash lang={lang} params={sp} />
      <FeatureNotice db={db} lang={lang} feature="academy" />
      <p className="lead">{c.headline}</p>
      <p className="row small">
        {c.status === "verified" && c.verified_at ? (
          <Badge status="ok">
            {x.verified} · <LocalTime iso={c.verified_at} lang={lang} dateOnly />
          </Badge>
        ) : null}
        {c.accepting ? <Badge status="ok">{x.accepting}</Badge> : <Badge status="muted">{x.notAccepting}</Badge>}
        <span className="muted">
          {c.formats.map((f) => x.formats[f]).join(", ")} · {c.languages.map((l) => x.languages[l]).join(", ")}
          {c.city ? ` · ${c.city}` : ""}
        </span>
      </p>
      {c.bio ? <p className="prewrap">{c.bio}</p> : null}
      <section className="section-tight">
        <h2 className="h3">{x.experience}</h2>
        <p className="prewrap">{c.experience}</p>
      </section>
      <section className="section-tight stack-sm">
        <h2 className="h3">{x.programmes}</h2>
        {programmes.length ? (
          <div className="grid grid-2">
            {programmes.map((p) => (
              <div key={p.id} className="card stack-sm" id={`programme-${p.id}`}>
                <p className="eyebrow">
                  {gameBySlug(p.game)?.name ?? p.game} · {x.levels[p.level]} · {x.formats[p.format]}
                </p>
                <h3 className="msg-title">
                  {p.title} {p.status !== "published" ? <Badge status="muted">{x.programmeStatuses[p.status]}</Badge> : null}
                </h3>
                <p className="small muted">{fill(x.sessionsOf, { n: p.sessions, m: p.session_minutes })}</p>
                {p.description ? <p className="small prewrap">{p.description}</p> : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="small muted">{x.noProgrammes}</p>
        )}
      </section>
      <section className="section-tight card stack-sm" id="request">
        <h2 className="h3">{x.requestTitle}</h2>
        <p className="small muted">{x.boundaries}</p>
        {own ? (
          <p className="small">
            {x.ownProfile}{" "}
            <Link href={`/${lang}/coach`} className="text-link">
              {x.workspace}
            </Link>
          </p>
        ) : !user ? (
          <SignInPrompt lang={lang} back={`${back}#request`} />
        ) : existing ? (
          <p className="small">
            {x.existing}{" "}
            <Link href={`/${lang}/training/${existing.id}`} className="text-link">
              {x.open}
            </Link>
          </p>
        ) : c.status !== "verified" || !c.accepting ? (
          <p className="small">{x.notAccepting}</p>
        ) : (
          <ActionForm action="training.request" lang={lang} back={`${back}#request`} hidden={{ coach: c.user_id }} className="stack-sm">
            <p className="small muted">{x.requestLead}</p>
            <div className="form-grid">
              <Field label={x.programme}>
                <select name="programme" defaultValue="">
                  <option value="">{x.noProgramme}</option>
                  {programmes
                    .filter((p) => p.status === "published")
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label={x.game}>
                <select name="game" defaultValue={c.games[0]}>
                  {c.games.map((g) => (
                    <option key={g} value={g}>
                      {gameBySlug(g)?.name ?? g}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label={x.goal}>
              <textarea name="goal" required minLength={10} maxLength={1000} rows={4} />
            </Field>
            <Field label={x.availability}>
              <input name="availability" maxLength={300} />
            </Field>
            <button className="btn btn-primary btn-sm">{x.send}</button>
          </ActionForm>
        )}
      </section>
    </div>
  );
}
