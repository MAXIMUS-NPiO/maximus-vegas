import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site.ts";

export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin() ?? "https://www.maximus.vegas";
  const privatePaths = ["/api/", "/ru/hub", "/en/hub", "/ru/settings", "/en/settings", "/ru/admin", "/en/admin", "/ru/notifications", "/en/notifications", "/ru/calendar", "/en/calendar", "/ru/organizer/", "/en/organizer/", "/ru/matches/", "/en/matches/", "/ru/search", "/en/search"];
  return { rules: { userAgent: "*", allow: "/", disallow: privatePaths }, sitemap: `${origin}/sitemap.xml` };
}
