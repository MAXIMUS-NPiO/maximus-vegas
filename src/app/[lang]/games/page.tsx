import Link from "next/link";
import Image from "next/image";
import { gameArtwork } from "@/lib/game-artwork";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { publicGames } from "@/server/catalog.ts";
import { viewer } from "@/server/viewer.ts";
import { gameModeLabel, gameRosterLabel, gameFormatsLabel } from "@/lib/catalog-labels.ts";
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
  const games=await publicGames((await viewer()).db);
  return (
    <div className="container page">
      <PageHead title={d.games.title} lead={d.games.lead} />
      <div className="grid grid-3">
        {games.map((g) => (
          <Link key={g.slug} href={`/${lang}/games/${g.slug}`} className="card card-link game-card">
            {gameArtwork[g.slug] ? <Image className="game-catalog-art" src={gameArtwork[g.slug]} alt="" width={460} height={215} sizes="(max-width: 640px) 100vw, 33vw" /> : null}
            <div className="row-between">
              <h3>{g.name}</h3>
              {g.legacy ? <span className="badge badge-muted">{d.games.legacy}</span> : null}
            </div>
            <p className="muted">{g.genre[lang]}</p>
            <p className="small">
              {g.platforms.map((p) => d.games.platforms[p]).join(" · ")} · {d.games.teamSize}: {gameRosterLabel(g,lang)}
            </p>
            <p className="small ok-text">{gameModeLabel(g.mode,lang) + " · " + gameFormatsLabel(g.formats,lang)}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
