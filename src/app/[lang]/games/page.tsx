import Link from "next/link";
import Image from "next/image";
import { gameArtwork } from "@/lib/game-artwork";
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
            {gameArtwork[g.slug] ? <Image className="game-catalog-art" src={gameArtwork[g.slug]} alt="" width={460} height={215} sizes="(max-width: 640px) 100vw, 33vw" /> : null}
            <div className="row-between">
              <h3>{g.name}</h3>
              {g.legacy ? <span className="badge badge-muted">{d.games.legacy}</span> : null}
            </div>
            <p className="muted">{g.genre[lang]}</p>
            <p className="small">
              {g.platforms.map((p) => d.games.platforms[p]).join(" · ")} · {d.games.teamSize}: {g.teamSize === 1 ? d.games.solo : g.bracket ? `${g.teamSize}v${g.teamSize}` : d.games.squads.replace("{n}", String(g.teamSize))}
            </p>
            <p className="small ok-text">{g.scoring === "racing" ? d.games.formatRacing : g.bracket ? d.games.formatBracket : d.games.formatFfa}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
