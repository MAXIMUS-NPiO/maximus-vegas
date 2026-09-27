import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { siteOrigin } from "@/lib/site.ts";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { viewer } from "@/server/viewer.ts";
import { unreadCount } from "@/server/queries.ts";
import { isStaff } from "@/server/access.ts";
import "./styles.css";

const manrope = localFont({
  src: [
    { path: "../../../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2", style: "normal" },
    { path: "../../../node_modules/@fontsource-variable/manrope/files/manrope-cyrillic-wght-normal.woff2", style: "normal" },
  ],
  variable: "--font-manrope",
  display: "swap",
});

export const viewport: Viewport = { themeColor: "#0b0b0e", width: "device-width", initialScale: 1 };
export const dynamicParams = false;
export function generateStaticParams() {
  return [{ lang: "ru" }, { lang: "en" }];
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const d = dict(lang);
  const origin = siteOrigin();
  return {
    title: { default: d.meta.title, template: "%s · MAXIMUS VEGAS" },
    description: d.meta.description,
    applicationName: "MAXIMUS VEGAS",
    ...(origin ? { metadataBase: new URL(origin) } : {}),
    openGraph: {
      title: d.meta.title,
      description: d.meta.description,
      siteName: "MAXIMUS VEGAS",
      type: "website",
      locale: lang === "ru" ? "ru_RU" : "en_US",
    },
    twitter: { card: "summary", title: d.meta.title, description: d.meta.description },
  };
}

export default async function Layout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const { db, user } = await viewer();
  const unread = db && user ? await unreadCount(db, user.id).catch(() => 0) : 0;
  return (
    <html lang={lang} className={manrope.variable}>
      <body>
        <a className="skip-link" href="#main">
          {d.common.skip}
        </a>
        <Header
          lang={lang}
          nav={d.nav}
          extra={d.x.nav}
          common={d.common}
          user={user ? { username: user.username, displayName: user.displayName, admin: isStaff(user), unread } : null}
        />
        <main id="main">{children}</main>
        <Footer lang={lang} />
      </body>
    </html>
  );
}
