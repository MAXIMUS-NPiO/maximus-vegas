export type Platform = "pc" | "console" | "mobile";
export type Game = {
  slug: string;
  name: string;
  teamSize: number;
  platforms: Platform[];
  /** Duel brackets (1v1 or team vs team) are supported by the release-1 tournament engine. */
  bracket: boolean;
  scoring?: "racing";
  genre: { ru: string; en: string };
  /** Publisher/API facts that restrict automation. Only confirmed constraints are listed. */
  apiNote?: { ru: string; en: string };
  legacy?: boolean;
};

export const GAMES: Game[] = [
  { slug: "cs2", name: "Counter-Strike 2", teamSize: 5, platforms: ["pc"], bracket: true, genre: { ru: "Тактический шутер", en: "Tactical shooter" }, apiNote: { ru: "Автоматизация серверов, RCON, демо и восстановление матчей проверяется отдельно от интерфейса турнира. До подключения серверного контура результат подтверждается вручную.", en: "Server automation, RCON, demos and match recovery are verified separately from the tournament interface. Until the server contour is connected, results are confirmed manually." } },
  { slug: "lol", name: "League of Legends", teamSize: 5, platforms: ["pc"], bracket: true, genre: { ru: "MOBA", en: "MOBA" } },
  { slug: "valorant", name: "VALORANT", teamSize: 5, platforms: ["pc"], bracket: true, genre: { ru: "Тактический шутер", en: "Tactical shooter" }, apiNote: { ru: "Данные игрока доступны только при одобренном доступе издателя, входе через Riot Sign On и согласии игрока на показ данных.", en: "Player data requires approved publisher access, Riot Sign On and the player's consent to display data." } },
  { slug: "dota2", name: "Dota 2", teamSize: 5, platforms: ["pc"], bracket: true, genre: { ru: "MOBA", en: "MOBA" } },
  { slug: "apex", name: "Apex Legends", teamSize: 3, platforms: ["pc", "console"], bracket: false, genre: { ru: "Королевская битва", en: "Battle royale" } },
  { slug: "pubg", name: "PUBG: Battlegrounds", teamSize: 4, platforms: ["pc", "console"], bracket: false, genre: { ru: "Королевская битва", en: "Battle royale" }, apiNote: { ru: "Официальный PUBG API не создаёт и не управляет custom matches: получение данных отделено от организации лобби. Данные PUBG Mobile через этот API недоступны.", en: "The official PUBG API does not create or manage custom matches: data retrieval is separate from lobby organisation. PUBG Mobile data is not available through this API." } },
  { slug: "rocket-league", name: "Rocket League", teamSize: 3, platforms: ["pc", "console"], bracket: true, genre: { ru: "Спортивная аркада", en: "Sports arcade" } },
  { slug: "fortnite", name: "Fortnite", teamSize: 1, platforms: ["pc", "console", "mobile"], bracket: false, genre: { ru: "Королевская битва", en: "Battle royale" } },
  { slug: "mlbb", name: "Mobile Legends: Bang Bang", teamSize: 5, platforms: ["mobile"], bracket: true, genre: { ru: "Мобильная MOBA", en: "Mobile MOBA" } },
  { slug: "smite2", name: "SMITE 2", teamSize: 5, platforms: ["pc", "console"], bracket: true, genre: { ru: "MOBA", en: "MOBA" } },
  { slug: "deadlock", name: "Deadlock", teamSize: 6, platforms: ["pc"], bracket: true, genre: { ru: "Командный шутер", en: "Team shooter" } },
  { slug: "tf2", name: "Team Fortress 2", teamSize: 6, platforms: ["pc"], bracket: true, genre: { ru: "Командный шутер", en: "Team shooter" } },
  { slug: "trackmania", name: "Trackmania", scoring: "racing", teamSize: 1, platforms: ["pc", "console"], bracket: false, genre: { ru: "Гонки", en: "Racing" } },
  { slug: "brawl-stars", name: "Brawl Stars", teamSize: 3, platforms: ["mobile"], bracket: true, genre: { ru: "Мобильный экшен", en: "Mobile action" } },
  { slug: "cs16", name: "Counter-Strike 1.6", teamSize: 5, platforms: ["pc"], bracket: true, legacy: true, genre: { ru: "Классический шутер", en: "Classic shooter" } },
  { slug: "css", name: "Counter-Strike: Source", teamSize: 5, platforms: ["pc"], bracket: true, legacy: true, genre: { ru: "Классический шутер", en: "Classic shooter" } },
];

export const gameBySlug = (slug: string) => GAMES.find((g) => g.slug === slug);
export const isGame = (slug: unknown): slug is string => typeof slug === "string" && Boolean(gameBySlug(slug));
