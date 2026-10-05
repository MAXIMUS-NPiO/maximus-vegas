import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, fill, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { getMatch } from "@/server/queries.ts";
import { canManageTournament, canRefereeTournament } from "@/server/tournaments.ts";
import { settingsOf } from "@/server/format-settings.ts";
import { mediaUrl } from "@/server/media.ts";
import { ActionForm, Badge, DbDown, Field, Flash, type SearchParams } from "@/components/ui";
import { Countdown, LocalDateTimeInput, LocalTime, TimeZoneField } from "@/components/time";
import { matchLabel } from "@/components/tournament";
import { noShowFrom } from "@/server/matches.ts";
import { depthKey, pointsOf, SERIES_LENGTHS, seriesOf, seriesRulesOf, type SeriesSource } from "@/server/series.ts";
import { venues as venuesOf } from "@/server/schedule.ts";
import { seriesText } from "@/components/tournament";
import { matchStep, openMatchFor, refereeCalls } from "@/server/gameday.ts";
import { gameDayText, stepText, actionText } from "@/lib/gameday-text.ts";
import { CallBlock, OpenCalls } from "@/components/referee-call";
import { liveopsText } from "@/lib/liveops-text.ts";
import { previewRepair, type Plan, type Step } from "@/server/repair.ts";
import { DomainError } from "@/server/errors.ts";
import { bracket } from "@/server/queries.ts";
import { labelContext } from "@/components/tournament";
import { vetoFor } from "@/server/veto.ts";
import { MapVeto } from "@/components/map-veto";
import { mediaText } from "@/lib/media-text.ts";
import { matchStreams } from "@/server/streams.ts";
import { portalHost, StreamsBlock } from "@/components/streams";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; id: string }> }): Promise<Metadata> {
  const { lang, id } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, `matches/${id}`, dict(lang).match.title, undefined, { noindex: true });
}

export default async function MatchPage({ params, searchParams }: { params: Promise<{ lang: string; id: string }>; searchParams: SearchParams }) {
  const { lang, id } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  const data = await getMatch(db, id);
  if (!data || data.match.t_status === "DRAFT") notFound();
  const { match: m, a, b, results, disputes } = data;
  const referee = await canRefereeTournament(db, { id: m.tournament_id, org_id: m.org_id }, user);
  // Streams of this match, then the event's while the match is still to be played (MV-MEDIA-1).
  const media = await matchStreams(db, m.id, m.tournament_id);
  const shownStreams = [...media.match, ...(["completed", "cancelled"].includes(m.status) ? [] : media.event.filter((s) => s.kind === "live"))];
  const host = shownStreams.length ? await portalHost() : "";
  const streamManager = await canManageTournament(db, { id: m.tournament_id, org_id: m.org_id }, user);
  const ru = lang === "ru";
  const inRounds = m.bracket === "RR" || m.bracket === "SW";
  const tSettings = settingsOf({ format: m.t_format, format_settings: m.t_settings });
  const roundLabel = matchLabel(
    m,
    { format: m.t_format, playoffFormat: tSettings.playoff?.format, wRounds: m.w_rounds, lRounds: m.l_rounds, gRounds: m.bracket === "G" ? m.rounds : 0 },
    lang,
  );
  const noShowAt = noShowFrom({ scheduled_at: m.scheduled_at, t_no_show: m.t_no_show });
  // Series length and points of this match under the tournament's rules (MV-SERIES-1).
  const seriesRules = seriesRulesOf({ series_rules: m.t_series });
  const series = seriesOf(seriesRules, m, { main: m.t_format, playoff: tSettings.playoff?.format ?? null }, new Map([[depthKey(m.stage ?? 1, m.bracket ?? "W"), m.rounds]]));
  const matchPoints = inRounds ? pointsOf(seriesRules, tSettings.points, m) : null;
  const sourceText: Record<SeriesSource, string> = ru
    ? { match: "задано для этого матча", round: "по правилу тура", final: "по правилу финала", semifinal: "по правилу полуфиналов", lower: "по правилу нижней сетки", group: "по правилу группы", playoff: "по правилу плей-офф", tournament: "по умолчанию турнира" }
    : { match: "set for this match", round: "by the round rule", final: "by the final rule", semifinal: "by the semi-final rule", lower: "by the lower-bracket rule", group: "by the group rule", playoff: "by the playoff rule", tournament: "the tournament's default" };
  const seriesNote =
    series.bestOf > 1
      ? ru
        ? `Счёт — число выигранных игр: победителю нужно ${(series.bestOf + 1) / 2}.`
        : `The score is games won: the winner needs ${(series.bestOf + 1) / 2}.`
      : null;
  const reported = results.some((r) => r.status === "pending" || r.status === "confirmed");
  const venueList = referee && !["completed", "cancelled"].includes(m.status) ? await venuesOf(db, m.tournament_id) : [];
  // Once the next stage exists (a chained stage or the playoff), the stage that seeded it is final.
  const stageLocked = (m.stage ?? 1) < (m.t_stage ?? 1);
  const chained = Boolean(tSettings.chain?.length);
  const drawsOk = inRounds && tSettings.allowDraws;
  const drawn = m.status === "completed" && !m.winner_reg && Boolean(m.a_reg && m.b_reg);
  const drawNote = inRounds
    ? drawsOk
      ? ru
        ? "Ничья допускается: укажите равный счёт."
        : "Draws are allowed: enter an equal score."
      : ru
        ? "Ничьи в этом турнире не допускаются."
        : "Draws are not allowed in this tournament."
    : null;

  const mySide = user ? (a?.leaders.includes(user.id) ? "a" : b?.leaders.includes(user.id) ? "b" : null) : null;
  // A participant is a leader of a side or a player on its roster; only leaders act for the side.
  const inSide = (s: typeof a) => Boolean(user && s && (s.leaders.includes(user.id) || s.roster.includes(user.username)));
  const viewerSide: "a" | "b" | null = mySide ?? (inSide(a) ? "a" : inSide(b) ? "b" : null);
  const openPost = disputes.find((x) => x.kind === "post_result" && x.status === "open");
  // A decided winner can be disputed; a draw is corrected by the referee (versioned, logged).
  const canFilePost =
    Boolean(mySide) && m.status === "completed" && m.outcome !== "bye" && Boolean(m.winner_reg) && ["IN_PROGRESS", "PAUSED", "COMPLETED"].includes(m.t_status) && !openPost && !stageLocked;
  const live = m.t_status === "IN_PROGRESS";
  const pending = results.find((r) => r.status === "pending");
  const viewerReg = viewerSide === "a" ? m.a_reg : viewerSide === "b" ? m.b_reg : null;
  const liveOrPaused = ["IN_PROGRESS", "PAUSED"].includes(m.t_status);
  const nextOpen = viewerReg && liveOrPaused ? await openMatchFor(db, m.tournament_id, viewerReg, m.id) : null;
  const step = viewerSide
    ? matchStep({
        tStatus: m.t_status,
        status: m.status,
        outcome: m.outcome,
        side: viewerSide,
        aReg: m.a_reg,
        bReg: m.b_reg,
        winnerReg: m.winner_reg,
        checkedIn: { a: Boolean(m.a_checked_in_at), b: Boolean(m.b_checked_in_at) },
        pendingSide: (pending?.side as "a" | "b" | null | undefined) ?? null,
        noShowAt,
        hasNext: Boolean(nextOpen),
        paused: Boolean(m.paused_at),
        now: new Date(),
      })
    : null;
  const lo = liveopsText[lang];
  const vetoView = m.a_reg && m.b_reg ? await vetoFor(db, m.id, user?.id) : null;
  // Correction of a decided elimination match goes through a preview of its consequences (bracket repair).
  const elimination = ["W", "L", "GF"].includes(m.bracket ?? "");
  const first = (x: string | string[] | undefined) => (Array.isArray(x) ? x[0] : x) ?? "";
  let repairView: { plan: Plan | null; error: string | null; scoreA: string; scoreB: string; text: (s: Step) => string } | null = null;
  if (referee && elimination && m.status === "completed" && first(sp.repair) === "1") {
    const scoreA = first(sp.scoreA);
    const scoreB = first(sp.scoreB);
    let plan: Plan | null = null;
    let error: string | null = null;
    try {
      plan = await previewRepair(db, m.id, { scoreA, scoreB });
    } catch (e) {
      error = e instanceof DomainError ? e.code : "server_error";
    }
    const rows = plan?.steps.length ? await bracket(db, m.tournament_id) : [];
    const ctx = labelContext(rows, m.t_format, tSettings.playoff?.format);
    const names = new Map<string, string>();
    for (const r of rows) {
      if (r.a_reg && r.a_name) names.set(r.a_reg, r.a_name);
      if (r.b_reg && r.b_name) names.set(r.b_reg, r.b_name);
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const nm = (reg: string | null) => (reg ? names.get(reg) ?? "—" : lo.noEntrant);
    const where = (id: string) => {
      const r = byId.get(id);
      return r ? `${matchLabel(r, ctx, lang)} (${r.a_name ?? d.common.tbd} — ${r.b_name ?? d.common.tbd})` : id;
    };
    const fillText = (t: string, vars: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
    const text = (s: Step) => {
      if (s.kind === "remove_reset") return s.annulled ? `${lo.stepRemoveReset} (${s.annulled.scoreA ?? "–"} : ${s.annulled.scoreB ?? "–"})` : lo.stepRemoveReset;
      const vars = { match: where(s.matchId), from: nm(s.from), to: nm(s.to), score: s.kind === "replay" ? `${s.annulled.scoreA ?? "–"} : ${s.annulled.scoreB ?? "–"}` : "" };
      if (s.kind === "replay") return fillText(s.from && s.to ? lo.stepReplayWith : lo.stepReplay, vars);
      return fillText(!s.to ? lo.stepClear : !s.from ? lo.stepFill : lo.stepReplace, vars);
    };
    repairView = { plan, error, scoreA, scoreB, text };
  }
  const calls = viewerSide || referee ? await refereeCalls(db, m.id) : [];
  const g = gameDayText[lang];
  const confirmed = results.find((r) => r.status === "confirmed");
  const inControl=first(sp.control)==="1" && Boolean(user?.roles.includes("admin"));
  const controlBack=`/${lang}/admin?tab=tournaments&event=${encodeURIComponent(m.t_slug)}`;
  const back = inControl?`${controlBack}&match=${m.id}`:`/${lang}/matches/${m.id}`;
  const hidden = { match: m.id };
  const open = !["completed", "cancelled"].includes(m.status);
  const both = Boolean(a && b);

  const sideCard = (s: typeof a, key: "a" | "b") => {
    const score = key === "a" ? m.score_a : m.score_b;
    const isWinner = m.winner_reg && s && m.winner_reg === s.reg;
    return (
      <div className={`side-card${isWinner ? " is-winner" : ""}${mySide === key ? " is-mine" : ""}`}>
        {s ? (
          <>
            <p className="side-name">
              {s.team_slug ? (
                <Link href={`/${lang}/teams/${s.team_slug}`}>{s.name}</Link>
              ) : s.username ? (
                <Link href={`/${lang}/players/${s.username}`}>{s.name}</Link>
              ) : (
                s.name
              )}
              {mySide === key ? <span className="badge badge-info">{d.common.you}</span> : null}
            </p>
            {s.team_slug ? (
              <p className="small muted">
                {d.match.rosterTitle}: {s.roster.join(", ")}
              </p>
            ) : null}
          </>
        ) : (
          <p className="side-name muted">{d.common.tbd}</p>
        )}
        <p className="side-score">{score ?? (isWinner && m.outcome !== "played" ? "W" : "–")}</p>
      </div>
    );
  };

  return (
    <div className="container page">
      <p className="eyebrow">
        <Link href={inControl?controlBack:`/${lang}/tournaments/${m.t_slug}`}>{m.t_name}</Link> · {roundLabel} · {d.match.gameDay}
      </p>
      <div className="row-between">
        <h1>
          {a?.name ?? d.common.tbd} <span className="muted">{d.common.vs}</span> {b?.name ?? d.common.tbd}
        </h1>
        <Badge status={m.status}>{d.statuses.match[m.status]}</Badge>
      </div>
      <Flash lang={lang} params={sp} />
      {m.paused_at && open ? (
        <div className="notice notice-warn" role="status">
          <strong>{m.pause_reason ? `${lo.pausedBanner}: ${m.pause_reason}` : lo.pausedBanner}</strong>
          <span className="small">
            <LocalTime iso={m.paused_at} lang={lang} />
          </span>
        </div>
      ) : null}

      <div className="versus">
        {sideCard(a, "a")}
        {sideCard(b, "b")}
      </div>

      <div className="grid grid-3 facts">
        <div className="card">
          <p className="field-label">{d.match.whatNow}</p>
          {step ? (
            <>
              <p>
                <strong>
                  {stepText(step.key, lang, {
                    series: series.bestOf > 1 ? seriesText(series.bestOf, lang) : undefined,
                    score: pending ? `${a?.name ?? "A"} ${pending.score_a} : ${pending.score_b} ${b?.name ?? "B"}` : undefined,
                    reason: m.pause_reason || undefined,
                    vetoAction: vetoView?.state.next?.action,
                  })}
                </strong>
              </p>
              {step.deadline ? (
                <p className="small">
                  {g.deadline} <LocalTime iso={step.deadline} lang={lang} /> · <Countdown iso={step.deadline} lang={lang} />
                </p>
              ) : null}
              {step.action === "next" && nextOpen ? (
                <Link href={`/${lang}/matches/${nextOpen.id}`} className="btn btn-primary btn-sm">
                  {actionText("next", lang)}
                </Link>
              ) : null}
              <Link href={`/${lang}/gameday`} className="text-link small">
                {g.title}
              </Link>
            </>
          ) : (
            <p>{m.t_status === "PAUSED" ? d.statuses.tournament.PAUSED : d.match.explain[m.status]}</p>
          )}
          {m.outcome && m.outcome !== "played" ? <p className="small muted">{d.statuses.outcome[m.outcome]}</p> : null}
          {drawn ? <p className="small muted">{ru ? "Ничья: обе стороны получают очки за ничью." : "A draw: both sides earn draw points."}</p> : null}
          <p className="small">
            {ru ? "Формат" : "Format"}: <strong>{seriesText(series.bestOf, lang)}</strong> <span className="muted">· {sourceText[series.source]}</span>
          </p>
          {matchPoints && matchPoints.source !== "tournament" ? (
            <p className="small">
              {ru ? "Очки этого матча" : "Points of this match"}: {matchPoints.points.win} / {matchPoints.points.draw} / {matchPoints.points.loss}{" "}
              <span className="muted">· {sourceText[matchPoints.source]}</span>
            </p>
          ) : null}
        </div>
        <div className="card">
          <p className="field-label">{d.match.scheduled}</p>
          <p>{m.scheduled_at ? <LocalTime iso={m.scheduled_at} lang={lang} /> : <span className="muted">{d.match.notScheduled}</span>}</p>
          {m.venue_name ? (
            <p className="small">
              {ru ? "Площадка" : "Venue"}: <strong>{m.venue_name}</strong>
            </p>
          ) : null}
          <p className="small muted">{d.common.timeNote}</p>
        </div>
        <div className="card">
          <p className="field-label">{d.match.room}</p>
          {m.room_code ? <p className="mono">{m.room_code}</p> : <p className="muted small">{d.match.noRoom}</p>}
          {open && (mySide || referee) ? (
            <ActionForm action="match.details" lang={lang} back={back} hidden={hidden} className="inline-form">
              <input name="roomCode" maxLength={80} placeholder={d.match.setRoom} aria-label={d.match.setRoom} defaultValue={m.room_code} />
              <button className="btn btn-ghost btn-sm">{d.match.save}</button>
            </ActionForm>
          ) : null}
        </div>
      </div>

      <StreamsBlock lang={lang} host={host} title={mediaText[lang].manage} streams={shownStreams} />
      {streamManager ? (
        <p className="small">
          <Link href={`/${lang}/organizer/t/${m.t_slug}#streams`} className="text-link">
            {mediaText[lang].manage} · {mediaText[lang].overlay}
          </Link>
        </p>
      ) : null}

      {live && both && ["ready", "in_progress"].includes(m.status) ? (
        <section className="card checkin-card" aria-label={ru ? "Check-in к матчу" : "Match check-in"}>
          <p className="field-label">{ru ? "Check-in к матчу" : "Match check-in"}</p>
          <div className="row">
            <span>
              {a?.name}: {m.a_checked_in_at ? <Badge status="ok">{ru ? "на месте" : "here"}</Badge> : <Badge status="muted">{ru ? "нет отметки" : "not yet"}</Badge>}
            </span>
            <span>
              {b?.name}: {m.b_checked_in_at ? <Badge status="ok">{ru ? "на месте" : "here"}</Badge> : <Badge status="muted">{ru ? "нет отметки" : "not yet"}</Badge>}
            </span>
            {mySide && !m.paused_at && !(mySide === "a" ? m.a_checked_in_at : m.b_checked_in_at) ? (
              <ActionForm action="match.checkin" lang={lang} back={back} hidden={hidden}>
                <button className="btn btn-primary btn-sm">{ru ? "Отметиться" : "Check in"}</button>
              </ActionForm>
            ) : null}
          </div>
          <p className="small muted">{ru ? "Отметка помогает организатору видеть, кто на месте. Она не блокирует матч: неявку фиксирует судья." : "Check-in shows the organiser who is here. It never blocks the match: the referee records no-shows."}</p>
        </section>
      ) : null}

      {vetoView && a && b && ((open && liveOrPaused) || vetoView.state.done.length) ? (
        <MapVeto lang={lang} matchId={m.id} names={{ a: a.name, b: b.name }} veto={vetoView} mySide={viewerSide} leader={Boolean(mySide)} staff={referee && open} back={back} />
      ) : null}

      {viewerSide && open && liveOrPaused && both ? (
        <section className="card" aria-label={g.referee}>
          <CallBlock lang={lang} matchId={m.id} calls={calls.filter((c) => c.side === viewerSide)} open={step?.action === "call_referee"} canCall back={back} />
        </section>
      ) : null}

      {confirmed ? (
        <p className="notice notice-ok">
          {d.match.verification}: <strong>{d.statuses.source[confirmed.source]}</strong>
          {confirmed.evidence_url ? (
            <>
              {" "}
              ·{" "}
              <a href={confirmed.evidence_url} target="_blank" rel="noopener noreferrer nofollow" className="text-link">
                {lang === "ru" ? "доказательство" : "evidence"}
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      {live && mySide && both && !m.paused_at ? (
        <section className="card action-card" id="report">
          {m.status === "result_submitted" && pending && pending.side !== mySide ? (
            <>
              <h2 className="h3">{d.match.confirmTitle}</h2>
              <p className="big-score">
                {a?.name} {pending.score_a} : {pending.score_b} {b?.name}
              </p>
              {pending.evidence_url ? (
                <a href={pending.evidence_url} target="_blank" rel="noopener noreferrer nofollow" className="text-link">
                  {lang === "ru" ? "Доказательство соперника" : "Opponent's evidence"}
                </a>
              ) : null}
              {pending.note ? <p className="small muted prewrap">{pending.note}</p> : null}
              <ActionForm action="match.confirm" lang={lang} back={back} hidden={hidden}>
                <button className="btn btn-primary">{d.match.confirm}</button>
              </ActionForm>
              <details className="disclosure">
                <summary>{d.match.disputeTitle}</summary>
                <ActionForm action="match.dispute" lang={lang} back={back} hidden={hidden} className="stack">
                  <Field label={d.match.disputeReason}>
                    <textarea name="reason" required minLength={5} maxLength={1000} rows={3} />
                  </Field>
                  <button className="btn btn-danger btn-sm">{d.match.dispute}</button>
                </ActionForm>
              </details>
            </>
          ) : ["ready", "in_progress", "result_submitted"].includes(m.status) ? (
            <>
              {m.status === "result_submitted" && pending?.side === mySide ? <p className="notice">{d.match.waitingOpponent}</p> : null}
              <h2 className="h3">{d.match.reportTitle}</h2>
              <ActionForm action="match.submit" lang={lang} back={back} hidden={hidden} className="stack">
                <div className="score-inputs">
                  <Field label={`${d.match.scoreFor}: ${a?.name}`}>
                    <input name="scoreA" type="number" min={0} max={999} required inputMode="numeric" />
                  </Field>
                  <Field label={`${d.match.scoreFor}: ${b?.name}`}>
                    <input name="scoreB" type="number" min={0} max={999} required inputMode="numeric" />
                  </Field>
                </div>
                {seriesNote ? <p className="small muted">{seriesNote}</p> : drawNote ? <p className="small muted">{drawNote}</p> : null}
                <Field label={d.match.evidence}>
                  <input name="evidence" type="url" maxLength={500} placeholder="https://" />
                </Field>
                <Field label={d.match.note}>
                  <textarea name="note" rows={2} maxLength={1000} />
                </Field>
                <button className="btn btn-primary">{d.match.submit}</button>
              </ActionForm>
              {m.status === "ready" ? (
                <ActionForm action="match.details" lang={lang} back={back} hidden={{ ...hidden, live: "1" }}>
                  <button className="btn btn-ghost btn-sm">{d.match.markLive}</button>
                </ActionForm>
              ) : null}
            </>
          ) : m.status === "disputed" ? (
            <p>{d.match.explain.disputed}</p>
          ) : null}
        </section>
      ) : null}

      {referee && calls.some((c) => c.status === "open") ? (
        <section className="card action-card referee">
          <OpenCalls lang={lang} calls={calls} back={back} sideNames={{ a: a?.name, b: b?.name }} />
        </section>
      ) : null}

      {referee && (live || m.t_status === "COMPLETED") ? (
        <section className="card action-card referee">
          {open && live && both ? (
            <>
              <h2 className="h3">{d.match.refereeTitle}</h2>
              <p className="small muted">{d.match.refereeNote}</p>
              <ActionForm action="match.official" lang={lang} back={back} hidden={hidden} className="stack">
                <div className="score-inputs">
                  <Field label={`${d.match.scoreFor}: ${a?.name}`}>
                    <input name="scoreA" type="number" min={0} max={999} required defaultValue={pending?.score_a ?? undefined} />
                  </Field>
                  <Field label={`${d.match.scoreFor}: ${b?.name}`}>
                    <input name="scoreB" type="number" min={0} max={999} required defaultValue={pending?.score_b ?? undefined} />
                  </Field>
                </div>
                {seriesNote ? <p className="small muted">{seriesNote}</p> : drawNote ? <p className="small muted">{drawNote}</p> : null}
                <Field label={d.match.resolution} hint={lo.overrideNote}>
                  <textarea name="resolution" rows={2} maxLength={1000} />
                </Field>
                <Field label={d.match.evidence}>
                  <input name="evidence" type="url" maxLength={500} placeholder="https://" />
                </Field>
                <button className="btn btn-primary">{d.match.decide}</button>
              </ActionForm>
              <div className="stack-sm">
                <p className="field-label">{lo.pauseTitle}</p>
                {m.paused_at ? (
                  <ActionForm action="match.resume" lang={lang} back={back} hidden={hidden}>
                    <button className="btn btn-primary btn-sm">{lo.resume}</button>
                  </ActionForm>
                ) : (
                  <ActionForm action="match.pause" lang={lang} back={back} hidden={hidden} className="inline-form">
                    <input name="reason" required minLength={3} maxLength={300} placeholder={lo.pauseReason} aria-label={lo.pauseReason} />
                    <button className="btn btn-ghost btn-sm">{lo.pause}</button>
                  </ActionForm>
                )}
                <p className="small muted">{lo.pauseNote}</p>
              </div>
              {noShowAt && noShowAt.getTime() > Date.now() ? (
                <p className="small muted">
                  {ru ? "Неявку по правилам турнира можно отметить с " : "Under the tournament rules a no-show can be recorded from "}
                  <LocalTime iso={noShowAt} lang={lang} />.
                </p>
              ) : (
                <div className="row">
                  <span className="field-label">{d.match.noShowTitle}:</span>
                  <ActionForm action="match.noshow" lang={lang} back={back} hidden={{ ...hidden, absent: "a" }}>
                    <button className="btn btn-ghost btn-sm">{fill(d.match.noShowA, { a: a?.name })}</button>
                  </ActionForm>
                  <ActionForm action="match.noshow" lang={lang} back={back} hidden={{ ...hidden, absent: "b" }}>
                    <button className="btn btn-ghost btn-sm">{fill(d.match.noShowB, { b: b?.name })}</button>
                  </ActionForm>
                </div>
              )}
            </>
          ) : null}
          {open ? (
            <ActionForm action="match.details" lang={lang} back={back} hidden={hidden} className="stack-sm">
              <TimeZoneField />
              <div className="inline-form">
                <label className="field-label" htmlFor="sched">
                  {d.match.scheduleTitle}
                </label>
                <span id="sched">
                  <LocalDateTimeInput name="scheduledAt" iso={m.scheduled_at ? new Date(m.scheduled_at).toISOString() : null} />
                </span>
                {venueList.length ? (
                  <select name="venueId" defaultValue={m.venue_id ?? ""} aria-label={ru ? "Площадка" : "Venue"}>
                    <option value="">{ru ? "Без площадки" : "No venue"}</option>
                    {venueList.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <button className="btn btn-ghost btn-sm">{d.match.save}</button>
              </div>
              <label className="check small">
                <input type="checkbox" name="force" value="1" />
                <span>{ru ? "Сохранить, даже если площадка или участник заняты в это время" : "Save even if the venue or an entrant is busy at that time"}</span>
              </label>
            </ActionForm>
          ) : null}
          {open && ["IN_PROGRESS", "PAUSED"].includes(m.t_status) && !reported ? (
            <details className="disclosure">
              <summary>{ru ? "Формат этого матча" : "This match's format"}</summary>
              <p className="small muted">
                {ru
                  ? "До первого результата судья может задать серию и (для матчей таблицы) очки только для этого матча. Пустое значение возвращает правила тура, группы, этапа и турнира."
                  : "Before the first result a referee may set the series and (for table matches) the points of this match only. Empty values restore the round, group, stage and tournament rules."}
              </p>
              <ActionForm action="match.format" lang={lang} back={back} hidden={hidden} className="stack-sm">
                <Field label={ru ? "Серия" : "Series"}>
                  <select name="series" defaultValue={m.series_override ? String(m.series_override) : ""}>
                    <option value="">{ru ? "По правилам турнира" : "By the tournament rules"}</option>
                    {SERIES_LENGTHS.map((n) => (
                      <option key={n} value={String(n)}>
                        {seriesText(n, lang)}
                      </option>
                    ))}
                  </select>
                </Field>
                {inRounds ? (
                  <div className="form-grid form-grid-4">
                    {(["Win", "Draw", "Loss", ...(m.t_format === "swiss" ? ["Bye"] : [])] as const).map((k) => (
                      <Field key={k} label={ru ? ({ Win: "Победа", Draw: "Ничья", Loss: "Поражение", Bye: "Bye" } as Record<string, string>)[k] : k}>
                        <input
                          name={`points${k}`}
                          type="number"
                          min={0}
                          max={100}
                          inputMode="numeric"
                          defaultValue={
                            (m.points_override as Record<string, number> | null)?.[k.toLowerCase()] ?? ""
                          }
                        />
                      </Field>
                    ))}
                  </div>
                ) : null}
                <button className="btn btn-ghost btn-sm">{d.common.save}</button>
              </ActionForm>
            </details>
          ) : null}
          {m.status === "completed" && m.outcome !== "bye" && both && stageLocked ? (
            <p className="small muted">
              {chained
                ? ru
                  ? "Следующий этап уже начался: результат этого этапа зафиксирован и не исправляется."
                  : "The next stage has started: this stage's result is final and cannot be corrected."
                : ru
                  ? "Плей-офф уже начался: результат основного этапа зафиксирован и не исправляется."
                  : "The playoff has started: this main-stage result is final and cannot be corrected."}
            </p>
          ) : m.status === "completed" && m.outcome !== "bye" && both && elimination ? (
            <details className="disclosure" id="repair" open={Boolean(repairView)}>
              <summary>{lo.repairTitle}</summary>
              <p className="small muted">{lo.repairLead}</p>
              <form method="get" action={inControl?`/${lang}/admin#repair`:`/${lang}/matches/${m.id}#repair`} className="stack">
                {inControl?<><input type="hidden" name="tab" value="tournaments"/><input type="hidden" name="event" value={m.t_slug}/><input type="hidden" name="match" value={m.id}/></>:null}
                <input type="hidden" name="repair" value="1" />
                <div className="score-inputs">
                  <Field label={`${d.match.scoreFor}: ${a?.name}`}>
                    <input name="scoreA" type="number" min={0} max={999} required defaultValue={repairView?.scoreA || (m.score_a ?? undefined)} />
                  </Field>
                  <Field label={`${d.match.scoreFor}: ${b?.name}`}>
                    <input name="scoreB" type="number" min={0} max={999} required defaultValue={repairView?.scoreB || (m.score_b ?? undefined)} />
                  </Field>
                </div>
                {seriesNote ? <p className="small muted">{seriesNote}</p> : null}
                <button className="btn btn-ghost btn-sm">{lo.preview}</button>
              </form>
              {repairView?.error ? <p className="notice notice-bad">{d.errors[repairView.error] ?? repairView.error}</p> : null}
              {repairView?.plan ? (
                <div className="stack-sm">
                  <p className="field-label">{lo.consequences}</p>
                  {repairView.plan.steps.length ? (
                    <ul className="plain-list small">
                      {repairView.plan.steps.map((s, i) => (
                        <li key={`${s.kind}-${s.matchId}-${i}`}>{repairView!.text(s)}</li>
                      ))}
                    </ul>
                  ) : null}
                  {!repairView.plan.steps.some((s) => s.kind !== "replace") ? <p className="small muted">{lo.noConsequences}</p> : null}
                  {repairView.plan.reopens ? <p className="notice notice-warn">{lo.reopens}</p> : null}
                  <ActionForm
                    action="match.repair"
                    lang={lang}
                    back={back}
                    hidden={{ ...hidden, scoreA: repairView.scoreA, scoreB: repairView.scoreB, plan: repairView.plan.hash }}
                    className="stack"
                  >
                    <Field label={d.match.correctReason}>
                      <textarea name="note" required minLength={5} rows={2} maxLength={1000} />
                    </Field>
                    <Field label={d.match.evidence}>
                      <input name="evidence" type="url" maxLength={500} placeholder="https://" />
                    </Field>
                    <button className="btn btn-danger btn-sm">{lo.apply}</button>
                  </ActionForm>
                </div>
              ) : null}
            </details>
          ) : m.status === "completed" && m.outcome !== "bye" && both ? (
            <details className="disclosure">
              <summary>{d.match.correctTitle}</summary>
              <p className="small muted">{d.match.correctNote}</p>
              <ActionForm action="match.correct" lang={lang} back={back} hidden={hidden} className="stack">
                <div className="score-inputs">
                  <Field label={`${d.match.scoreFor}: ${a?.name}`}>
                    <input name="scoreA" type="number" min={0} max={999} required defaultValue={m.score_a ?? undefined} />
                  </Field>
                  <Field label={`${d.match.scoreFor}: ${b?.name}`}>
                    <input name="scoreB" type="number" min={0} max={999} required defaultValue={m.score_b ?? undefined} />
                  </Field>
                </div>
                {seriesNote ? <p className="small muted">{seriesNote}</p> : drawNote ? <p className="small muted">{drawNote}</p> : null}
                <Field label={d.match.correctReason}>
                  <textarea name="note" required minLength={5} rows={2} maxLength={1000} />
                </Field>
                <button className="btn btn-danger btn-sm">{d.match.correct}</button>
              </ActionForm>
            </details>
          ) : null}
        </section>
      ) : null}

      {canFilePost ? (
        <details className="disclosure card">
          <summary>{ru ? "Оспорить решённый результат" : "Dispute this decided result"}</summary>
          <p className="small muted">
            {ru
              ? "Опишите, что произошло, и приложите доказательство. Организатор оставит результат в силе или отменит его. Необоснованное оспаривание снижает репутацию."
              : "Describe what happened and attach evidence. The organiser upholds or overturns the result. An unfounded dispute lowers your reputation."}
          </p>
          <form method="post" action={`/api/a/dispute.file?lang=${lang}`} encType="multipart/form-data" className="stack">
            <input type="hidden" name="lang" value={lang} />
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="match" value={m.id} />
            <Field label={ru ? "Что произошло" : "What happened"}>
              <textarea name="reason" required minLength={10} maxLength={1000} rows={3} />
            </Field>
            <Field label={ru ? "Ссылка на доказательство" : "Evidence link"} hint={d.common.optional}>
              <input name="evidence" type="url" maxLength={500} placeholder="https://" />
            </Field>
            <Field label={ru ? "Изображение-доказательство" : "Evidence image"} hint={ru ? "PNG, JPEG или WebP до 1,5 МБ. Видят только участники матча и судьи." : "PNG, JPEG or WebP up to 1.5 MB. Only the match's participants and referees can see it."}>
              <input name="evidenceImage" type="file" accept="image/png,image/jpeg,image/webp" />
            </Field>
            <button className="btn btn-danger btn-sm">{ru ? "Отправить оспаривание" : "Submit dispute"}</button>
          </form>
        </details>
      ) : null}

      {referee && openPost ? (
        <section className="card action-card referee">
          <h2 className="h3">{ru ? "Оспаривание решённого матча" : "Dispute of a decided match"}</h2>
          <p className="prewrap">{openPost.reason}</p>
          {openPost.evidence_url ? (
            <a href={openPost.evidence_url} target="_blank" rel="noopener noreferrer nofollow" className="text-link">
              {ru ? "Доказательство" : "Evidence"} ↗
            </a>
          ) : null}
          {openPost.evidence_media_id ? (
            <a href={mediaUrl(openPost.evidence_media_id)!} target="_blank" rel="noopener" className="text-link">
              {ru ? "Изображение" : "Image"} ↗
            </a>
          ) : null}
          <p className="small muted">
            {ru
              ? "Отмена результата передаёт победу другой стороне и обновляет сетку. Если следующий матч уже сыгран, отмена заблокирована. Для финала пересчитываются места и награда без изъятия ранее выплаченного."
              : "Overturning gives the win to the other side and updates the bracket. If the next match was already played, it is blocked. For the deciding match, placements and the award are re-settled without clawing back anything paid."}
          </p>
          <div className="grid grid-2">
            <ActionForm action="dispute.decide" lang={lang} back={back} hidden={{ dispute: openPost.id, decision: "uphold" }} className="stack">
              <Field label={ru ? "Обоснование" : "Reasoning"}>
                <textarea name="note" required minLength={5} maxLength={1000} rows={2} />
              </Field>
              <button className="btn btn-ghost btn-sm">{ru ? "Оставить результат в силе" : "Uphold the result"}</button>
            </ActionForm>
            {stageLocked ? (
              <p className="small muted">
                {chained
                  ? ru
                    ? "Отмена недоступна: следующий этап уже начался и результаты этого этапа зафиксированы."
                    : "Overturning is unavailable: the next stage has started and this stage's results are final."
                  : ru
                    ? "Отмена недоступна: плей-офф уже начался и результаты основного этапа зафиксированы."
                    : "Overturning is unavailable: the playoff has started and main-stage results are final."}
              </p>
            ) : (
              <ActionForm action="dispute.decide" lang={lang} back={back} hidden={{ dispute: openPost.id, decision: "overturn" }} className="stack">
                <Field label={ru ? "Обоснование" : "Reasoning"}>
                  <textarea name="note" required minLength={5} maxLength={1000} rows={2} />
                </Field>
                <button className="btn btn-danger btn-sm">{ru ? "Отменить результат" : "Overturn the result"}</button>
              </ActionForm>
            )}
          </div>
        </section>
      ) : null}

      <section className="section-tight">
        <h2 className="h3">{d.match.history}</h2>
        {results.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{d.match.scoreFor}</th>
                  <th>{d.match.verification}</th>
                  <th>{d.match.status}</th>
                  <th>{d.common.createdAt}</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.id}>
                    <td>v{r.version}</td>
                    <td>
                      {r.outcome === "no_show" ? d.statuses.outcome.no_show : r.outcome === "decision" ? d.statuses.outcome.decision : `${r.score_a} : ${r.score_b}`}
                      {r.evidence_url ? (
                        <>
                          {" "}
                          <a href={r.evidence_url} target="_blank" rel="noopener noreferrer nofollow" className="text-link small">
                            ↗
                          </a>
                        </>
                      ) : null}
                      {r.note ? <div className="small muted prewrap">{r.note}</div> : null}
                    </td>
                    <td className="small">
                      {d.statuses.source[r.source]} · {d.match.by} {r.submitted_by}
                    </td>
                    <td>
                      <Badge status={r.status}>{d.match.versionStatus[r.status]}</Badge>
                    </td>
                    <td className="small">
                      <LocalTime iso={r.created_at} lang={lang} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{d.match.noHistory}</p>
        )}
      </section>

      {disputes.length ? (
        <section className="section-tight">
          <h2 className="h3">{d.match.disputes}</h2>
          <ul className="list">
            {disputes.map((x) => (
              <li key={x.id} className="stack-sm">
                <div className="row-between">
                  <span className="small">
                    {x.opened_by} · <LocalTime iso={x.created_at} lang={lang} />
                  </span>
                  <Badge status={x.status}>{d.match.disputeStatus[x.status]}</Badge>
                </div>
                {x.kind === "post_result" ? <p className="small muted">{ru ? "Оспаривание решённого результата" : "Dispute of a decided result"}</p> : null}
                <p className="prewrap">{x.reason === "conflicting_results" ? (lang === "ru" ? "Стороны отправили разные результаты" : "The sides submitted different results") : x.reason}</p>
                {x.evidence_url ? (
                  <a href={x.evidence_url} target="_blank" rel="noopener noreferrer nofollow" className="text-link small">
                    {ru ? "доказательство" : "evidence"} ↗
                  </a>
                ) : null}
                {x.evidence_media_id && (referee || mySide) ? (
                  <a href={mediaUrl(x.evidence_media_id)!} target="_blank" rel="noopener" className="text-link small">
                    {ru ? "изображение" : "image"} ↗
                  </a>
                ) : null}
                {x.decision ? (
                  <Badge status={x.decision}>{x.decision === "overturned" ? (ru ? "Результат отменён" : "Overturned") : ru ? "Результат в силе" : "Upheld"}</Badge>
                ) : null}
                {x.resolution && x.resolution !== "result_confirmed" ? <p className="small muted prewrap">{x.resolution}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="row">
        <Link href={inControl?controlBack:`/${lang}/tournaments/${m.t_slug}#bracket`} className="btn btn-ghost btn-sm">
          {d.match.toTournament}
        </Link>
        {data.nextMatch ? (
          <Link href={`/${lang}/matches/${data.nextMatch.id}`} className="btn btn-ghost btn-sm">
            {d.match.next}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
