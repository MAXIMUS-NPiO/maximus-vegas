import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site.ts";
import { GAMES } from "@/lib/games.ts";
import { DIRECTIONS } from "@/lib/directions.ts";

const PUBLIC = ["", "tournaments", "circuits", "games", "rankings", "players", "teams", "clans", "ladders", "finder", "matchmaking", "membership", "partners", "developers", "organizer", "innovations", "trust", "help", "contact", "status", "terms", "privacy", "explore"];

/** Direction pages that became signed-in sections send guests to sign-in, so they stay out of the public map. */
const SIGNED_IN_ONLY = new Set(["community"]);

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin() ?? "https://www.maximus.vegas";
  const paths = [...PUBLIC, ...GAMES.map((g) => `games/${g.slug}`), ...DIRECTIONS.map((d) => d.slug).filter((slug) => !SIGNED_IN_ONLY.has(slug))];
  return paths.flatMap((p) =>
    (["ru", "en"] as const).map((lang) => {
      const suffix = p ? `/${p}` : "";
      return {
        url: `${origin}/${lang}${suffix}`,
        alternates: { languages: { ru: `${origin}/ru${suffix}`, en: `${origin}/en${suffix}` } },
      };
    }),
  );
}
