import Link from "next/link";
import { dict, type Locale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import type { TournamentCard as Card } from "@/server/queries.ts";
import type { BracketMatch } from "@/server/queries.ts";
import { roundName } from "@/server/bracket.ts";
import { deRoundName } from "@/server/double.ts";
import type { StandingsRow } from "@/server/standings.ts";
import type { FormatSettings } from "@/server/format-settings.ts";
import { Badge } from "./ui";
import { LocalTime } from "./time";

export function formatLabel(format: string | undefined, lang: Locale) {
  const ru = lang === "ru";
  switch (format) {
    case "double_elimination":
      return ru ? "Двойное выбывание" : "Double elimination";
    case "round_robin":
      return ru ? "Круговая система" : "Round robin";
    case "swiss":
      return ru ? "Швейцарская система" : "Swiss system";
    case "leaderboard":
      return ru ? "Leaderboard (очки)" : "Leaderboard (points)";
    default:
      return ru ? "Олимпийская система" : "Single elimination";
  }
}

/** Round robin and Swiss are played in rounds ("tours"), not bracket stages. */
export const roundLabel = (round: number, lang: Locale) => (lang === "ru" ? `Тур ${round}` : `Round ${round}`);

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
  grid = false,
}: {
  lang: Locale;
  matches: BracketMatch[];
  label: (round: number) => string;
  linkMatches: boolean;
  /** Rounds wrap into a grid instead of bracket columns (round robin, Swiss). */
  grid?: boolean;
}) {
  const d = dict(lang);
  const ru = lang === "ru";
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  return (
    <div className={grid ? "bracket round-grid" : "bracket"} role="list">
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
                    <span className="b-name">{name ?? (isVoid || (m.outcome === "bye" && (m.round === 1 || m.bracket === "SW")) ? d.common.bye : d.common.tbd)}</span>
                    <span className="b-score">{score ?? (m.winner_reg && reg === m.winner_reg && m.outcome !== "played" ? "W" : "")}</span>
                  </div>
                );
                const body = (
                  <>
                    {side(m.a_reg, m.a_name, m.score_a, m.a_void)}
                    {side(m.b_reg, m.b_name, m.score_b, m.b_void)}
                    <div className="b-foot">
                      <span className={`b-status b-${m.status}`}>
                        {empty
                          ? "—"
                          : m.status === "completed" && !m.winner_reg && m.a_reg && m.b_reg
                            ? ru
                              ? "Ничья"
                              : "Draw"
                            : m.outcome && m.outcome !== "played"
                              ? d.statuses.outcome[m.outcome]
                              : d.statuses.match[m.status]}
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
  if (format === "round_robin" || format === "swiss")
    return <Rounds lang={lang} matches={matches} label={(r) => roundLabel(r, lang)} linkMatches={linkMatches} grid />;
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

export type StandingName = { name: string; username: string | null; team_slug: string | null };

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * Round-robin and Swiss table with the tie-break columns of the format, in the order they are applied.
 * The same rows decide the final places, so what players see is exactly what ranks them.
 */
export function StandingsTable({
  lang,
  format,
  rows,
  names,
  final,
}: {
  lang: Locale;
  format: "round_robin" | "swiss";
  rows: StandingsRow[];
  names: Map<string, StandingName>;
  final: boolean;
}) {
  const ru = lang === "ru";
  const swiss = format === "swiss";
  const anyByes = rows.some((r) => r.byes > 0);
  const tieCols: Array<[string, string, (r: StandingsRow) => string]> = swiss
    ? [
        [ru ? "Бх" : "BH", ru ? "Бухгольц — сумма очков всех соперников" : "Buchholz — sum of all opponents' points", (r) => num(r.buchholz)],
        [ru ? "МБх" : "MBH", ru ? "Медианный Бухгольц — без лучшего и худшего соперника" : "Median Buchholz — without the best and worst opponent", (r) => num(r.medianBuchholz)],
        [ru ? "ЗБ" : "SB", ru ? "Зоннеборн-Бергер — очки побеждённых соперников плюс половина очков тех, с кем ничья" : "Sonneborn-Berger — points of beaten opponents plus half the points of drawn ones", (r) => num(r.sonnebornBerger)],
        ["±", ru ? "Разница счёта сыгранных матчей" : "Score difference of played matches", (r) => (r.diff > 0 ? `+${r.diff}` : String(r.diff))],
      ]
    : [
        [ru ? "ЛВ" : "H2H", ru ? "Очки в личных встречах с теми, у кого столько же очков" : "Points in games between entrants level on points", (r) => num(r.headToHead)],
        [ru ? "ЗБ" : "SB", ru ? "Зоннеборн-Бергер — очки побеждённых соперников плюс половина очков тех, с кем ничья" : "Sonneborn-Berger — points of beaten opponents plus half the points of drawn ones", (r) => num(r.sonnebornBerger)],
        ["±", ru ? "Разница счёта сыгранных матчей" : "Score difference of played matches", (r) => (r.diff > 0 ? `+${r.diff}` : String(r.diff))],
        [ru ? "Заб." : "For", ru ? "Забито в сыгранных матчах" : "Scored in played matches", (r) => String(r.scoreFor)],
      ];
  return (
    <div className="stack-sm">
      <div className="table-wrap">
        <table className="table table-compact">
          <thead>
            <tr>
              <th>#</th>
              <th>{ru ? "Участник" : "Entrant"}</th>
              <th className="num" title={ru ? "Сыграно матчей" : "Games played"}>{ru ? "И" : "P"}</th>
              <th className="num">{ru ? "В" : "W"}</th>
              <th className="num">{ru ? "Н" : "D"}</th>
              <th className="num">{ru ? "П" : "L"}</th>
              {anyByes ? <th className="num">bye</th> : null}
              <th className="num">{ru ? "Очки" : "Pts"}</th>
              {tieCols.map(([h, title]) => (
                <th key={h} className="num" title={title}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const who = names.get(r.id);
              const label = who?.name ?? "—";
              return (
                <tr key={r.id} className={r.disqualified ? "is-out" : r.rank === 1 && final ? "is-first" : undefined}>
                  <td>{r.rank ?? "—"}</td>
                  <td>
                    {who?.team_slug ? <Link href={`/${lang}/teams/${who.team_slug}`}>{label}</Link> : who?.username ? <Link href={`/${lang}/players/${who.username}`}>{label}</Link> : label}
                    {r.disqualified ? (
                      <span className="small muted">
                        {" "}
                        · {ru ? "дисквалифицирован" : "disqualified"}
                        {r.annulled ? (ru ? ", результаты аннулированы" : ", results annulled") : ""}
                      </span>
                    ) : null}
                  </td>
                  <td className="num">{r.played}</td>
                  <td className="num">{r.wins}</td>
                  <td className="num">{r.draws}</td>
                  <td className="num">{r.losses}</td>
                  {anyByes ? <td className="num">{r.byes || ""}</td> : null}
                  <td className="num">
                    <strong>{num(r.points)}</strong>
                  </td>
                  {tieCols.map(([h, , value]) => (
                    <td key={h} className="num">
                      {value(r)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        {tieCols.map(([h, title]) => `${h}: ${title}`).join(" · ")}
      </p>
    </div>
  );
}

/** The scoring rules of a round-robin or Swiss tournament, exactly as the table applies them. */
export function RoundRules({ lang, format, settings, started }: { lang: Locale; format: "round_robin" | "swiss"; settings: FormatSettings; started: boolean }) {
  const ru = lang === "ru";
  const p = settings.points;
  const items: Array<[string, string]> = [
    [ru ? "Победа" : "Win", String(p.win)],
    [ru ? "Ничья" : "Draw", settings.allowDraws ? String(p.draw) : ru ? "не допускается" : "not allowed"],
    [ru ? "Поражение" : "Loss", String(p.loss)],
  ];
  if (format === "swiss") {
    items.push([ru ? "Bye (пропуск тура при нечётном числе)" : "Bye (odd field)", String(p.bye)]);
    items.push([
      ru ? "Туров" : "Rounds",
      settings.rounds ? String(settings.rounds) : ru ? "автоматически: ⌈log₂ N⌉, не больше N − 1" : "automatic: ⌈log₂ N⌉, at most N − 1",
    ]);
  } else {
    items.push([ru ? "Круги" : "Legs", settings.legs === 2 ? (ru ? "два (дома и в гостях)" : "two (home and away)") : ru ? "один" : "one"]);
    const dq = settings.disqualification ?? "forfeit";
    items.push([
      ru ? "Дисквалификация" : "Disqualification",
      dq === "annul"
        ? ru
          ? "все матчи участника аннулируются"
          : "all of the entrant's matches are annulled"
        : dq === "half"
          ? ru
            ? "аннулируются, если сыграно меньше половины матчей; иначе оставшиеся — соперникам"
            : "annulled if under half were played; otherwise the rest go to the opponents"
          : ru
            ? "сыгранные результаты остаются, оставшиеся матчи — соперникам"
            : "played results stand, the remaining matches go to the opponents",
    ]);
  }
  const order =
    format === "swiss"
      ? ru
        ? "очки → Бухгольц → медианный Бухгольц → Зоннеборн-Бергер → разница счёта → посев"
        : "points → Buchholz → Median Buchholz → Sonneborn-Berger → score difference → seed"
      : ru
        ? "очки → личные встречи среди равных по очкам → Зоннеборн-Бергер → разница счёта → забито → посев"
        : "points → head-to-head among those level on points → Sonneborn-Berger → score difference → scored → seed";
  return (
    <div className="card stack-sm">
      <p className="field-label">{ru ? "Как считается таблица" : "How the table is computed"}</p>
      <ul className="kv-list">
        {items.map(([k, v]) => (
          <li key={k}>
            <span>{k}</span>
            <strong>{v}</strong>
          </li>
        ))}
      </ul>
      <p className="small muted">
        {ru ? "Порядок мест: " : "Order: "}
        {order}.{" "}
        {format === "swiss"
          ? ru
            ? "Пары каждого тура — по очкам: верхняя половина группы против нижней, без повторных встреч, пока это возможно; bye получает участник ниже всех среди тех, у кого меньше всего bye."
            : "Each round pairs by points: top half of a score group against the bottom half, without rematches whenever possible; the bye goes to the lowest-ranked entrant among those with the fewest byes."
          : ru
            ? "Каждый встречается с каждым; расписание туров строится по посеву."
            : "Everyone meets everyone; the round schedule follows the seeds."}
      </p>
      <p className="small muted">
        {ru ? "Версии алгоритмов" : "Algorithm versions"}: {settings.standings}
        {settings.pairing ? ` · ${settings.pairing}` : ""}. {started ? (ru ? "Настройки зафиксированы при старте." : "Settings were frozen at the start.") : ru ? "Настройки фиксируются при старте." : "Settings are frozen at the start."}
      </p>
    </div>
  );
}
