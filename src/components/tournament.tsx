import Link from "next/link";
import { dict, type Locale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import type { TournamentCard as Card } from "@/server/queries.ts";
import type { BracketMatch } from "@/server/queries.ts";
import { roundName } from "@/server/bracket.ts";
import { deRoundName } from "@/server/double.ts";
import { Badge } from "./ui";
import { LocalTime } from "./time";

export const formatLabel = (format: string | undefined, lang: Locale) =>
  format === "double_elimination"
    ? lang === "ru"
      ? "Двойное выбывание"
      : "Double elimination"
    : format === "leaderboard"
      ? lang === "ru"
        ? "Leaderboard (очки)"
        : "Leaderboard (points)"
      : lang === "ru"
        ? "Олимпийская система"
        : "Single elimination";

export function TournamentCard({ lang, t }: { lang: Locale; t: Card & { format?: string } }) {
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
      <p className="t-card-org">
        {t.org_name}
        {t.format ? <span className="muted"> · {formatLabel(t.format, lang)}</span> : null}
      </p>
    </Link>
  );
}

function Rounds({
  lang,
  matches,
  label,
  linkMatches,
}: {
  lang: Locale;
  matches: BracketMatch[];
  label: (round: number) => string;
  linkMatches: boolean;
}) {
  const d = dict(lang);
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  return (
    <div className="bracket" role="list">
      {rounds.map((round) => (
        <section key={round} className="bracket-round" role="listitem" aria-label={label(round)}>
          <h4 className="bracket-round-title">{label(round)}</h4>
          <ol className="bracket-matches">
            {matches
              .filter((m) => m.round === round)
              .map((m) => {
                const empty = m.a_void && m.b_void;
                const side = (reg: string | null, name: string | null, score: number | null, isVoid?: boolean) => (
                  <div className={`b-side${m.winner_reg && reg === m.winner_reg ? " is-winner" : ""}${m.winner_reg && reg && reg !== m.winner_reg ? " is-loser" : ""}`}>
                    <span className="b-name">{name ?? (isVoid || (m.outcome === "bye" && m.round === 1) ? d.common.bye : d.common.tbd)}</span>
                    <span className="b-score">{score ?? (m.winner_reg && reg === m.winner_reg && m.outcome !== "played" ? "W" : "")}</span>
                  </div>
                );
                const body = (
                  <>
                    {side(m.a_reg, m.a_name, m.score_a, m.a_void)}
                    {side(m.b_reg, m.b_name, m.score_b, m.b_void)}
                    <div className="b-foot">
                      <span className={`b-status b-${m.status}`}>
                        {empty ? "—" : m.outcome && m.outcome !== "played" ? d.statuses.outcome[m.outcome] : d.statuses.match[m.status]}
                      </span>
                    </div>
                  </>
                );
                return (
                  <li key={m.id} className={`b-match b-${m.status}${empty ? " is-empty" : ""}`}>
                    {linkMatches && m.outcome !== "bye" && !empty ? (
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

export function BracketView({
  lang,
  matches,
  linkMatches = true,
  format = "single_elimination",
}: {
  lang: Locale;
  matches: BracketMatch[];
  linkMatches?: boolean;
  format?: string;
}) {
  if (format !== "double_elimination") {
    const rounds = Math.max(0, ...matches.map((m) => m.round));
    return <Rounds lang={lang} matches={matches} label={(r) => roundName(r, rounds, lang)} linkMatches={linkMatches} />;
  }
  const w = matches.filter((m) => (m.bracket ?? "W") === "W");
  const l = matches.filter((m) => m.bracket === "L" && !(m.a_void && m.b_void));
  const gf = matches.filter((m) => m.bracket === "GF");
  const wRounds = Math.max(0, ...w.map((m) => m.round));
  const lRounds = Math.max(0, ...matches.filter((m) => m.bracket === "L").map((m) => m.round));
  const ru = lang === "ru";
  return (
    <div className="stack">
      <div className="bracket-group">
        <h3 className="h4">{ru ? "Верхняя сетка" : "Winners bracket"}</h3>
        <Rounds lang={lang} matches={w} label={(r) => deRoundName("W", r, wRounds, lRounds, lang)} linkMatches={linkMatches} />
      </div>
      {l.length ? (
        <div className="bracket-group">
          <h3 className="h4">{ru ? "Нижняя сетка" : "Losers bracket"}</h3>
          <p className="small muted">{ru ? "Одно поражение переводит в нижнюю сетку; второе — выбывание." : "One loss moves you to the losers bracket; a second one eliminates you."}</p>
          <Rounds lang={lang} matches={l} label={(r) => deRoundName("L", r, wRounds, lRounds, lang)} linkMatches={linkMatches} />
        </div>
      ) : null}
      <div className="bracket-group">
        <h3 className="h4">{ru ? "Финал" : "Finals"}</h3>
        <p className="small muted">
          {ru
            ? "Если победитель нижней сетки выигрывает гранд-финал, играется перезапуск финала: у победителя верхней сетки это первое поражение."
            : "If the losers-bracket champion wins the grand final, a bracket reset is played: it is only the winners-bracket champion's first loss."}
        </p>
        <Rounds lang={lang} matches={gf} label={(r) => deRoundName("GF", r, wRounds, lRounds, lang)} linkMatches={linkMatches} />
      </div>
    </div>
  );
}
