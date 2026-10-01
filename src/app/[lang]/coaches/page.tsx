import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { GAMES, gameBySlug, isGame } from "@/lib/games.ts";
import { academyText } from "@/lib/academy-text.ts";
import { viewer } from "@/server/viewer.ts";
import { COACH_FORMATS, COACH_LANGUAGES, coachDirectory } from "@/server/academy.ts";
import { Badge, DbDown, Empty, Flash, one, PageHead, type SearchParams } from "@/components/ui";
import { ApplicationForm } from "@/components/application-form";
import { FeatureNotice } from "@/components/feature-notice";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "coaches", academyText[lang].coaches, academyText[lang].coachesLead);
}

/** Coach directory (MV-ACADEMY-1): coaches whose experience the portal team has verified. */
export default async function Coaches({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const x = academyText[lang];
  const d = dict(lang);
  const sp = await searchParams;
  const game = isGame(one(sp.game)) ? one(sp.game) : "";
  const language = (COACH_LANGUAGES as readonly string[]).includes(one(sp.language)) ? one(sp.language) : "";
  const format = (COACH_FORMATS as readonly string[]).includes(one(sp.format)) ? one(sp.format) : "";
  const { db, user, dbError } = await viewer();
  const list = db ? await coachDirectory(db, { game, language, format }) : [];
  return (
    <div className="container page">
      <PageHead title={x.coaches} lead={x.coachesLead}>
        <Link href={`/${lang}/academy`} className="btn btn-ghost btn-sm">
          {x.programmes}
        </Link>
      </PageHead>
      <Flash lang={lang} params={sp} />
      <FeatureNotice db={db} lang={lang} feature="academy" />
      <p className="notice small">{x.boundaries}</p>
      {dbError ? (
        <DbDown lang={lang} />
      ) : (
        <section className="section-tight stack-sm">
          <form method="get" action={`/${lang}/coaches`} className="inline-form toolbar">
            <select name="game" defaultValue={game} aria-label={x.game}>
              <option value="">{x.allGames}</option>
              {GAMES.map((g) => (
                <option key={g.slug} value={g.slug}>
                  {g.name}
                </option>
              ))}
            </select>
            <select name="language" defaultValue={language} aria-label={x.languagesField}>
              <option value="">{x.anyLanguage}</option>
              {COACH_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {x.languages[l]}
                </option>
              ))}
            </select>
            <select name="format" defaultValue={format} aria-label={x.format}>
              <option value="">{x.anyFormat}</option>
              {COACH_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {x.formats[f]}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost btn-sm">{x.show}</button>
          </form>
          {list.length ? (
            <div className="grid grid-3">
              {list.map((c) => (
                <Link key={c.user_id} href={`/${lang}/coaches/${c.username}`} className="card card-link stack-sm">
                  <p className="eyebrow">{c.games.map((g) => gameBySlug(g)?.name ?? g).join(" · ")}</p>
                  <h3 className="msg-title">{c.display_name}</h3>
                  <p className="small">{c.headline}</p>
                  <p className="small muted">
                    {c.formats.map((f) => x.formats[f]).join(", ")} · {c.languages.map((l) => x.languages[l]).join(", ")}
                    {c.city ? ` · ${c.city}` : ""}
                  </p>
                  {c.accepting ? <Badge status="ok">{x.accepting}</Badge> : <Badge status="muted">{x.notAccepting}</Badge>}
                </Link>
              ))}
            </div>
          ) : (
            <Empty title={x.noCoaches} />
          )}
        </section>
      )}
      <section className="section-tight split">
        <div className="stack-sm">
          <h2 className="h3">{x.becomeCoach}</h2>
          <p className="small muted">{x.workspaceLead}</p>
          <p>
            <Link href={`/${lang}/coach`} className="btn btn-ghost btn-sm">
              {x.workspace}
            </Link>
          </p>
        </div>
        <ApplicationForm lang={lang} back={`/${lang}/coaches`} kinds={["coach"]} user={user} title={d.partners.apply} />
      </section>
    </div>
  );
}
