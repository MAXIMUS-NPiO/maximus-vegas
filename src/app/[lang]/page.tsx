import Link from "next/link";
import type { Metadata } from "next";
import { dict, isLocale, type Locale } from "@/lib/i18n.ts";
import { GAMES } from "@/lib/games.ts";
import { DIRECTIONS, t } from "@/lib/directions.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { listTournaments } from "@/server/queries.ts";
import { activeSponsors } from "@/server/sponsors.ts";
import { mediaUrl } from "@/server/media.ts";
import { DbDown, Empty, Flash, StateBadge, type SearchParams } from "@/components/ui";
import { TournamentCard } from "@/components/tournament";
import { Arrow, Shield } from "@/components/icons";
import { notFound } from "next/navigation";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const d = dict(lang);
  return { ...pageMeta(lang, "", d.meta.title, d.meta.description), title: { absolute: d.meta.title } };
}

export default async function Home({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang: raw } = await params;
  if (!isLocale(raw)) notFound();
  const lang: Locale = raw;
  const d = dict(lang);
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  const tournaments = db ? await listTournaments(db, { limit: 6 }).catch(() => []) : [];
  const sponsors = db ? await activeSponsors(db).catch(() => []) : [];
  const ru = lang === "ru";
  const featured = ["cs2", "valorant", "dota2", "lol", "rocket-league", "mlbb", "brawl-stars", "deadlock"];
  const directions = DIRECTIONS.filter((x) => ["academy", "cloud-gaming", "media", "venues", "coaches", "server-rentals"].includes(x.slug));
  return (
    <>
      <section className="hero">
        <div className="container hero-inner">
          <Flash lang={lang} params={sp} />
          <p className="eyebrow">{d.home.eyebrow}</p>
          <h1 className="hero-title">
            <span className="hero-brand-name">{d.home.title[0]}</span>
            <span className="accent hero-tagline">{d.home.title[1]}</span>
          </h1>
          <p className="hero-lead">{d.home.lead}</p>
          <div className="row">
            <Link href={`/${lang}/tournaments`} className="btn btn-primary">
              {d.home.ctaTournaments}
              <Arrow />
            </Link>
            {user ? (
              <Link href={`/${lang}/hub`} className="btn btn-ghost">
                {d.home.ctaHub}
              </Link>
            ) : (
              <Link href={`/${lang}/signup`} className="btn btn-ghost">
                {d.home.ctaSignUp}
              </Link>
            )}
          </div>
          <ol className="loop" aria-label={d.home.loopTitle}>
            {d.home.loop.map(([title, text], i) => (
              <li key={title}>
                <span className="loop-n">{String(i + 1).padStart(2, "0")}</span>
                <strong>{title}</strong>
                <span>{text}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head">
            <div>
              <h2>{d.home.openTitle}</h2>
              <p className="lead">{d.home.openLead}</p>
            </div>
            <Link href={`/${lang}/tournaments`} className="text-link">
              {d.home.allTournaments} <Arrow />
            </Link>
          </div>
          {dbError ? (
            <DbDown lang={lang} />
          ) : tournaments.length ? (
            <div className="grid grid-3">
              {tournaments.map((x) => (
                <TournamentCard key={x.id} lang={lang} t={x} />
              ))}
            </div>
          ) : (
            <Empty
              title={d.home.noTournamentsTitle}
              action={
                <Link href={`/${lang}/organizer`} className="btn btn-primary btn-sm">
                  {d.home.runTournament}
                </Link>
              }
            >
              {d.home.noTournamentsText}
            </Empty>
          )}
        </div>
      </section>

      <section className="section section-tight-top">
        <div className="container">
          <div className="grid grid-3">
            <Link href={`/${lang}/matchmaking`} className="card card-link">
              <span className="field-label">{ru ? "ИГРАТЬ СЕЙЧАС" : "PLAY NOW"}</span>
              <h3>{ru ? "Быстрый матч" : "Quick match"}</h3>
              <p className="muted small">{ru ? "Соперник из реальной очереди по вашей игре. Без ставок." : "An opponent from the real queue for your game. No stakes."}</p>
            </Link>
            <Link href={`/${lang}/challenges`} className="card card-link">
              <span className="field-label">1V1</span>
              <h3>{ru ? "Вызовы" : "Challenges"}</h3>
              <p className="muted small">{ru ? "Вызовите конкретного игрока. Результат подтверждает соперник." : "Challenge a specific player. The opponent confirms the result."}</p>
            </Link>
            <Link href={`/${lang}/progress`} className="card card-link">
              <span className="field-label">{ru ? "СЕЗОН 1" : "SEASON 1"}</span>
              <h3>{ru ? "Ранги и сезонный пропуск" : "Ranks and season pass"}</h3>
              <p className="muted small">{ru ? "XP за подтверждённые матчи, цели и косметика. Монеты не покупаются и не выводятся." : "XP for confirmed matches, objectives and cosmetics. Coins cannot be bought or cashed out."}</p>
            </Link>
          </div>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-head">
            <div>
              <h2>{d.home.gamesTitle}</h2>
              <p className="lead">{d.home.gamesLead}</p>
            </div>
            <Link href={`/${lang}/games`} className="text-link">
              {d.home.allGames} <Arrow />
            </Link>
          </div>
          <div className="grid grid-4">
            {GAMES.filter((g) => featured.includes(g.slug)).map((g) => (
              <Link key={g.slug} href={`/${lang}/games/${g.slug}`} className="card card-link game-tile">
                <span className="game-tile-name">{g.name}</span>
                <span className="muted small">{g.genre[lang]}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container split">
          <div>
            <p className="eyebrow">
              <Shield /> {lang === "ru" ? "ДОВЕРИЕ" : "TRUST"}
            </p>
            <h2>{d.home.trustTitle}</h2>
            <Link href={`/${lang}/trust`} className="text-link">
              {d.home.trustLink} <Arrow />
            </Link>
          </div>
          <ul className="points">
            {d.home.trustPoints.map(([title, text]) => (
              <li key={title}>
                <strong>{title}</strong>
                <p>{text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-head">
            <div>
              <h2>{d.home.directionsTitle}</h2>
              <p className="lead">{d.home.directionsLead}</p>
            </div>
            <Link href={`/${lang}/status`} className="text-link">
              {d.common.statusPage} <Arrow />
            </Link>
          </div>
          <div className="grid grid-3">
            {directions.map((x) => (
              <Link key={x.slug} href={`/${lang}/${x.slug}`} className="card card-link">
                <StateBadge lang={lang} state={x.state} />
                <h3>{t(x.title, lang)}</h3>
                <p className="muted">{t(x.lead, lang)}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {sponsors.length ? (
        <section className="section section-alt" aria-labelledby="sponsors-title">
          <div className="container">
            <h2 id="sponsors-title" className="h4 muted">
              {ru ? "Партнёры и спонсоры" : "Partners and sponsors"}
            </h2>
            <ul className="sponsor-strip">
              {sponsors.map((s) => (
                <li key={s.id}>
                  {s.website_url ? (
                    <a href={s.website_url} rel="noopener noreferrer sponsored" target="_blank">
                      {s.logo_media_id ? <img src={mediaUrl(s.logo_media_id)!} alt={s.name} loading="lazy" /> : <span>{s.name}</span>}
                    </a>
                  ) : s.logo_media_id ? (
                    <img src={mediaUrl(s.logo_media_id)!} alt={s.name} loading="lazy" />
                  ) : (
                    <span>{s.name}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      <section className="section">
        <div className="container cta-band">
          <div>
            <h2>{d.home.partnersTitle}</h2>
            <p className="lead">{d.home.partnersLead}</p>
          </div>
          <div className="row">
            <Link href={`/${lang}/partners`} className="btn btn-primary">
              {d.home.partnersCta}
              <Arrow />
            </Link>
            <Link href={`/${lang}/organizer`} className="btn btn-ghost">
              {d.home.runTournament}
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
