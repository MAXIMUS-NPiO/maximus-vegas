/**
 * MV-MEDIA-1: stream and recording links — which platform a link belongs to, and whether the portal can
 * play it itself after the viewer clicks (Twitch channels and YouTube videos). Only https links without
 * credentials or ports are accepted. Nothing here contacts the platforms.
 */
export const PLATFORMS = ["twitch", "youtube", "kick", "vk", "other"] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Embed = { kind: "twitch"; channel: string } | { kind: "youtube"; id: string };
export type ParsedStream = { url: string; platform: Platform; embed: Embed | null };

/** First path segments of twitch.tv that are pages, not channels. */
const TWITCH_PAGES = new Set(["videos", "directory", "p", "settings", "downloads", "jobs", "turbo", "subscriptions", "inventory", "wallet", "search", "login", "signup"]);

export function parseStreamUrl(input: unknown): ParsedStream | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw || raw.length > 500) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  const url = u.toString();
  if (host === "twitch.tv") {
    const first = parts[0] ?? "";
    const channel = parts.length === 1 && /^[a-z0-9_]{3,25}$/i.test(first) && !TWITCH_PAGES.has(first.toLowerCase()) ? first.toLowerCase() : null;
    return { url, platform: "twitch", embed: channel ? { kind: "twitch", channel } : null };
  }
  if (host === "clips.twitch.tv") return { url, platform: "twitch", embed: null };
  if (host === "youtube.com" || host === "youtu.be") {
    let id: string | null = null;
    if (host === "youtu.be") id = parts[0] ?? null;
    else if (parts[0] === "watch") id = u.searchParams.get("v");
    else if (parts[0] === "live" || parts[0] === "embed" || parts[0] === "shorts") id = parts[1] ?? null;
    return { url, platform: "youtube", embed: id && /^[A-Za-z0-9_-]{11}$/.test(id) ? { kind: "youtube", id } : null };
  }
  if (host === "kick.com") return { url, platform: "kick", embed: null };
  if (host === "vk.com" || host === "vk.ru" || host === "vkvideo.ru" || host.endsWith(".vkvideo.ru")) return { url, platform: "vk", embed: null };
  return { url, platform: "other", embed: null };
}

/** Player address for a link the portal can play; `host` is the portal's own host name (Twitch requires it). */
export function embedSrc(embed: Embed, host: string): string {
  if (embed.kind === "twitch") return `https://player.twitch.tv/?channel=${encodeURIComponent(embed.channel)}&parent=${encodeURIComponent(host)}&autoplay=true`;
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(embed.id)}?autoplay=1`;
}

export const platformName: Record<Platform, { ru: string; en: string }> = {
  twitch: { ru: "Twitch", en: "Twitch" },
  youtube: { ru: "YouTube", en: "YouTube" },
  kick: { ru: "Kick", en: "Kick" },
  vk: { ru: "VK Видео", en: "VK Video" },
  other: { ru: "Ссылка", en: "Link" },
};
