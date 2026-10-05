import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { publicGames } from "@/server/catalog.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { listTeams } from "@/server/queries.ts";
import { DbDown, Empty, Flash, one, PageHead, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "teams", dict(lang).teams.title, dict(lang).teams.lead);
}

export default async function Teams({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  const games=await publicGames(db,true);
  const game=games.some(g=>g.slug===one(sp.game))?one(sp.game):undefined;
  const list = db ? await listTeams(db, game).catch(() => []) : [];
  return (
    <div className="container page">
      <PageHead title={d.teams.title} lead={d.teams.lead}>
        {user && <Link href={`/${lang}/my-teams`} className="btn btn-secondary btn-sm">{lang === "ru" ? "Мои команды и приглашения" : "My teams & invitations"}</Link>}
        <Link href={`/${lang}/teams/new`} className="btn btn-primary btn-sm">
          {d.teams.create}
        </Link>
      </PageHead>
      <Flash lang={lang} params={sp} />
      <form method="get" className="inline-form toolbar">
        <select name="game" defaultValue={game ?? ""} aria-label={d.teams.game}>
          <option value="">{d.tournaments.anyGame}</option>
          {games.map((g) => (
            <option key={g.slug} value={g.slug}>
              {g.name}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost btn-sm">{d.common.search}</button>
      </form>
      {dbError ? (
        <DbDown lang={lang} />
      ) : list.length ? (
        <div className="grid grid-3">
          {list.map((t) => (
            <Link key={t.slug} href={`/${lang}/teams/${t.slug}`} className="card card-link">
              <div className="row-between">
                <h3>{t.name}</h3>
                {t.tag ? <span className="badge badge-muted">{t.tag}</span> : null}
              </div>
              <p className="muted small">{games.find(g=>g.slug===t.game)?.name ?? t.game}</p>
              <p className="small">
                {d.teams.members}: {t.members} · {t.wins} {d.teams.wins}
              </p>
            </Link>
          ))}
        </div>
      ) : (
        <Empty
          title={d.teams.empty}
          action={
            <Link href={`/${lang}/teams/new`} className="btn btn-primary btn-sm">
              {d.teams.create}
            </Link>
          }
        />
      )}
    </div>
  );
}
