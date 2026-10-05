import type { Locale } from "./i18n.ts";
export const formatLabels: Record<string, [string, string]> = {
  single_elimination: ["Олимпийская сетка", "Single elimination"],
  double_elimination: ["До двух поражений", "Double elimination"],
  round_robin: ["Круговой", "Round robin"],
  swiss: ["Швейцарский", "Swiss"],
  groups: ["Группы", "Groups"],
  gauntlet: ["Лесенка", "Gauntlet"],
  ffa: ["Многосторонние лобби", "FFA lobbies"],
  leaderboard: ["Таблица результатов", "Leaderboard"],
};
export const gameModeLabel = (mode: string, lang: Locale) =>
  ({
    head_to_head: ["Матчи между сторонами", "Head-to-head"],
    battle_royale: ["Королевская битва", "Battle royale"],
    racing: ["Гонки", "Racing"],
    other: ["Другой режим", "Other mode"],
  })[mode]?.[lang === "ru" ? 0 : 1] ?? mode;
/** Russian word for a count of players: 21 игрок, 2–4 игрока, 5–20 игроков. Kept here so client bundles stay free of the dictionaries. */
const ruPlayers = (n: number) => {
  const d = n % 10,
    h = n % 100;
  return d === 1 && h !== 11 ? "игрок" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "игрока" : "игроков";
};
/** Roster size is a count of players per entrant, never a match or scoring format. */
export const gameRosterLabel = (g: { teamSize: number }, lang: Locale) =>
  g.teamSize === 1
    ? lang === "ru"
      ? "Один игрок"
      : "Solo"
    : lang === "ru"
      ? `${g.teamSize} ${ruPlayers(g.teamSize)} в составе`
      : `${g.teamSize} players per roster`;
export const gameFormatsLabel = (formats: readonly string[], lang: Locale) =>
  formats.map((f) => formatLabels[f]?.[lang === "ru" ? 0 : 1] ?? f).join(" · ");
