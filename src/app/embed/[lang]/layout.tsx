import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import "../../[lang]/styles.css";

const manrope = localFont({
  src: [
    { path: "../../../../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2", style: "normal" },
    { path: "../../../../node_modules/@fontsource-variable/manrope/files/manrope-cyrillic-wght-normal.woff2", style: "normal" },
  ],
  variable: "--font-manrope",
  display: "swap",
});

export const viewport: Viewport = { themeColor: "#0b0b0e", width: "device-width", initialScale: 1 };
export const dynamicParams = false;
export function generateStaticParams() {
  return [{ lang: "ru" }, { lang: "en" }];
}
/** Widgets are for other sites' pages: never indexed on their own. */
export const metadata: Metadata = { robots: { index: false, follow: false }, title: "MAXIMUS VEGAS" };

/** Root layout of embeddable widgets: no site header or footer; every link opens the portal in a new tab. */
export default async function EmbedLayout({ children, params }: { children: React.ReactNode; params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  return (
    <html lang={lang} className={manrope.variable}>
      <body className="embed-body">
        <main className="embed-page">{children}</main>
      </body>
    </html>
  );
}
