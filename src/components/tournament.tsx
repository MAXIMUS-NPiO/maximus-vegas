import Link from "next/link";
import { dict, type Locale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import type { TournamentCard as Card } from "@/server/queries.ts";
import type { BracketMatch } from "@/server/queries.ts";
import { roundName } from "@/server/bracket.ts";
import { Badge } from "./ui";
import { LocalTime } from "./time";

export function TournamentCard({ lang, t }: { lang: Locale; t: Card }) {
  const d = dict(lang);
  const game = gameBySlug(t.game);
  return (
    <Link href={`/${lang}/tournaments/${t.slug}`} className="card card-link t-card">
      <div className="t-card-top">
        <span className="t-card-game">{game?.name ?? t.game}</span>
        <Badge status={t.status}>{d.statuses.tournament[t.status]}</Badge>
      </div>
      <h3>{t.name}</h3>
      <dl className="t-card-meta">
        <div>
          <dt>{d.tournaments.starts}</dt>
          <dd>
            <LocalTime iso={t.starts_at} lang={lang} />
          </dd>
        </div>
        <div>
          <dt>{d.tournaments.participants}</dt>
          <dd>
            {t.registered} / {t.max_participants}
          </dd>
        </div>
        <div>
          <dt>{d.tournaments.type}</dt>
          <dd>{t.participant_type === "solo" ? d.tournaments.solo : `${d.tournaments.team} ${t.team_size}v${t.team_size}`}</dd>
        </div>
      </dl>
      <p className="t-card-org">{t.org_name}</p>
    </Link>
  );
}

export function BracketView({ lang, matches, linkMatches = true }: { lang: Locale; matches: BracketMatch[]; linkMatches?: boolean }) {
  const d = dict(lang);
  const rounds = Math.max(0, ...matches.map((m) => m.round));
  const byRound = Array.from({ length: rounds }, (_, i) => matches.filter((m) => m.round === i + 1));
  return (
    <div className="bracket" role="list">
      {byRound.map((list, i) => (
        <section key={i} className="bracket-round" role="listitem" aria-label={roundName(i + 1, rounds, lang)}>
          <h4 className="bracket-round-title">{roundName(i + 1, rounds, lang)}</h4>
          <ol className="bracket-matches">
            {list.map((m) => {
              const side = (reg: string | null, name: string | null, score: number | null) => (
                <div className={`b-side${m.winner_reg && reg === m.winner_reg ? " is-winner" : ""}${m.winner_reg && reg && reg !== m.winner_reg ? " is-loser" : ""}`}>
                  <span className="b-name">{name ?? (m.outcome === "bye" && m.round === 1 ? d.common.bye : d.common.tbd)}</span>
                  <span className="b-score">{score ?? (m.winner_reg && reg === m.winner_reg && m.outcome !== "played" ? "W" : "")}</span>
                </div>
              );
              const body = (
                <>
                  {side(m.a_reg, m.a_name, m.score_a)}
                  {side(m.b_reg, m.b_name, m.score_b)}
                  <div className="b-foot">
                    <span className={`b-status b-${m.status}`}>{m.outcome && m.outcome !== "played" ? d.statuses.outcome[m.outcome] : d.statuses.match[m.status]}</span>
                  </div>
                </>
              );
              return (
                <li key={m.id} className={`b-match b-${m.status}`}>
                  {linkMatches && m.outcome !== "bye" ? (
                    <Link href={`/${lang}/matches/${m.id}`} className="b-link">
                      {body}
                    </Link>
                  ) : (
                    <div className="b-link">{body}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
