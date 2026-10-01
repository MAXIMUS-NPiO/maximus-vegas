import type { Locale } from "@/lib/i18n.ts";
import type { VetoState } from "@/server/veto.ts";
import { ActionForm, Badge } from "@/components/ui";
import { seriesText } from "@/components/tournament";

const T = {
  ru: {
    title: "Вето карт",
    rules: "Правила MV-VETO-1",
    pool: "пул",
    maps: "карт",
    ban: "бан",
    pick: "пик",
    turn: "ход",
    yourTurn: "Ваш ход",
    decider: "решающая",
    played: "Карты матча",
    banHint: "Нажмите карту, которую убираете из пула.",
    pickHint: "Нажмите карту, которую выбираете для серии.",
    waiting: "Ждём ход соперника.",
    resetReason: "Причина сброса (её увидят обе стороны)",
    reset: "Сбросить вето",
    leaderOnly: "Ходы делают капитан или владелец команды.",
  },
  en: {
    title: "Map veto",
    rules: "Rules MV-VETO-1",
    pool: "pool of",
    maps: "maps",
    ban: "ban",
    pick: "pick",
    turn: "turn",
    yourTurn: "Your turn",
    decider: "decider",
    played: "Maps of the match",
    banHint: "Choose the map you remove from the pool.",
    pickHint: "Choose the map you pick for the series.",
    waiting: "Waiting for your opponent's turn.",
    resetReason: "Reason for the reset (both sides see it)",
    reset: "Reset the veto",
    leaderOnly: "The team's captain or owner takes the turns.",
  },
};

/** The veto of one match: the turns taken and to come, the maps to play, and the buttons for the side whose turn it is. */
export function MapVeto({
  lang,
  matchId,
  names,
  veto,
  mySide,
  leader,
  staff,
  back,
}: {
  lang: Locale;
  matchId: string;
  names: { a: string; b: string };
  veto: { state: VetoState; pool: string[]; bestOf: number };
  /** The viewer's side when they play in the match. */
  mySide: "a" | "b" | null;
  /** The viewer may act for their side (solo player, team captain or owner). */
  leader: boolean;
  staff: boolean;
  back: string;
}) {
  const x = T[lang];
  const { state } = veto;
  const ourTurn = Boolean(state.next && mySide && state.next.side === mySide);
  const byStep = new Map(state.done.map((r) => [r.step, r]));
  return (
    <section className="card veto" id="veto" aria-label={x.title}>
      <div className="row-between">
        <p className="field-label">{x.title}</p>
        <span className="small muted">
          {seriesText(veto.bestOf, lang)} · {x.pool} {veto.pool.length} {x.maps} · {x.rules}
        </span>
      </div>
      <ol className="veto-steps">
        {state.turns.map((t) => {
          const done = byStep.get(t.step);
          const next = state.next?.step === t.step;
          return (
            <li key={t.step} className={done ? "is-done" : next ? "is-next" : "is-later"}>
              <span className="veto-who">{t.side === "a" ? names.a : names.b}</span>
              <span className={`veto-act veto-${t.action}`}>{t.action === "ban" ? x.ban : x.pick}</span>
              <span className="veto-map">{done ? done.map : next ? <Badge status="ready">{x.turn}</Badge> : "—"}</span>
            </li>
          );
        })}
      </ol>
      {state.complete ? (
        <p className="small">
          <strong>{x.played}:</strong>{" "}
          {state.maps.map((m, i) => `${i + 1}. ${m.map} (${m.by ? `${x.pick} ${m.by === "a" ? names.a : names.b}` : x.decider})`).join(" · ")}
        </p>
      ) : ourTurn && leader && state.next ? (
        <div className="stack-sm">
          <p className="small">
            <strong>{x.yourTurn}:</strong> {state.next.action === "ban" ? x.banHint : x.pickHint}
          </p>
          <div className="veto-maps">
            {state.remaining.map((map) => (
              <ActionForm key={map} action="match.veto" lang={lang} back={back} hidden={{ match: matchId, map }}>
                <button className={`btn btn-sm ${state.next!.action === "pick" ? "btn-primary" : "btn-ghost"}`}>{map}</button>
              </ActionForm>
            ))}
          </div>
        </div>
      ) : ourTurn ? (
        <p className="small muted">{x.leaderOnly}</p>
      ) : mySide ? (
        <p className="small muted">{x.waiting}</p>
      ) : null}
      {staff && state.done.length ? (
        <ActionForm action="match.veto_reset" lang={lang} back={back} hidden={{ match: matchId }} className="inline-form">
          <input name="reason" required minLength={3} maxLength={300} placeholder={x.resetReason} aria-label={x.resetReason} />
          <button className="btn btn-ghost btn-sm">{x.reset}</button>
        </ActionForm>
      ) : null}
    </section>
  );
}
