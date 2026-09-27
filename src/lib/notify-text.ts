import { dict, fill, type Locale } from "./i18n.ts";

export function notificationText(lang: Locale, kind: string, data: Record<string, string>) {
  const d = dict(lang);
  const template = d.notifications.kinds[kind];
  if (!template) return kind;
  const roleName = data.role ? d.organizer.roles[data.role] ?? data.role : "";
  return fill(template, { ...data, role: roleName });
}

export function notificationLink(lang: Locale, data: Record<string, string>) {
  if (data.matchId) return `/${lang}/matches/${data.matchId}`;
  if (data.slug) return `/${lang}/tournaments/${data.slug}`;
  if (data.teamSlug) return `/${lang}/teams/${data.teamSlug}`;
  if (data.orgSlug) return `/${lang}/organizer/${data.orgSlug}`;
  return `/${lang}/hub`;
}
