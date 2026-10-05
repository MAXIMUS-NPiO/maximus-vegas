import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { publicGames } from "@/server/catalog.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { listTournaments } from "@/server/queries.ts";
import { DbDown, Empty, Flash, one, PageHead, type SearchParams } from "@/components/ui";
import { TournamentCard } from "@/components/tournament";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const d = dict(lang);
  return pageMeta(lang, "tournaments", d.tournaments.title, d.tournaments.lead);
}

const FILTERS = ["all", "open", "live", "upcoming", "completed"] as const;

export default async function Tournaments({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const sp = await searchParams;
  const filter = (FILTERS as readonly string[]).includes(one(sp.f)) ? (one(sp.f) as (typeof FILTERS)[number]) : "all";
  const { db, dbError } = await viewer();
  const games=await publicGames(db,true);
  const game = games.some(g=>g.slug===one(sp.game)) ? one(sp.game) : undefined;
  const list = db ? await listTournaments(db, { filter, game, limit: 90 }).catch(() => []) : [];
  const href = (f: string, g?: string) => {
    const q = new URLSearchParams();
    if (f !== "all") q.set("f", f);
    if (g) q.set("game", g);
    const s = q.toString();
    return `/${lang}/tournaments${s ? `?${s}` : ""}`;
  };
  return (
    <div className="container page">
      <PageHead title={d.tournaments.title} lead={d.tournaments.lead}>
        <Link href={`/${lang}/organizer`} className="btn btn-ghost btn-sm">
          {d.tournaments.create}
        </Link>
      </PageHead>
      <Flash lang={lang} params={sp} />
      <div className="toolbar">
        <nav className="chips" aria-label={d.tournaments.title}>
          {FILTERS.map((f) => (
            <Link key={f} href={href(f, game)} className={f === filter ? "chip is-active" : "chip"} aria-current={f === filter ? "page" : undefined}>
              {d.tournaments.filters[f]}
            </Link>
          ))}
        </nav>
        <form method="get" className="inline-form">
          {filter !== "all" ? <input type="hidden" name="f" value={filter} /> : null}
          <label className="sr-only" htmlFor="game-filter">
            {d.tournaments.game}
          </label>
          <select id="game-filter" name="game" defaultValue={game ?? ""}>
            <option value="">{d.tournaments.anyGame}</option>
            {games.map((g) => (
              <option key={g.slug} value={g.slug}>
                {g.name}
              </option>
            ))}
          </select>
          <button className="btn btn-ghost btn-sm" type="submit">
            {d.common.search}
          </button>
        </form>
      </div>
      {dbError ? (
        <DbDown lang={lang} />
      ) : list.length ? (
        <div className="grid grid-3">
          {list.map((x) => (
            <TournamentCard key={x.id} lang={lang} t={x} />
          ))}
        </div>
      ) : (
        <Empty
          title={d.tournaments.empty}
          action={
            <Link href={`/${lang}/organizer`} className="btn btn-primary btn-sm">
              {d.tournaments.create}
            </Link>
          }
        />
      )}
    </div>
  );
}
