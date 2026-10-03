import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { viewer } from "@/server/viewer.ts";
import { venueView, isVenueStaff } from "@/server/venues.ts";
import { requireStaffMfa } from "@/server/mfa.ts";
import { DbDown, PageHead } from "@/components/ui";
import { OfflineScanner } from "@/components/offline-scanner";
export const metadata = { title: "MAXIMUS · Check-in", robots: { index: false, follow: false } };
export default async function VenueScanner({ params }: { params: Promise<{ lang: string; slug: string }> }) {
  const { lang, slug } = await params; if (!isLocale(lang)) notFound();
  const { db, user } = await viewer(); if (!db) return <DbDown lang={lang} />;
  const back = `/${lang}/clubhouse/${slug}/scan`, T = (ru: string, en: string) => lang === "ru" ? ru : en;
  if (!user) redirect(`/${lang}/signin?next=${back}`);
  const venue = (await venueView(db, slug, user))?.venue;
  if (!venue || !(await isVenueStaff(db, venue.org_id, user))) notFound();
  try { await requireStaffMfa(db, user); } catch { redirect(`/${lang}/admin/mfa?next=${back}`); }
  return <div className="container page"><Link href={`/${lang}/venues/${slug}`} className="text-link">← {venue.name}</Link><PageHead title={T("Вход участников", "Member check-in")} lead={venue.name} /><OfflineScanner venueId={venue.id} userId={user.id} lang={lang} /></div>;
}
