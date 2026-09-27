import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site";
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  if (!origin) return [];
  return ["ru", "en"].map((lang) => ({
    url: `${origin}/${lang}`,
    alternates: { languages: { ru: `${origin}/ru`, en: `${origin}/en` } },
  }));
}
