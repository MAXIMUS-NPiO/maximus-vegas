/** Publisher promotional art; provenance is recorded in docs/EXPERIENCE_ASSETS.json. */
export const gameArtwork: Record<string, string> = Object.fromEntries(
  ["cs2", "dota2", "apex", "pubg", "trackmania", "tf2", "deadlock", "cs16", "css", "valorant", "lol", "mlbb", "brawl-stars"].map((slug) => [slug, `/experience/${slug}.jpg`]),
 );
gameArtwork["rocket-league"] = "/experience/rocket-league.webp";
