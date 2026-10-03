"use client";
import Link from "next/link";
import { SoundToggle } from "./arena-sound";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Bell, Brand, Chevron, Search } from "./icons";
import type { Dict, Locale } from "@/lib/i18n";

type NavUser = { username: string; displayName: string; admin: boolean; unread: number } | null;

function LanguageSwitch({ alternate, lang, label }: { alternate: string; lang: Locale; label: string }) {
  const query = useSearchParams().toString();
  return <Link className="lang-switch" href={alternate + (query ? `?${query}` : "")} hrefLang={lang === "ru" ? "en" : "ru"} aria-label={label}>{lang === "ru" ? "EN" : "RU"}</Link>;
}

export function Header({ lang, nav, extra, common, user }: { lang: Locale; nav: Dict["nav"]; extra: Dict["x"]["nav"]; common: Dict["common"]; user: NavUser }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() || `/${lang}`;
  const navRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const alternate = pathname.replace(/^\/(ru|en)(?=\/|$)/, lang === "ru" ? "/en" : "/ru");

  useEffect(() => {
    setOpen(false);
    headerRef.current?.querySelectorAll("details[open]").forEach((d) => d.removeAttribute("open"));
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      if (navRef.current?.contains(active) && menuButtonRef.current?.getClientRects().length) {
        menuButtonRef.current.focus();
      } else if (headerRef.current?.contains(active)) {
        active?.closest("details[open]")?.querySelector("summary")?.focus();
      }
      setOpen(false);
      headerRef.current?.querySelectorAll("details[open]").forEach((d) => d.removeAttribute("open"));
    };
    const onClick = (e: MouseEvent) => {
      if (!headerRef.current?.contains(e.target as Node)) setOpen(false);
      headerRef.current?.querySelectorAll("details[open]").forEach((d) => {
        if (!d.contains(e.target as Node)) d.removeAttribute("open");
      });
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
    if (target.classList.contains("account-menu")) setOpen(false);
    headerRef.current?.querySelectorAll("details[open]").forEach((d) => {
      if (d !== target) d.removeAttribute("open");
    });
  };

  return (
    <header ref={headerRef} className="site-header">
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
          <details className="nav-group" onToggle={(e) => closeOthers(e.currentTarget)}>
            <summary>{lang === "ru" ? "Предметы и споры" : "Items and disputes"}<Chevron /></summary>
            <div className="nav-panel">
              <Link href={`/${lang}/marketplace`} className="nav-item"><span>Skins Marketplace</span><small>{lang === "ru" ? "Каталог · тестовые сделки" : "Catalogue · test transactions"}</small></Link>
              <Link href={`/${lang}/arbitration`} className="nav-item"><span>{lang === "ru" ? "Арбитраж" : "Arbitration"}</span><small>{lang === "ru" ? "Споры и апелляции" : "Disputes and appeals"}</small></Link>
            </div>
          </details>
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
          <Suspense fallback={<Link className="lang-switch" href={alternate} hrefLang={lang === "ru" ? "en" : "ru"} aria-label={nav.language}>{lang === "ru" ? "EN" : "RU"}</Link>}>
            <LanguageSwitch alternate={alternate} lang={lang} label={nav.language} />
          </Suspense>
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
                  <Link href={`/${lang}/gameday`}>{extra.gameDay}</Link>
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
            ref={menuButtonRef}
            type="button"
            className="menu-toggle"
            aria-expanded={open}
            aria-controls="main-navigation"
            aria-label={open ? common.close : common.menu}
            onClick={() => {
              headerRef.current?.querySelector(".account-menu[open]")?.removeAttribute("open");
              setOpen((v) => !v);
            }}
          >
            <span />
            <span />
          </button>
        </div>
      </div>
    </header>
  );
}
