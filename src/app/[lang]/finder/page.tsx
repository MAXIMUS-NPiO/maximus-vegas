import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { GAMES, gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { finderText } from "@/lib/finder-text.ts";
import { viewer } from "@/server/viewer.ts";
import { applicationsToDecide, FINDER_KINDS, ledTeams, listPosts, memberTeamIds, myFinder, pendingPostIds, type FinderKind } from "@/server/finder.ts";
import { ActionForm, Badge, DbDown, Empty, Field, Flash, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";
import { PostCard } from "@/components/finder-post";
import { FeatureNotice } from "@/components/feature-notice";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "finder", finderText[lang].title, finderText[lang].lead);
}

const one = (x: string | string[] | undefined) => (Array.isArray(x) ? x[0] : x) ?? "";

export default async function Finder({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const x = finderText[lang];
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  const kind = ((FINDER_KINDS as readonly string[]).includes(one(sp.kind)) ? one(sp.kind) : "vacancy") as FinderKind;
  const game = gameBySlug(one(sp.game)) ? one(sp.game) : "";
  const region = one(sp.region).slice(0, 40);
  const [posts, teams, memberOf, pending, mine, toDecide] = await Promise.all([
    listPosts(db, { kind, game, region }),
    user ? ledTeams(db, user.id) : Promise.resolve([]),
    user ? memberTeamIds(db, user.id) : Promise.resolve([]),
    user ? pendingPostIds(db, user.id) : Promise.resolve(new Set<string>()),
    user ? myFinder(db, user.id) : Promise.resolve(null),
    user ? applicationsToDecide(db, user.id) : Promise.resolve([]),
  ]);
  const back = `/${lang}/finder?kind=${kind}${game ? `&game=${game}` : ""}${region ? `&region=${encodeURIComponent(region)}` : ""}`;
  const mineBack = `/${lang}/finder?kind=${kind}#mine`;
  const tab = (k: FinderKind) => `/${lang}/finder?kind=${k}${game ? `&game=${game}` : ""}${region ? `&region=${encodeURIComponent(region)}` : ""}`;
  return (
    <div className="container page">
      <h1>{x.title}</h1>
      <p className="lead">{x.lead}</p>
      <Flash lang={lang} params={sp} />
      <FeatureNotice db={db} lang={lang} feature="finder" />
      <nav className="tabs finder-tabs" aria-label={x.title}>
        {FINDER_KINDS.map((k) => (
          <Link key={k} href={tab(k)} className={`tab${k === kind ? " is-active" : ""}`} aria-current={k === kind ? "page" : undefined}>
            {x.tabs[k]}
          </Link>
        ))}
      </nav>
      <form method="get" action={`/${lang}/finder`} className="inline-form finder-filter">
        <input type="hidden" name="kind" value={kind} />
        <select name="game" defaultValue={game} aria-label={x.game}>
          <option value="">{x.allGames}</option>
          {GAMES.map((g) => (
            <option key={g.slug} value={g.slug}>
              {g.name}
            </option>
          ))}
        </select>
        <input name="region" defaultValue={region} maxLength={40} placeholder={x.region} aria-label={x.region} />
        <button className="btn btn-ghost btn-sm">{x.show}</button>
      </form>
      {posts.length ? (
        <div className="grid grid-2">
          {posts.map((p) => (
            <PostCard key={p.id} lang={lang} p={p} viewer={user} teams={teams} memberOf={memberOf} applied={pending.has(p.id)} moderator={Boolean(user?.roles.includes("admin"))} back={back} />
          ))}
        </div>
      ) : (
        <Empty title={x.empty} />
      )}

      <section className="section-tight" id="mine">
        <h2 className="h3">{x.mine}</h2>
        {user && mine ? (
          <div className="stack">
            <details className="disclosure card" open={!mine.posts.length && !toDecide.length && !mine.applications.length}>
              <summary>{x.newPost}</summary>
              <ActionForm action="finder.post" lang={lang} back={mineBack} className="stack-sm">
                <div className="form-grid">
                  <Field label={x.kind}>
                    <select name="kind" defaultValue={kind === "lfg" ? "lfg" : "lft"}>
                      <option value="lft">{x.kindLft}</option>
                      <option value="lfg">{x.kindLfg}</option>
                    </select>
                  </Field>
                  <Field label={x.game}>
                    <select name="game" defaultValue={game || GAMES[0].slug} required>
                      {GAMES.map((g) => (
                        <option key={g.slug} value={g.slug}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={x.region}>
                    <input name="region" maxLength={40} />
                  </Field>
                  <Field label={x.roles}>
                    <input name="roles" maxLength={80} />
                  </Field>
                  <Field label={x.languages}>
                    <input name="languages" maxLength={60} />
                  </Field>
                  <Field label={x.level}>
                    <input name="level" maxLength={60} />
                  </Field>
                </div>
                <Field label={x.schedule}>
                  <input name="schedule" maxLength={80} />
                </Field>
                <Field label={x.note} hint={x.replaceNote}>
                  <textarea name="note" rows={3} maxLength={500} />
                </Field>
                <button className="btn btn-primary btn-sm">{x.publish}</button>
              </ActionForm>
            </details>

            {toDecide.length ? (
              <div className="stack-sm">
                <h3 className="h4">{x.toDecide}</h3>
                <ul className="list">
                  {toDecide.map((a) => (
                    <li key={a.id} className="stack-sm">
                      <span className="grow">
                        <Link href={`/${lang}/players/${a.username}`}>{a.display_name}</Link> <span className="small muted">@{a.username}</span>
                        {a.message ? <span className="small prewrap"> — {a.message}</span> : null}
                      </span>
                      <span className="row">
                        <ActionForm action="finder.decide" lang={lang} back={mineBack} hidden={{ application: a.id, accept: "1" }}>
                          <button className="btn btn-primary btn-xs">{x.accept}</button>
                        </ActionForm>
                        <ActionForm action="finder.decide" lang={lang} back={mineBack} hidden={{ application: a.id, accept: "0" }}>
                          <button className="btn btn-ghost btn-xs">{x.decline}</button>
                        </ActionForm>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="stack-sm">
              <h3 className="h4">{x.myPosts}</h3>
              {mine.posts.length ? (
                <div className="grid grid-2">
                  {mine.posts.map((p) => (
                    <PostCard key={p.id} lang={lang} p={p} viewer={user} teams={teams} memberOf={memberOf} back={mineBack} />
                  ))}
                </div>
              ) : (
                <p className="small muted">{x.noPosts}</p>
              )}
            </div>

            <div className="stack-sm">
              <h3 className="h4">{x.myApplications}</h3>
              {mine.applications.length ? (
                <ul className="list">
                  {mine.applications.map((a) => (
                    <li key={a.id}>
                      <span className="grow small">
                        {x.kindShort[a.kind]} · {gameBySlug(a.game)?.name ?? a.game} ·{" "}
                        {a.team_slug ? <Link href={`/${lang}/teams/${a.team_slug}`}>{a.team_name}</Link> : <Link href={`/${lang}/players/${a.author}`}>@{a.author}</Link>} ·{" "}
                        <LocalTime iso={a.created_at} lang={lang} dateOnly />
                      </span>
                      <span className="row">
                        <Badge status={a.status === "accepted" ? "works" : a.status === "pending" ? "dev" : "completed"}>{x.statuses[a.status]}</Badge>
                        {a.status === "pending" ? (
                          <ActionForm action="finder.withdraw" lang={lang} back={mineBack} hidden={{ application: a.id }}>
                            <button className="btn btn-ghost btn-xs">{x.withdraw}</button>
                          </ActionForm>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">{x.noApplications}</p>
              )}
            </div>
          </div>
        ) : (
          <p className="muted">
            <Link href={`/${lang}/signin?next=${encodeURIComponent(`/${lang}/finder`)}`} className="text-link">
              {d.nav.signIn}
            </Link>{" "}
            — {x.signIn}
          </p>
        )}
      </section>
    </div>
  );
}
