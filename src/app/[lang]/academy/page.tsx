import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, fill, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { GAMES, gameBySlug, isGame } from "@/lib/games.ts";
import { academyText } from "@/lib/academy-text.ts";
import { viewer } from "@/server/viewer.ts";
import { COACH_FORMATS, LEVELS, programmeCatalogue } from "@/server/academy.ts";
import { Badge, DbDown, Empty, Flash, one, PageHead, type SearchParams } from "@/components/ui";
import { ApplicationForm } from "@/components/application-form";
import { FeatureNotice } from "@/components/feature-notice";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "academy", academyText[lang].academy, academyText[lang].academyLead);
}

/** Academy (MV-ACADEMY-1): published programmes of verified coaches, with the boundaries of the service. */
export default async function Academy({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const x = academyText[lang];
  const d = dict(lang);
  const sp = await searchParams;
  const game = isGame(one(sp.game)) ? one(sp.game) : "";
  const level = (LEVELS as readonly string[]).includes(one(sp.level)) ? one(sp.level) : "";
  const format = (COACH_FORMATS as readonly string[]).includes(one(sp.format)) ? one(sp.format) : "";
  const { db, user, dbError } = await viewer();
  const list = db ? await programmeCatalogue(db, { game, level, format }) : [];
  return (
    <div className="container page">
      <PageHead title={x.academy} lead={x.academyLead}>
        <Link href={`/${lang}/coaches`} className="btn btn-ghost btn-sm">
          {x.coaches}
        </Link>
      </PageHead>
      <Flash lang={lang} params={sp} />
      <FeatureNotice db={db} lang={lang} feature="academy" />
      <p className="notice small">{x.boundaries}</p>
      {dbError ? (
        <DbDown lang={lang} />
      ) : (
        <section className="section-tight stack-sm">
          <h2 className="h3">{x.programmes}</h2>
          <form method="get" action={`/${lang}/academy`} className="inline-form toolbar">
            <select name="game" defaultValue={game} aria-label={x.game}>
              <option value="">{x.allGames}</option>
              {GAMES.map((g) => (
                <option key={g.slug} value={g.slug}>
                  {g.name}
                </option>
              ))}
            </select>
            <select name="level" defaultValue={level} aria-label={x.level}>
              <option value="">{x.anyLevel}</option>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {x.levels[l]}
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
              {list.map((p) => (
                <Link key={p.id} href={`/${lang}/coaches/${p.username}#programme-${p.id}`} className="card card-link stack-sm">
                  <p className="eyebrow">
                    {gameBySlug(p.game)?.name ?? p.game} · {x.levels[p.level]}
                  </p>
                  <h3 className="msg-title">{p.title}</h3>
                  <p className="small muted">
                    {p.display_name} · {x.formats[p.format]} · {fill(x.sessionsOf, { n: p.sessions, m: p.session_minutes })}
                  </p>
                  {p.accepting ? <Badge status="ok">{x.accepting}</Badge> : <Badge status="muted">{x.notAccepting}</Badge>}
                </Link>
              ))}
            </div>
          ) : (
            <Empty title={x.noProgrammes} />
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
        <ApplicationForm lang={lang} back={`/${lang}/academy`} kinds={["academy", "school"]} user={user} title={d.partners.apply} />
      </section>
    </div>
  );
}
