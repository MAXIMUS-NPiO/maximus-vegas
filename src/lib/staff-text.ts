import type { Locale } from "./i18n.ts";

/** Names of platform staff roles (MV-STAFF-1). */
export const roleNames: Record<Locale, Record<string, string>> = {
  ru: {
    admin: "администратор",
    support: "поддержка",
    moderation: "модерация",
    referee: "судейство",
    finance: "финансы",
    compliance: "комплаенс",
    analytics: "аналитика",
    marketing: "маркетинг",
    infrastructure: "инфраструктура",
  },
  en: {
    admin: "administrator",
    support: "support",
    moderation: "moderation",
    referee: "refereeing",
    finance: "finance",
    compliance: "compliance",
    analytics: "analytics",
    marketing: "marketing",
    infrastructure: "infrastructure",
  },
};
