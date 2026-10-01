"use client";
import Link from "next/link";
import { SoundToggle } from "./arena-sound";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Bell, Brand, Chevron, Search } from "./icons";
import type { Dict, Locale } from "@/lib/i18n";

type NavUser = { username: string; displayName: string; admin: boolean; unread: number } | null;

export function Header({ lang, nav, extra, common, user }: { lang: Locale; nav: Dict["nav"]; extra: Dict["x"]["nav"]; common: Dict["common"]; user: NavUser }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() || `/${lang}`;
  const navRef = useRef<HTMLElement>(null);
  const alternate = pathname.replace(/^\/(ru|en)(?=\/|$)/, lang === "ru" ? "/en" : "/ru");

  useEffect(() => {
    setOpen(false);
    navRef.current?.querySelectorAll("details[open]").forEach((d) => d.removeAttribute("open"));
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      navRef.current?.querySelectorAll("details[open]").forEach((d) => d.removeAttribute("open"));
    };
    const onClick = (e: MouseEvent) => {
      if (!navRef.current?.contains(e.target as Node))
        navRef.current?.querySelectorAll("details[open]").forEach((d) => d.removeAttribute("open"));
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, []);

  const closeOthers = (target: HTMLDetailsElement) => {
    if (!target.open) return;
    navRef.current?.querySelectorAll("details[open]").forEach((d) => {
      if (d !== target) d.removeAttribute("open");
    });
  };

  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link href={`/${lang}`} className="brand-link" aria-label="MAXIMUS VEGAS">
          <Brand />
        </Link>
        <nav ref={navRef} id="main-navigation" className={open ? "nav is-open" : "nav"} aria-label={lang === "ru" ? "Основная навигация" : "Main navigation"}>
          {nav.groups.map((group) => (
            <details key={group.label} className="nav-group" onToggle={(e) => closeOthers(e.currentTarget)}>
              <summary>
                {group.label}
                <Chevron />
              </summary>
              <div className="nav-panel">
                {group.items.map(([slug, label, hint]) => (
                  <Link key={slug} href={`/${lang}/${slug}`} className="nav-item">
                    <span>{label}</span>
                    <small>{hint}</small>
                  </Link>
                ))}
              </div>
            </details>
          ))}
          <div className="nav-mobile-extra">
            <Link href={`/${lang}/search`}>{common.search}</Link>
            <Link href={`/${lang}/explore`}>{nav.explore}</Link>
            {user ? null : (
              <>
                <Link href={`/${lang}/signin`}>{nav.signIn}</Link>
                <Link href={`/${lang}/signup`} className="btn btn-primary btn-sm">
                  {nav.signUp}
                </Link>
              </>
            )}
          </div>
        </nav>
        <div className="header-actions">
          <SoundToggle lang={lang} />
          <Link href={`/${lang}/search`} className="icon-btn hide-mobile" aria-label={common.search}>
            <Search />
          </Link>
          <Link className="lang-switch" href={alternate} hrefLang={lang === "ru" ? "en" : "ru"} aria-label={nav.language}>
            {lang === "ru" ? "EN" : "RU"}
          </Link>
          {user ? (
            <>
              <Link href={`/${lang}/notifications`} className="icon-btn" aria-label={`${nav.notifications}${user.unread ? ` (${user.unread})` : ""}`}>
                <Bell />
                {user.unread ? <span className="dot">{user.unread > 9 ? "9+" : user.unread}</span> : null}
              </Link>
              <details className="account-menu" onToggle={(e) => closeOthers(e.currentTarget)}>
                <summary aria-label={user.displayName}>
                  <span className="avatar" aria-hidden="true">
                    {user.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="hide-mobile account-name">{user.displayName}</span>
                </summary>
                <div className="account-panel">
                  <Link href={`/${lang}/hub`}>{nav.hub}</Link>
                  <Link href={`/${lang}/players/${user.username}`}>{nav.profile}</Link>
                  <Link href={`/${lang}/progress`}>{extra.progress}</Link>
                  <Link href={`/${lang}/challenges`}>{extra.challenges}</Link>
                  <Link href={`/${lang}/billing`}>{extra.billing}</Link>
                  <Link href={`/${lang}/organizer`}>{nav.organizer}</Link>
                  <Link href={`/${lang}/settings`}>{nav.settings}</Link>
                  {user.admin ? <Link href={`/${lang}/admin`}>{nav.admin}</Link> : null}
                  <form method="post" action={`/api/a/auth.signout?lang=${lang}`}>
                    <input type="hidden" name="lang" value={lang} />
                    <input type="hidden" name="back" value={`/${lang}`} />
                    <button type="submit">{nav.signOut}</button>
                  </form>
                </div>
              </details>
            </>
          ) : (
            <>
              <Link href={`/${lang}/signin`} className="btn btn-ghost btn-sm hide-mobile">
                {nav.signIn}
              </Link>
              <Link href={`/${lang}/signup`} className="btn btn-primary btn-sm hide-mobile">
                {nav.signUp}
              </Link>
            </>
          )}
          <button
            type="button"
            className="menu-toggle"
            aria-expanded={open}
            aria-controls="main-navigation"
            aria-label={open ? common.close : common.menu}
            onClick={() => setOpen((v) => !v)}
          >
            <span />
            <span />
          </button>
        </div>
      </div>
    </header>
  );
}
