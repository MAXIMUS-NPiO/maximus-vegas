import type { MetadataRoute } from "next";
import { siteOrigin } from "@/lib/site.ts";

export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin() ?? "https://www.maximus.vegas";
  const personal = [
    "hub",
    "gameday",
    "settings",
    "admin",
    "notifications",
    "calendar",
    "organizer/",
    "matches/",
    "search",
    "progress",
    "billing",
    "challenges",
    "conduct",
    "scouting",
    "passes",
    "pass/",
    "messages/",
    "training",
    "welcome",
    "verify-email",
    "activate",
    "reset-password",
    "signup/check-email",
  ];
  const privatePaths = ["/api/", "/embed/", ...personal.flatMap((p) => [`/ru/${p}`, `/en/${p}`])];
  return { rules: { userAgent: "*", allow: "/", disallow: privatePaths }, sitemap: `${origin}/sitemap.xml` };
}
