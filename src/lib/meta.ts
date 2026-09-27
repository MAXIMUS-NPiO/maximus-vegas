import type { Metadata } from "next";
import type { Locale } from "./i18n.ts";

export function pageMeta(lang: Locale, path: string, title: string, description?: string, opts: { noindex?: boolean } = {}): Metadata {
  const clean = path ? `/${path.replace(/^\/+/, "")}` : "";
  return {
    title,
    ...(description ? { description } : {}),
    alternates: {
      canonical: `/${lang}${clean}`,
      languages: { ru: `/ru${clean}`, en: `/en${clean}`, "x-default": `/en${clean}` },
    },
    ...(opts.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}
