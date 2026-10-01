import { dict, fill, type Locale } from "./i18n.ts";

export function notificationText(lang: Locale, kind: string, data: Record<string, string>) {
  const d = dict(lang);
  const template = d.notifications.kinds[kind];
  if (!template) return kind;
  const roleName = data.role ? d.organizer.roles[data.role] ?? data.role : "";
  return fill(template, { ...data, role: roleName });
}

export function notificationLink(lang: Locale, data: Record<string, string>) {
  if (data.messageId) return `/${lang}/messages/${data.messageId}`;
  if (data.matchId) return `/${lang}/matches/${data.matchId}`;
  if (data.lobbyId) return `/${lang}/lobbies/${data.lobbyId}`;
  if (data.slug) return `/${lang}/tournaments/${data.slug}`;
  if (data.teamSlug) return `/${lang}/teams/${data.teamSlug}`;
  if (data.clanSlug) return `/${lang}/clans/${data.clanSlug}`;
  if (data.clans) return `/${lang}/clans#invites`;
  if (data.passes) return `/${lang}/passes`;
  if (data.adminTab) return `/${lang}/admin?tab=${data.adminTab}`;
  if (data.orgSlug) return `/${lang}/organizer/${data.orgSlug}`;
  if (data.circuitSlug) return `/${lang}/circuits/${data.circuitSlug}`;
  if (data.quick) return `/${lang}/matchmaking`;
  if (data.conductAdmin) return `/${lang}/admin?tab=conduct`;
  if (data.conduct) return `/${lang}/conduct`;
  if (data.profile) return `/${lang}/players/${data.profile}`;
  if (data.finder) return `/${lang}/finder#mine`;
  return `/${lang}/hub`;
}
