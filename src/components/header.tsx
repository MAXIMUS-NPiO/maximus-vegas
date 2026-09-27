"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { ArrowUp, Brand } from "./icons";
import type { Copy, Locale } from "@/lib/content";

export function Header({
  lang,
  copy,
}: {
  lang: Locale;
  copy: Pick<Copy, "nav" | "cta" | "menu" | "close">;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const alternate = pathname.replace(
    /^\/(ru|en)(?=\/|$)/,
    lang === "ru" ? "/en" : "/ru",
  );
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link
          href={`/${lang}`}
          aria-label="MAXIMUS VEGAS"
          onClick={() => setOpen(false)}
        >
          <Brand />
        </Link>
        <nav
          id="main-navigation"
          className={open ? "navigation is-open" : "navigation"}
          aria-label={lang === "ru" ? "Основная навигация" : "Main navigation"}
        >
          {["ecosystem", "partners", "business", "about"].map((id, index) => (
            <Link
              key={id}
              href={`/${lang}#${id}`}
              onClick={() => setOpen(false)}
            >
              {copy.nav[index]}
            </Link>
          ))}
          <Link
            className="mobile-contact"
            href={`/${lang}#contact`}
            onClick={() => setOpen(false)}
          >
            {copy.cta}
            <ArrowUp />
          </Link>
        </nav>
        <div className="header-actions">
          <Link
            className="language"
            href={alternate}
            hrefLang={lang === "ru" ? "en" : "ru"}
            aria-label={
              lang === "ru" ? "Switch to English" : "Переключить на русский"
            }
          >
            {lang === "ru" ? "EN" : "RU"}
          </Link>
          <Link
            href={`/${lang}#contact`}
            className="button button-small header-cta"
          >
            {copy.cta}
            <ArrowUp />
          </Link>
          <button
            className="menu-toggle"
            aria-expanded={open}
            aria-controls="main-navigation"
            aria-label={open ? copy.close : copy.menu}
            onClick={() => setOpen(!open)}
          >
            <span />
            <span />
          </button>
        </div>
      </div>
    </header>
  );
}
