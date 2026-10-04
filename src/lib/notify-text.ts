import { dict, fill, type Locale } from "./i18n.ts";

export function notificationText(lang: Locale, kind: string, data: Record<string, string>) {
  if(kind === "clan_relationship") return lang === "ru" ? "Новое предложение союза или соперничества для вашего клана" : "A new alliance or rivalry proposal for your clan";
  if(kind === "community_report") return lang === "ru" ? "Новое сообщение сообщества на проверке" : "New community message report";
  if(kind === "community_host_review") return lang === "ru" ? "Новая заявка ведущего или специалиста на проверке" : "New host or practitioner application";
  if(kind === "community_host_decision") return lang === "ru" ? "Решение по вашей карточке сообщества" : "Your community profile review decision";
  if(kind === "community_friend_request") return lang === "ru" ? `@${data.by} хочет добавить вас в друзья` : `@${data.by} sent you a friend request`;
  if(kind === "community_friend_accepted") return lang === "ru" ? `@${data.by} принял(а) вашу заявку в друзья` : `@${data.by} accepted your friend request`;
  if(kind === "social_call") return lang === "ru" ? "Входящий звонок в переписке по взаимному согласию" : "Incoming call in a mutual conversation";
  if(kind === "arbitration_updated") return lang === "ru" ? "Обновление арбитражного дела" : "Arbitration case updated";
  if(kind === "marketplace_updated") return lang === "ru" ? "Обновление тестовой сделки" : "Test transaction updated";
  const d = dict(lang);
  const template = d.notifications.kinds[kind];
  if (!template) return kind;
  const roleName = data.role ? d.organizer.roles[data.role] ?? data.role : "";
  return fill(template, { ...data, role: roleName });
}

export function notificationLink(lang: Locale, data: Record<string, string>) {
  if (data.communitySupport) return `/${lang}/community/support`;
  if (data.community) return `/${lang}/community#friends`;
  if (data.inviteId) return `/${lang}/my-teams#incoming`;
  if (data.socialMatchId) return `/${lang}/dating/${encodeURIComponent(data.socialMatchId)}`;
  if (data.marketplace) return `/${lang}/marketplace#orders`;
  if (data.caseId) return `/${lang}/arbitration?case=${encodeURIComponent(data.caseId)}`;
  if (data.messageId) return `/${lang}/messages/${data.messageId}`;
  if (data.trainingId) return `/${lang}/training/${data.trainingId}`;
  if (data.coachWorkspace) return `/${lang}/coach`;
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
