import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { GAMES } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { PageHead } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const d = dict(lang);
  return pageMeta(lang, "games", d.games.title, d.games.lead);
}

export default async function Games({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  return (
    <div className="container page">
      <PageHead title={d.games.title} lead={d.games.lead} />
      <div className="grid grid-3">
        {GAMES.map((g) => (
          <Link key={g.slug} href={`/${lang}/games/${g.slug}`} className="card card-link game-card">
            <div className="row-between">
              <h3>{g.name}</h3>
              {g.legacy ? <span className="badge badge-muted">{d.games.legacy}</span> : null}
            </div>
            <p className="muted">{g.genre[lang]}</p>
            <p className="small">
              {g.platforms.map((p) => d.games.platforms[p]).join(" · ")} · {d.games.teamSize}: {g.teamSize === 1 ? d.games.solo : `${g.teamSize}v${g.teamSize}`}
            </p>
            <p className={g.bracket ? "small ok-text" : "small warn-text"}>{g.bracket ? d.games.formatBracket : d.games.formatFfa}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
