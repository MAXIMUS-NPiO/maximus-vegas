export const EXPERIENCE_PROVIDERS = ["steam", "opendota", "faceit"] as const;
export type ExperienceProvider = typeof EXPERIENCE_PROVIDERS[number];
export type ExperienceStatus = "pending" | "available" | "private" | "unavailable" | "error" | "stale";
export type ExperienceMatch = { id: string; playedAt: string; sourceUrl: string; result?: "win" | "loss"; metrics: Record<string, number> };
export type ExperienceRecord = {
  game: string;
  sourceUrl: string;
  rank: string | null;
  rankCode?: number;
  metrics: Record<string, number>;
  recentMatches: ExperienceMatch[];
};
export type ExperienceConnection = {
  id: string;
  provider: ExperienceProvider;
  externalId: string | null;
  displayName: string;
  status: ExperienceStatus;
  issue: string;
  shared: boolean;
  verifiedAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextSyncAt: string;
  records: ExperienceRecord[];
};
export type PartnerExperienceRecord = { id: string; source: string; game: string; matchRef: string; playedAt: string; metrics: Record<string, number>; sourceUrl: string };
export type ProfileExperience = {
  connections: ExperienceConnection[];
  partnerRecords: PartnerExperienceRecord[];
  steamIdentity: { steamId: string; verifiedAt: string } | null;
  canManage: boolean;
  sharePartner: boolean;
  hasImportedExperience: boolean;
};
export type ExperienceAvailability = { provider: ExperienceProvider; available: boolean; reason: "ready" | "site_not_configured" | "provider_not_configured" | "disabled" };
export const EXPERIENCE_STALE_MS = 72 * 60 * 60 * 1000;
export function isExperienceProvider(value: unknown): value is ExperienceProvider {
  return typeof value === "string" && (EXPERIENCE_PROVIDERS as readonly string[]).includes(value);
}
export function hasExperience(records: ExperienceRecord[]) {
  return records.some(r => Boolean(r.rank) || r.recentMatches.length > 0 || Object.values(r.metrics).some(n => n > 0));
}
/** OpenDota's documented rank-tier encoding, never an XP or cross-game conversion. */
export function dotaRankName(code: unknown, lang: "ru" | "en" = "en"): string | null {
  if (typeof code !== "number" || !Number.isInteger(code)) return null;
  if (code === 80) return lang === "ru" ? "Титан" : "Immortal";
  const medal = Math.floor(code / 10), star = code % 10;
  if (medal < 1 || medal > 7 || star > 5 || star < 0) return null;
  const names = lang === "ru" ? ["", "Рекрут", "Страж", "Рыцарь", "Герой", "Легенда", "Властелин", "Божество"] : ["", "Herald", "Guardian", "Crusader", "Archon", "Legend", "Ancient", "Divine"];
  return `${names[medal]}${star ? ` ${["", "I", "II", "III", "IV", "V"][star]}` : ""}`;
}
