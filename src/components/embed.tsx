import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n.ts";
import type { Standings } from "@/server/partner-api.ts";
import { groupTitle } from "@/components/tournament";
import { FinalPlacements } from "./final-placements";

/** Header of a widget: the title and a link that opens the portal in a new tab. */
export function EmbedHead({ lang, title, subtitle, href }: { lang: Locale; title: string; subtitle?: ReactNode; href: string }) {
  return (
    <header className="embed-head">
      <div>
        <h1 className="embed-title">{title}</h1>
        {subtitle ? <p className="small muted">{subtitle}</p> : null}
      </div>
      <a href={href} target="_blank" rel="noopener" className="btn btn-ghost btn-xs">
        {lang === "ru" ? "Открыть на портале ↗" : "Open on the portal ↗"}
      </a>
    </header>
  );
}

/** The widget's source line with the official mark. */
export function EmbedFoot({ href }: { href: string }) {
  return (
    <footer className="embed-foot">
      <a href={href} target="_blank" rel="noopener">
        <img src="/brand/maximus-lion.jpg" alt="" width={18} height={18} />
        <strong>MAXIMUS</strong> <span className="muted">VEGAS</span>
      </a>
    </footer>
  );
}

/** Standings as plain tables (no links inside the frame). */
export function EmbedStandings({ lang, standings }: { lang: Locale; standings: Standings }) {
  const ru = lang === "ru";
  const empty = <p className="small muted">{ru ? "Таблица появится, когда будут сыграны матчи." : "The table appears once matches are played."}</p>;
  if (standings.kind === "placements") {
    if (standings.final) return <FinalPlacements lang={lang} rows={standings.rows} />;
    if (!standings.rows.length)
      return <p className="small muted">{ru ? "Места появятся после завершения турнира." : "Places appear when the tournament ends."}</p>;
    return (
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{ru ? "Место" : "Place"}</th>
              <th>{ru ? "Участник" : "Participant"}</th>
            </tr>
          </thead>
          <tbody>
            {standings.rows.map((r) => (
              <tr key={r.registration}>
                <td>{r.placement}</td>
                <td>{r.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (standings.kind === "leaderboard") {
    if (!standings.rows.length) return empty;
    return (
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>{ru ? "Участник" : "Participant"}</th>
              <th>{ru ? "Очки" : "Points"}</th>
            </tr>
          </thead>
          <tbody>
            {standings.rows.map((r) => (
              <tr key={r.registration}>
                <td>{r.rank}</td>
                <td>{r.name}</td>
                <td>{r.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const table = (rows: Extract<Standings, { kind: "table" }>["rows"]) =>
    rows.length ? (
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>{ru ? "Участник" : "Participant"}</th>
              <th title={ru ? "Матчи" : "Played"}>{ru ? "И" : "P"}</th>
              <th title={ru ? "Победы" : "Wins"}>{ru ? "В" : "W"}</th>
              <th title={ru ? "Ничьи" : "Draws"}>{ru ? "Н" : "D"}</th>
              <th title={ru ? "Поражения" : "Losses"}>{ru ? "П" : "L"}</th>
              <th>{ru ? "Очки" : "Pts"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.registration}>
                <td>{r.rank ?? i + 1}</td>
                <td>{r.name}</td>
                <td>{r.played}</td>
                <td>{r.wins}</td>
                <td>{r.draws}</td>
                <td>{r.losses}</td>
                <td>
                  <strong>{r.points}</strong>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      empty
    );
  // From stage 2 on (MV-STAGES-2) the table is the current stage's.
  const stageNote = standings.stage > 1 ? <p className="small muted">{ru ? `Этап ${standings.stage}` : `Stage ${standings.stage}`}</p> : null;
  if (standings.kind === "groups")
    return (
      <div className="stack">
        {stageNote}
        {standings.groups.map((g) => (
          <div key={g.group} className="stack-sm">
            <h2 className="h4">{groupTitle(g.group, lang)}</h2>
            {table(g.rows)}
          </div>
        ))}
      </div>
    );
  return stageNote ? (
    <div className="stack-sm">
      {stageNote}
      {table(standings.rows)}
    </div>
  ) : (
    table(standings.rows)
  );
}
