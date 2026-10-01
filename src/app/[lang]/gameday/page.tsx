import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale, type Locale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { actionText, gameDayText, stepText } from "@/lib/gameday-text.ts";
import { viewer } from "@/server/viewer.ts";
import { getMatch } from "@/server/queries.ts";
import { gameDay, refereeCalls, type GameDayEntry } from "@/server/gameday.ts";
import { settingsOf } from "@/server/format-settings.ts";
import { depthKey, seriesOf, seriesRulesOf } from "@/server/series.ts";
import { mediaUrl } from "@/server/media.ts";
import type { Database } from "@/server/db.ts";
import { ActionForm, Badge, DbDown, Empty, Field, Flash, type SearchParams } from "@/components/ui";
import { Countdown, LocalTime } from "@/components/time";
import { matchLabel, seriesText } from "@/components/tournament";
import { CallBlock } from "@/components/referee-call";
import { vetoFor } from "@/server/veto.ts";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "gameday", gameDayText[lang].title, undefined, { noindex: true });
}

type Detail = NonNullable<Awaited<ReturnType<typeof getMatch>>>;

/** Everything the screen shows about one match, loaded once per event. */
async function matchDetail(db: Database, matchId: string, userId: string) {
  const data = await getMatch(db, matchId);
  if (!data) return null;
  const m = data.match;
  const settings = settingsOf({ format: m.t_format, format_settings: m.t_settings });
  const series = seriesOf(
    seriesRulesOf({ series_rules: m.t_series }),
    m,
    { main: m.t_format, playoff: settings.playoff?.format ?? null },
    new Map([[depthKey(m.stage ?? 1, m.bracket ?? "W"), m.rounds]]),
  );
  const nextIds = [m.next_match_id, m.loser_next_match_id].filter((x): x is string => Boolean(x));
  const next = nextIds.length
    ? await db.query<{ id: string; scheduled_at: Date | null }>("select id, scheduled_at from matches where id = any($1::uuid[])", [nextIds])
    : [];
  const calls = await refereeCalls(db, matchId);
  const veto = await vetoFor(db, matchId, userId);
  return { data, settings, bestOf: series.bestOf, next, calls, veto };
}

function SideLine({ s, lang }: { s: Detail["a"]; lang: Locale }) {
  const d = dict(lang);
  if (!s) return <span className="muted">{d.common.tbd}</span>;
  return s.team_slug ? (
    <Link href={`/${lang}/teams/${s.team_slug}`}>{s.name}</Link>
  ) : s.username ? (
    <Link href={`/${lang}/players/${s.username}`}>{s.name}</Link>
  ) : (
    <>{s.name}</>
  );
}

function EntryCard({ e, detail, lang, username }: { e: GameDayEntry; detail: Awaited<ReturnType<typeof matchDetail>>; lang: Locale; username: string }) {
  const d = dict(lang);
  const g = gameDayText[lang];
  const back = `/${lang}/gameday`;
  const t = e.tournament;
  const m = detail?.data.match ?? null;
  const live = ["IN_PROGRESS", "PAUSED"].includes(t.status);
  const mySide = m ? (m.a_reg === e.registration.id ? "a" : "b") : null;
  const mine = m && detail ? (mySide === "a" ? detail.data.a : detail.data.b) : null;
  const theirs = m && detail ? (mySide === "a" ? detail.data.b : detail.data.a) : null;
  const pending = detail?.data.results.find((r) => r.status === "pending");
  const score = pending && detail ? `${detail.data.a?.name ?? "A"} ${pending.score_a} : ${pending.score_b} ${detail.data.b?.name ?? "B"}` : undefined;
  const open = Boolean(m && !["completed", "cancelled"].includes(m.status));
  const roundLabel = m
    ? matchLabel(
        m,
        {
          format: m.t_format,
          playoffFormat: detail!.settings.playoff?.format,
          wRounds: m.w_rounds,
          lRounds: m.l_rounds,
          gRounds: m.bracket === "G" ? m.rounds : 0,
        },
        lang,
      )
    : null;
  const action = e.step.action;
  const leaderNote = !e.leader && ["checkin", "report", "confirm", "event_checkin"].includes(action ?? "");
  const evidence = detail
    ? [
        ...detail.data.results.filter((r) => r.evidence_url).map((r) => ({ key: r.id, href: r.evidence_url, label: `v${r.version}` })),
        ...detail.data.disputes
          .flatMap((x) => [
            x.evidence_url ? { key: `${x.id}-u`, href: x.evidence_url, label: lang === "ru" ? "спор" : "dispute" } : null,
            x.evidence_media_id ? { key: `${x.id}-m`, href: mediaUrl(x.evidence_media_id)!, label: lang === "ru" ? "изображение" : "image" } : null,
          ])
          .filter((x): x is { key: string; href: string; label: string } => Boolean(x)),
      ]
    : [];
  const nextWin = m?.next_match_id ? detail!.next.find((x) => x.id === m.next_match_id) : undefined;
  const nextLose = m?.loser_next_match_id ? detail!.next.find((x) => x.id === m.loser_next_match_id) : undefined;
  const elimination = m ? ["W", "L", "GF"].includes(m.bracket ?? "") : false;

  return (
    <section className="card gameday-entry" aria-labelledby={`gd-${t.id}`}>
      <div className="row-between">
        <h2 className="h3" id={`gd-${t.id}`}>
          <Link href={`/${lang}/tournaments/${t.slug}`}>{t.name}</Link>
        </h2>
        <Badge status={t.status}>{d.statuses.tournament[t.status]}</Badge>
      </div>
      <p className="small muted">
        {gameBySlug(t.game)?.name ?? t.game}
        {roundLabel ? ` · ${roundLabel}` : ""}
        {e.registration.team_name ? ` · ${e.registration.team_name}` : ""}
      </p>

      <div className="gameday-step" role="status">
        <p className="field-label">{g.now}</p>
        <p className="gameday-now">
          {stepText(e.step.key, lang, {
            series: detail && detail.bestOf > 1 ? seriesText(detail.bestOf, lang) : undefined,
            score,
            place: e.registration.placement,
            reason: m?.pause_reason || undefined,
            vetoAction: detail?.veto?.state.next?.action,
          })}
        </p>
        {e.step.deadline ? (
          <p className="small">
            {g.deadline} <LocalTime iso={e.step.deadline} lang={lang} /> · <Countdown iso={e.step.deadline} lang={lang} />
          </p>
        ) : null}
        {!live && !["COMPLETED", "ARCHIVED"].includes(t.status) ? (
          <p className="small">
            {g.startsAt}: <LocalTime iso={t.starts_at} lang={lang} />
          </p>
        ) : null}
        <div className="row">
          {action === "checkin" && e.leader && m ? (
            <ActionForm action="match.checkin" lang={lang} back={back} hidden={{ match: m.id }}>
              <button className="btn btn-primary btn-sm">{actionText("checkin", lang)}</button>
            </ActionForm>
          ) : null}
          {action === "veto" && e.leader && m ? (
            <Link href={`/${lang}/matches/${m.id}#veto`} className="btn btn-primary btn-sm">
              {actionText("veto", lang)}
            </Link>
          ) : null}
          {action === "report" && e.leader && m ? (
            <Link href={`/${lang}/matches/${m.id}#report`} className="btn btn-primary btn-sm">
              {actionText("report", lang)}
            </Link>
          ) : null}
          {action === "confirm" && e.leader && m ? (
            <>
              <ActionForm action="match.confirm" lang={lang} back={back} hidden={{ match: m.id }}>
                <button className="btn btn-primary btn-sm">{actionText("confirm", lang)}</button>
              </ActionForm>
              <Link href={`/${lang}/matches/${m.id}#report`} className="btn btn-ghost btn-sm">
                {actionText("dispute", lang)}
              </Link>
            </>
          ) : null}
          {action === "call_referee" && m ? (
            <a href={`#call-${m.id}`} className="btn btn-primary btn-sm">
              {actionText("call_referee", lang)}
            </a>
          ) : null}
          {action === "event_checkin" && e.leader ? (
            <ActionForm action="tournament.checkin" lang={lang} back={back} hidden={{ tournament: t.id }}>
              <button className="btn btn-primary btn-sm">{actionText("event_checkin", lang)}</button>
            </ActionForm>
          ) : null}
          {action === "open_lobby" && e.lobbyId ? (
            <Link href={`/${lang}/lobbies/${e.lobbyId}`} className="btn btn-primary btn-sm">
              {actionText("open_lobby", lang)}
            </Link>
          ) : null}
          {action === "open_tournament" ? (
            <Link href={`/${lang}/tournaments/${t.slug}`} className="btn btn-ghost btn-sm">
              {actionText("open_tournament", lang)}
            </Link>
          ) : null}
          {m ? (
            <Link href={`/${lang}/matches/${m.id}`} className="btn btn-ghost btn-sm">
              {actionText("open_match", lang)}
            </Link>
          ) : null}
        </div>
        {leaderNote ? <p className="small muted">{g.leaderOnly}</p> : null}
      </div>

      {m && open && detail ? (
        <>
          <div className="grid grid-3 facts">
            <div className="card">
              <p className="field-label">{g.opponent}</p>
              <p className="side-name">
                <SideLine s={theirs} lang={lang} />
              </p>
              {theirs?.team_slug ? <p className="small muted">{theirs.roster.join(", ")}</p> : null}
              {mine?.team_slug ? (
                <p className="small">
                  {g.yourRoster}: {mine.roster.map((r) => (r === username ? `${r} (${g.you})` : r)).join(", ")}
                </p>
              ) : null}
            </div>
            <div className="card">
              <p className="field-label">{g.time}</p>
              <p>{m.scheduled_at ? <LocalTime iso={m.scheduled_at} lang={lang} /> : <span className="muted">{d.match.notScheduled}</span>}</p>
              {m.scheduled_at && new Date(m.scheduled_at).getTime() > Date.now() ? (
                <p className="small">
                  <Countdown iso={m.scheduled_at} lang={lang} />
                </p>
              ) : null}
              {m.venue_name ? (
                <p className="small">
                  {g.venue}: <strong>{m.venue_name}</strong>
                </p>
              ) : null}
              <p className="small">
                {g.format}: <strong>{seriesText(detail.bestOf, lang)}</strong>
              </p>
              {detail.veto ? (
                <p className="small">
                  {detail.veto.state.complete ? (
                    <>
                      {g.maps}: <strong>{detail.veto.state.maps.map((x) => x.map).join(", ")}</strong>
                    </>
                  ) : (
                    <Link href={`/${lang}/matches/${m.id}#veto`} className="text-link">
                      {g.vetoOpen}
                    </Link>
                  )}
                </p>
              ) : null}
            </div>
            <div className="card">
              <p className="field-label">{d.match.room}</p>
              {m.room_code ? <p className="mono">{m.room_code}</p> : <p className="muted small">{d.match.noRoom}</p>}
              <p className="field-label">{g.readiness}</p>
              <p className="small">
                {g.you}: {(mySide === "a" ? m.a_checked_in_at : m.b_checked_in_at) ? <Badge status="ok">{g.here}</Badge> : <Badge status="muted">{g.notYet}</Badge>}{" "}
                · {theirs?.name ?? d.common.tbd}:{" "}
                {(mySide === "a" ? m.b_checked_in_at : m.a_checked_in_at) ? <Badge status="ok">{g.here}</Badge> : <Badge status="muted">{g.notYet}</Badge>}
              </p>
            </div>
          </div>
          <div className="grid grid-3 facts">
            <div className="card">
              <CallBlock lang={lang} matchId={m.id} calls={detail.calls.filter((c) => c.side === mySide)} open={action === "call_referee"} canCall={live} back={back} />
            </div>
            <div className="card">
              <p className="field-label">{g.evidence}</p>
              {evidence.length ? (
                <p className="small">
                  {evidence.map((x, i) => (
                    <span key={x.key}>
                      {i ? " · " : ""}
                      <a href={x.href} target="_blank" rel="noopener noreferrer nofollow" className="text-link">
                        {x.label} ↗
                      </a>
                    </span>
                  ))}
                </p>
              ) : (
                <p className="small muted">{g.noEvidence}</p>
              )}
            </div>
            <div className="card">
              <p className="field-label">{g.next}</p>
              {m.next_match_id || nextLose || elimination ? (
                <ul className="small plain-list">
                  {m.next_match_id ? (
                    <li>
                      {g.ifWin}:{" "}
                      <Link href={`/${lang}/matches/${m.next_match_id}`} className="text-link">
                        {nextWin?.scheduled_at ? <LocalTime iso={nextWin.scheduled_at} lang={lang} /> : d.match.next}
                      </Link>
                    </li>
                  ) : null}
                  {nextLose ? (
                    <li>
                      {g.ifLose}:{" "}
                      <Link href={`/${lang}/matches/${nextLose.id}`} className="text-link">
                        {nextLose.scheduled_at ? <LocalTime iso={nextLose.scheduled_at} lang={lang} /> : d.match.next}
                      </Link>
                    </li>
                  ) : elimination ? (
                    <li>
                      {g.ifLose}: {g.out}
                    </li>
                  ) : null}
                </ul>
              ) : (
                <p className="small muted">{stepText("waiting_round", lang)}</p>
              )}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

export default async function GameDay({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user) redirect(`/${lang}/signin?next=/${lang}/gameday`);
  const g = gameDayText[lang];
  const entries = await gameDay(db, user);
  const details = await Promise.all(entries.map((e) => (e.matchId ? matchDetail(db, e.matchId, user.id) : Promise.resolve(null))));
  return (
    <div className="container page">
      <h1>{g.title}</h1>
      <p className="lead">{g.lead}</p>
      <Flash lang={lang} params={sp} />
      {entries.length ? (
        <div className="stack">
          {entries.map((e, i) => (
            <EntryCard key={e.registration.id} e={e} detail={details[i]} lang={lang} username={user.username} />
          ))}
        </div>
      ) : (
        <Empty
          title={g.emptyTitle}
          action={
            <Link href={`/${lang}/tournaments?f=open`} className="btn btn-primary btn-sm">
              {dict(lang).home.ctaTournaments}
            </Link>
          }
        >
          {g.emptyBody}
        </Empty>
      )}
    </div>
  );
}
