import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { notFound } from "next/navigation";
import { content, isLocale } from "@/lib/content";
import { siteOrigin } from "@/lib/site";
import { Header } from "@/components/header";
import "./styles.css";

const manrope = localFont({
  src: [
    {
      path: "../../../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2",
      style: "normal",
    },
    {
      path: "../../../node_modules/@fontsource-variable/manrope/files/manrope-cyrillic-wght-normal.woff2",
      style: "normal",
    },
  ],
  variable: "--font-manrope",
  display: "swap",
});
export const viewport: Viewport = { themeColor: "#0b0d0b" };
export const dynamicParams = false;
export function generateStaticParams() {
  return [{ lang: "ru" }, { lang: "en" }];
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const copy = content[lang];
  const origin = siteOrigin();
  return {
    title: copy.title,
    description: copy.description,
    ...(origin
      ? {
          metadataBase: new URL(origin),
          alternates: {
            canonical: `/${lang}`,
            languages: { ru: "/ru", en: "/en", "x-default": "/en" },
          },
        }
      : {}),
    icons: { icon: "/lion-logo.png" },
    openGraph: {
      title: copy.title,
      description: copy.description,
      siteName: "MAXIMUS VEGAS",
      type: "website",
      locale: lang === "ru" ? "ru_RU" : "en_US",
      ...(origin ? { url: `${origin}/${lang}` } : {}),
    },
    twitter: {
      card: "summary",
      title: copy.title,
      description: copy.description,
    },
  };
}
export default async function Layout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const { nav, cta, menu, close } = content[lang];
  return (
    <html lang={lang} className={manrope.variable}>
      <body>
        <a className="skip-link" href="#main">
          {content[lang].skip}
        </a>
        <Header lang={lang} copy={{ nav, cta, menu, close }} />
        {children}
      </body>
    </html>
  );
}
