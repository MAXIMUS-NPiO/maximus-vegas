import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale, ruPlural } from "@/lib/i18n.ts";
import { historyLabel } from "@/lib/history-labels.ts";
import { pageMeta } from "@/lib/meta.ts";
import { flagLabel, reviewLabel } from "@/lib/labels.ts";
import { viewer } from "@/server/viewer.ts";
import { bracket, getTournament, participants, tournamentHistory } from "@/server/queries.ts";
import { canManageOrg } from "@/server/access.ts";
import { allowedTransitions, canManageTournament, canRefereeTournament, isMatchFormat, type TournamentStatus } from "@/server/tournaments.ts";
import { scoreLog, SCORE_LOG_PAGE_SIZE } from "@/server/leaderboard.ts";
import { isRoundFormat, playoffStage, settingsOf, stageSpec } from "@/server/format-settings.ts";
import { effectiveSwissRounds } from "@/server/swiss.ts";
import { groupStandings, roundStandings, stageTables } from "@/server/rounds.ts";
import { listCircuits } from "@/server/circuits.ts";
import { answerLines, fieldsOf } from "@/server/registration.ts";
import { ffaActivity, roundTables } from "@/server/lobbies.ts";
import { ffaSettingsOf, planRounds } from "@/server/ffa.ts";
import { roundKeyOf, scheduleConflicts, venues, VENUE_KINDS } from "@/server/schedule.ts";
import { seriesCustomised, seriesMap, seriesRulesOf } from "@/server/series.ts";
import { feedbackList, feedbackSummary } from "@/server/feedback.ts";
import { DEFAULT_MATCH_MINUTES } from "@/server/conflicts.ts";
import { eventStaff, incidentQueue } from "@/server/liveops.ts";
import { IncidentQueue } from "@/components/incident-queue";
import { orgVenues } from "@/server/venues.ts";
import { StreamsManager } from "@/components/streams";
import { ActionForm, Badge, DbDown, Field, Flash, type SearchParams } from "@/components/ui";
import { TournamentForm } from "@/components/tournament-form";
import { ScoreCorrectionForm } from "@/components/score-correction";
import {
  BracketView,
  chainStageLabel,
  FfaRounds,
  formatLabel,
  groupTitle,
  labelContext,
  matchLabel,
  playoffFormatLabel,
  StageStandings,
  stageTitle,
  StandingsTable,
  type StandingName,
} from "@/components/tournament";
import { LocalDateTimeInput, LocalTime, TimeZoneField } from "@/components/time";

/** Matches of a playoff bracket for n entrants (double elimination: without a possible reset). */
const playoffMatchCount = (format: string, n: number) => (format === "double_elimination" ? 2 * n - 2 : n - 1);

/** What the structure will look like for n entrants, before anything is generated. */
function structurePreview(format: string, n: number, settings: ReturnType<typeof settingsOf>, ru: boolean, ffaRaw?: unknown): Array<[string, string]> {
  if (n < 2) return [[ru ? "Участников" : "Entrants", String(n)]];
  const rows = structureMain(format, n, settings, ru, ffaRaw);
  const playoff = settings.playoff;
  // Chained stages (MV-STAGES-2): each takes the best of the stage before it; groups shrink to fit a small field.
  let onward = format === "groups" && settings.groups ? Math.min(n, settings.groups.count * settings.groups.advance) : n;
  if (format === "round_robin" || format === "swiss" || format === "groups")
    (settings.chain ?? []).forEach((c, i) => {
      const entrants = Math.min(c.size, onward);
      rows.push([`${ru ? "Этап" : "Stage"} ${i + 2}`, `${chainStageLabel(c, ru ? "ru" : "en")} → ${entrants}`]);
      const groups = c.groups ? Math.max(1, Math.min(c.groups.count, Math.floor(entrants / Math.max(2, c.groups.advance)))) : 0;
      onward = c.groups ? Math.min(entrants, groups * c.groups.advance) : entrants;
    });
  if (playoff && (format === "round_robin" || format === "swiss" || format === "groups")) {
    const field = format === "groups" && !settings.chain?.length ? playoff.size : Math.min(playoff.size, onward);
    rows.push([ru ? "Плей-офф" : "Playoff", `${playoffFormatLabel(playoff.format, ru ? "ru" : "en")} · ${field}`]);
    rows.push([ru ? "Матчей плей-офф" : "Playoff matches", String(playoffMatchCount(playoff.format, field)) + (playoff.format === "double_elimination" ? (ru ? " (+1 при перезапуске)" : " (+1 with a reset)") : "")]);
  }
  if ((format === "round_robin" || format === "swiss" || format === "groups") && (settings.roundHours ?? 0) > 0)
    rows.push([ru ? "Интервал между турами" : "Time between rounds", `${settings.roundHours} ${ru ? "ч" : "h"}`]);
  return rows;
}

function structureMain(format: string, n: number, settings: ReturnType<typeof settingsOf>, ru: boolean, ffaRaw?: unknown): Array<[string, string]> {
  const size = 2 ** Math.ceil(Math.log2(n));
  if (format === "ffa") {
    const s = ffaSettingsOf({ format_settings: ffaRaw });
    const plan = planRounds(n, s);
    return [
      [ru ? "Раундов" : "Rounds", String(plan.length)],
      [ru ? "Путь" : "Path", plan.map((r) => (ru ? `${r.entrants} в ${r.lobbies} лобби` : `${r.entrants} in ${r.lobbies} lobb${r.lobbies === 1 ? "y" : "ies"}`)).join(" → ")],
      [ru ? "Игр всего" : "Games in total", String(plan.reduce((sum, r) => sum + r.lobbies * s.games, 0))],
      [ru ? "Финал" : "Final", plan.length && plan[plan.length - 1].lobbies === 1 ? (ru ? "одно лобби" : "one lobby") : ru ? "не достигается — измените настройки" : "not reached — change the settings"],
    ];
  }
  if (format === "gauntlet")
    return [
      [ru ? "Ступеней (матчей)" : "Steps (matches)", String(n - 1)],
      [ru ? "Первый посев" : "Top seed", ru ? "играет только финал" : "plays only the final"],
      [ru ? "Нижние посевы" : "Bottom seeds", ru ? `${n}-й и ${n - 1}-й открывают лесенку` : `${n} and ${n - 1} open the ladder`],
    ];
  if (format === "groups" && settings.groups) {
    const { count, advance } = settings.groups;
    const small = Math.floor(n / count);
    const big = Math.ceil(n / count);
    const games = (k: number) => ((k * (k - 1)) / 2) * (settings.legs ?? 1);
    const matches = (n % count) * games(big) + (count - (n % count)) * games(small);
    return [
      [ru ? "Групп" : "Groups", String(count)],
      [ru ? "Участников в группе" : "Entrants per group", small === big ? String(small) : `${small}–${big}`],
      [ru ? "Выходят из группы" : "Advance per group", String(advance)],
      [ru ? "Матчей в группах" : "Group matches", String(matches)],
      [ru ? "Достаточно для старта" : "Enough to start", n >= count * Math.max(2, advance) ? (ru ? "да" : "yes") : ru ? `нет — нужно ${count * Math.max(2, advance)}` : `no — ${count * Math.max(2, advance)} needed`],
    ];
  }
  if (format === "single_elimination" || format === "double_elimination") {
    const rows: Array<[string, string]> = [
      [ru ? "Размер сетки" : "Bracket size", String(size)],
      [ru ? "Проходов без игры (bye)" : "Byes", String(size - n)],
      [ru ? "Раундов верхней сетки" : "Winners rounds", String(Math.log2(size))],
    ];
    rows.push(
      format === "single_elimination"
        ? [ru ? "Матчей" : "Matches", String(n - 1)]
        : [ru ? "Матчей" : "Matches", ru ? `${2 * n - 2} (или ${2 * n - 1} с перезапуском финала)` : `${2 * n - 2} (or ${2 * n - 1} with a bracket reset)`],
    );
    return rows;
  }
  if (format === "round_robin") {
    const legs = settings.legs ?? 1;
    return [
      [ru ? "Туров" : "Rounds", String((n % 2 === 0 ? n - 1 : n) * legs)],
      [ru ? "Матчей всего" : "Matches in total", String(((n * (n - 1)) / 2) * legs)],
      [ru ? "Матчей у каждого" : "Matches per entrant", String((n - 1) * legs)],
      [ru ? "Отдых в туре" : "Rest per round", n % 2 === 1 ? (ru ? "один участник" : "one entrant") : "—"],
    ];
  }
  if (format === "swiss") {
    return [
      [ru ? "Туров" : "Rounds", String(effectiveSwissRounds(n, settings.rounds))],
      [ru ? "Матчей в туре" : "Matches per round", String(Math.floor(n / 2))],
      ["Bye", n % 2 === 1 ? (ru ? "один участник в каждом туре" : "one entrant each round") : "—"],
    ];
  }
  return [[ru ? "Участников" : "Entrants", String(n)]];
}

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, `organizer/t/${slug}`, dict(lang).tournaments.manage, undefined, { noindex: true });
}

export default async function ManageTournament({ params, searchParams }: { params: Promise<{ lang: string; slug: string }>; searchParams: SearchParams }) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const o = d.organizer;
  const ru = lang === "ru";
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user) redirect(`/${lang}/signin?next=/${lang}/organizer/t/${slug}`);
  const t = await getTournament(db, slug);
  if (!t) notFound();
  const manager = await canManageTournament(db, t, user);
  const referee = await canRefereeTournament(db, t, user);
  if (!manager && !referee)
    return (
      <div className="container page">
        <h1>{t.name}</h1>
        <p className="notice notice-warn">{o.notAllowed}</p>
      </div>
    );
  const orgManager = await canManageOrg(db, t.org_id, user);
  const primary = t.created_by === user.id || user.roles.includes("admin") || orgManager;
  const leaderboard = t.format === "leaderboard";
  const rounds = isRoundFormat(t.format) ? t.format : null;
  const settings = settingsOf(t);
  const [list, matches] = await Promise.all([participants(db, t.id), leaderboard ? Promise.resolve([]) : bracket(db, t.id)]);
  const [stats] = await db.query<{ disputes: number; no_shows: number; entries: number; pending: number }>(
    `select (select count(*)::int from disputes x join matches m on m.id = x.match_id where m.tournament_id = $1) as disputes,
            (select count(*)::int from matches where tournament_id = $1 and outcome = 'no_show') as no_shows,
            (select count(*)::int from score_entries where tournament_id = $1) as entries,
            (select count(*)::int from score_entries where tournament_id = $1 and review = 'pending') as pending`,
    [t.id],
  );
  const coorgs = await db.query<{ id: string; username: string; display_name: string }>(
    "select u.id, u.username, u.display_name from tournament_organizers c join users u on u.id = c.user_id where c.tournament_id = $1 order by u.username",
    [t.id],
  );
  const openPostDisputes = await db.query<{ id: string; match_id: string; reason: string }>(
    "select d.id, d.match_id, d.reason from disputes d join matches m on m.id = d.match_id where m.tournament_id = $1 and d.status = 'open' and d.kind = 'post_result'",
    [t.id],
  );
  const logPages = Math.max(1, Math.ceil((stats?.entries ?? 0) / SCORE_LOG_PAGE_SIZE));
  const logPage = Math.min(logPages, Math.max(1, Math.trunc(Number(sp.logPage) || 1)));
  // Independent oldest-first review work and paginated history can load concurrently.
  const [lines, pendingLines, ownRegistrations] = leaderboard ? await Promise.all([
    scoreLog(db, t.id, { page: logPage }), scoreLog(db, t.id, { pendingOnly: true }),
    db.query<{ registration_id: string }>("select re.registration_id from roster_entries re join registrations r on r.id=re.registration_id where r.tournament_id=$1 and re.user_id=$2", [t.id, user.id]),
  ]) : [[], [], []];
  const ownRosterIds = new Set(ownRegistrations.map(r => r.registration_id));
  const inControl=String(sp.control??"")==="1" && user.roles.includes("admin");
  const back = inControl ? `/${lang}/admin?tab=tournaments&event=${encodeURIComponent(t.slug)}` : `/${lang}/organizer/t/${t.slug}`;
  const scoreHistoryPath = (page: number) => `${back}${back.includes("?") ? "&" : "?"}logPage=${page}#score-history`;
  const matchPath=(id:string)=>inControl?`${back}&match=${id}`:`/${lang}/matches/${id}`;
  const hidden = { tournament: t.id };
  const status = t.status as TournamentStatus;
  const editable = ["DRAFT", "PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(status);
  const preStart = ["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(status);
  const playoff = rounds ? (settings.playoff ?? null) : null;
  const labels = labelContext(matches, t.format, playoff?.format);
  const label = (m: (typeof matches)[number]) => matchLabel(m, labels, lang);
  const mainMatches = matches.filter((m) => (m.stage ?? 1) === 1);
  // Further round stages before the playoff (MV-STAGES-2); the playoff is the stage after them.
  const chain = rounds ? (settings.chain ?? []) : [];
  const playoffAt = playoffStage(settings);
  const playoffMatches = matches.filter((m) => m.stage === playoffAt);
  const chainStages = await Promise.all(
    chain.map(async (spec, i) => {
      const stage = i + 2;
      const stageMatches = matches.filter((m) => m.stage === stage);
      const data = stageMatches.length ? await stageTables(db, t, stage) : null;
      return { stage, spec, matches: stageMatches, tables: data?.tables ?? [] };
    }),
  );
  const roundTable = (rounds === "round_robin" || rounds === "swiss") && matches.length ? await roundStandings(db, t) : [];
  const groupTables = rounds === "groups" && matches.length ? await groupStandings(db, t) : [];
  const finished = status === "COMPLETED" || status === "ARCHIVED";
  const fields = fieldsOf(t);
  const ffaLobbies = t.format === "ffa" && t.started_at ? await roundTables(db, t) : [];
  // Rounds that still have unfinished matches, for batch rescheduling.
  const openRounds = [
    ...new Map(
      matches
        .filter((m) => !["completed", "cancelled"].includes(m.status))
        .map((m) => [
          roundKeyOf(m),
          {
            key: roundKeyOf(m),
            label:
              m.bracket === "RR" || m.bracket === "SW"
                ? `${ru ? "Тур" : "Round"} ${m.round}${m.group_no ? (ru ? " (все группы)" : " (all groups)") : ""}`
                : label(m),
          },
        ]),
    ).values(),
  ];
  // Staff-only registration details: answers, decisions, team rosters and the team members available to substitute.
  const regExtra = await db.query<{ id: string; answers: unknown; team_id: string | null; decision_note: string }>(
    "select id, answers, team_id, decision_note from registrations where tournament_id = $1",
    [t.id],
  );
  const answersOf = new Map(regExtra.filter((r) => r.answers).map((r) => [r.id, r.answers]));
  const rejectionOf = new Map(regExtra.map((r) => [r.id, r.decision_note]));
  const teamOf = new Map(regExtra.map((r) => [r.id, r.team_id]));
  const rosterIds =
    t.participant_type === "team"
      ? await db.query<{ registration_id: string; user_id: string; username: string }>(
          "select re.registration_id, re.user_id, u.username from roster_entries re join users u on u.id = re.user_id where re.tournament_id = $1 order by u.username",
          [t.id],
        )
      : [];
  const teamPool =
    t.participant_type === "team" && manager
      ? await db.query<{ team_id: string; user_id: string; username: string }>(
          "select m.team_id, m.user_id, u.username from team_members m join users u on u.id = m.user_id where m.team_id = any($1) and u.status = 'active' order by u.username",
          [regExtra.map((r) => r.team_id).filter(Boolean)],
        )
      : [];
  const names = new Map<string, StandingName>(list.map((p) => [p.id, { name: p.name, username: p.username, team_slug: p.team_slug }]));
  const running = ["IN_PROGRESS", "PAUSED"].includes(status) && (isMatchFormat(t.format) || t.format === "ffa");
  // From the second stage on only the current stage can be rebuilt (the server applies the same rule).
  const regenStage = rounds && (t.stage ?? 1) >= 2 ? t.stage : null;
  const [regen] = !running
    ? []
    : t.format === "ffa"
      ? [{ blocking: await ffaActivity(db, t.id) }]
      : await db.query<{ blocking: number }>(
        `select (select count(*)::int from match_results r join matches m on m.id = r.match_id where m.tournament_id = $1 and ($2::int is null or m.stage = $2))
              + (select count(*)::int from disputes x join matches m on m.id = x.match_id where m.tournament_id = $1 and ($2::int is null or m.stage = $2))
              + (select count(*)::int from matches where tournament_id = $1 and ($2::int is null or stage = $2) and (status in ('in_progress','result_submitted','disputed')
                   or (status = 'completed' and coalesce(outcome, '') not in ('bye','disqualification')))) as blocking`,
        [t.id, regenStage],
      );
  // The next stage (a chained stage or the playoff) waits for open disputes about the current stage's matches.
  const currentStage = t.stage ?? 1;
  const currentMatches = matches.filter((m) => (m.stage ?? 1) === currentStage);
  const nextStage = rounds ? stageSpec(settings, rounds, currentStage + 1) : null;
  const [waiting] =
    running && nextStage && currentMatches.length && currentMatches.every((m) => ["completed", "cancelled"].includes(m.status))
      ? await db.query<{ n: number }>(
          "select count(*)::int as n from disputes d join matches m on m.id = d.match_id where m.tournament_id = $1 and m.stage = $2 and d.status = 'open'",
          [t.id, currentStage],
        )
      : [];
  const circuitOptions = manager ? await listCircuits(db, { orgId: t.org_id }) : [];
  const matchFormat = isMatchFormat(t.format);
  const venueList = matchFormat ? await venues(db, t.id) : [];
  // The physical venue the event is held at (a confirmed venue of this space), or online.
  const placeId = (t as { venue_id?: string | null }).venue_id ?? null;
  const places = manager ? (await orgVenues(db, t.org_id)).filter((v) => v.status === "confirmed" || v.id === placeId) : [];
  const conflicts = running && matchFormat ? await scheduleConflicts(db, t) : [];
  const conflicted = new Set(conflicts.flatMap((c) => [c.a, c.b]));
  const seriesRules = seriesRulesOf(t);
  const seriesById =
    seriesCustomised(seriesRules) || matches.some((m) => m.series_override) ? seriesMap(seriesRules, matches, { main: t.format, playoff: playoff?.format ?? null }) : undefined;
  const [rating, comments] = finished && manager ? await Promise.all([feedbackSummary(db, t.id), feedbackList(db, t.id)]) : [null, []];
  const history = await tournamentHistory(db, t.id);
  const byId = new Map(matches.map((m) => [m.id, m]));
  const matchName = (id: string) => {
    const m = byId.get(id);
    return m ? `${label(m)}: ${m.a_name ?? d.common.tbd} ${d.common.vs} ${m.b_name ?? d.common.tbd}` : ru ? "матч другого турнира" : "a match of another tournament";
  };
  const venueName = new Map(venueList.map((v) => [v.id, v.name]));
  const upcoming = matches
    .filter((m) => m.scheduled_at && !["completed", "cancelled"].includes(m.status) && !(m.a_void && m.b_void))
    .sort((x, y) => new Date(x.scheduled_at!).getTime() - new Date(y.scheduled_at!).getTime())
    .slice(0, 60);
  const kindLabel: Record<string, string> = ru
    ? { stage: "Сцена", station: "Станция", server: "Сервер", table: "Стол", room: "Комната", other: "Другое" }
    : { stage: "Stage", station: "Station", server: "Server", table: "Table", room: "Room", other: "Other" };
  const registeredCount = list.filter((p) => p.status === "registered").length;
  const openMatches = matches.filter((m) => ["ready", "in_progress", "result_submitted", "disputed"].includes(m.status));
  // Live operations: the incident queue of a running event for its staff.
  const liveOps = referee && ["REGISTRATION_CLOSED", "IN_PROGRESS", "PAUSED"].includes(t.status);
  const [queue, staffList] = liveOps ? await Promise.all([incidentQueue(db, t.id), eventStaff(db, t.org_id, t.id)]) : [null, []];
  const report: Array<[string, number]> = leaderboard
    ? [
        ["registered", t.registered],
        ["waitlisted", t.waitlisted],
        ["checkedIn", t.checked_in],
      ]
    : [
        ["registered", t.registered],
        ["waitlisted", t.waitlisted],
        ["checkedIn", t.checked_in],
        ["matchesDone", matches.filter((m) => m.status === "completed" && m.outcome !== "bye").length],
        ["matchesTotal", matches.filter((m) => m.outcome !== "bye" && !(m.a_void && m.b_void)).length],
        ["disputes", stats?.disputes ?? 0],
        ["noShows", stats?.no_shows ?? 0],
      ];

  return (
    <div className="container page">
      <p className="eyebrow">
        <Link href={`/${lang}/organizer/${t.org_slug}`}>{t.org_name}</Link> · {o.manageTitle} · {formatLabel(t.format, lang)}
      </p>
      <div className="row-between">
        <h1>{t.name}</h1>
        <Badge status={t.status}>{d.statuses.tournament[t.status]}</Badge>
      </div>
      <p>
        <Link href={`/${lang}/tournaments/${t.slug}`} className="text-link">
          {o.publicPage}
        </Link>
      </p>
      <Flash lang={lang} params={sp} />

      {manager ? (
        <section className="card section-card">
          <h2 className="h3">{o.lifecycle}</h2>
          <p className="small muted">
            {chain.length
              ? ru
                ? "Разрешены только допустимые переходы. Каждый следующий этап и плей-офф создаются автоматически после последнего матча предыдущего этапа (и решения открытых споров по нему); после этого результаты предыдущего этапа не меняются. Турнир завершается последним этапом."
                : "Only valid transitions are offered. Each further stage and the playoff are created automatically after the last match of the stage before (and any open disputes about it); from then on that stage's results are final. The last stage completes the tournament."
              : playoff
              ? ru
                ? "Разрешены только допустимые переходы. Плей-офф создаётся автоматически после последнего матча основного этапа (и решения открытых споров по нему), турнир завершается финалом плей-офф."
                : "Only valid transitions are offered. The playoff is created automatically after the last main-stage match (and any open disputes about it); the playoff final completes the tournament."
              : rounds
                ? ru
                  ? "Разрешены только допустимые переходы. Завершение наступает автоматически после последнего тура."
                  : "Only valid transitions are offered. Completion happens automatically after the last round."
                : o.lifecycleNote}
            {leaderboard ? (ru ? " Leaderboard завершается вручную, когда все отмеченные результаты проверены." : " A leaderboard is completed manually once every flagged result is reviewed.") : ""}
          </p>
          <div className="row">
            {allowedTransitions(t.format, status).map((to) => (
              <ActionForm key={to} action="tournament.transition" lang={lang} back={back} hidden={{ ...hidden, to }}>
                <button className={to === "CANCELLED" ? "btn btn-danger btn-sm" : to === "IN_PROGRESS" || to === "COMPLETED" ? "btn btn-primary btn-sm" : "btn btn-ghost btn-sm"}>
                  {status === "PAUSED" && to === "IN_PROGRESS" ? d.transitions.resume : to === "COMPLETED" ? (ru ? "Завершить и опубликовать итоги" : "Complete and publish results") : d.transitions[to]}
                </button>
              </ActionForm>
            ))}
          </div>
          {(waiting?.n ?? 0) > 0 ? (
            <p className="notice notice-warn">
              {currentStage > 1 || nextStage?.kind === "round"
                ? ru
                  ? `Этап ${currentStage} сыгран. Следующий этап будет создан после решения открытых споров по его матчам: ${waiting!.n}.`
                  : `Stage ${currentStage} is complete. The next stage will be created once its open disputes are decided: ${waiting!.n}.`
                : ru
                  ? `Основной этап сыгран. Плей-офф будет создан после решения открытых споров по его матчам: ${waiting!.n}.`
                  : `The main stage is complete. The playoff will be created once its open disputes are decided: ${waiting!.n}.`}
            </p>
          ) : null}
          {running ? (
            <div className="stack-sm">
              {(regen?.blocking ?? 0) === 0 ? (
                <ActionForm action="tournament.regenerate" lang={lang} back={back} hidden={hidden} className="inline-form">
                  <button className="btn btn-ghost btn-sm">
                    {t.format === "ffa"
                      ? ru
                        ? "Пересоздать лобби"
                        : "Regenerate the lobbies"
                      : t.stage === 2
                      ? ru
                        ? "Пересоздать плей-офф"
                        : "Regenerate the playoff"
                      : rounds === "swiss"
                        ? ru
                          ? "Пересоздать первый тур"
                          : "Regenerate round 1"
                        : rounds === "groups"
                          ? ru
                            ? "Пересоздать группы"
                            : "Regenerate the groups"
                          : rounds
                            ? ru
                              ? "Пересоздать расписание"
                              : "Regenerate the schedule"
                            : ru
                              ? "Пересоздать сетку"
                              : "Regenerate the bracket"}
                  </button>
                  <span className="small muted">
                    {t.stage === 2
                      ? ru
                        ? "Плей-офф строится заново по итоговой таблице основного этапа (дисквалифицированные исключаются, их место занимает следующий по таблице). Доступно до первого результата плей-офф."
                        : "The playoff is rebuilt from the final main-stage table (disqualified entrants are left out and the next in the table takes their place). Available until the first playoff result."
                      : ru
                        ? "Строится заново из текущих участников в порядке посева (дисквалифицированные исключаются). Доступно, пока нет ни одного результата."
                        : "Rebuilt from the current entrants in seed order (disqualified entrants are left out). Available until the first result."}
                  </span>
                </ActionForm>
              ) : (
                <p className="small muted">
                  {ru
                    ? "Пересоздание недоступно: уже есть результат, спор или сыгранный матч. Исправления вносятся через матчи — с версиями и журналом."
                    : "Regeneration is unavailable: a result, dispute or played match exists. Corrections go through the matches, versioned and logged."}
                </p>
              )}
            </div>
          ) : null}
          {["REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(status) ? (
            <div className="row">
              <span className="field-label">{o.checkInWindow}:</span>
              <Badge status={t.check_in_open ? "works" : "closed"}>{t.check_in_open ? d.tournaments.checkInOpenNow : "—"}</Badge>
              <ActionForm action="tournament.checkin_window" lang={lang} back={back} hidden={{ ...hidden, open: t.check_in_open ? "0" : "1" }}>
                <button className="btn btn-ghost btn-sm">{t.check_in_open ? o.closeCheckIn : o.openCheckIn}</button>
              </ActionForm>
            </div>
          ) : null}
        </section>
      ) : null}

      {liveOps && queue && user ? (
        <IncidentQueue
          lang={lang}
          tournamentId={t.id}
          queue={queue}
          staff={staffList}
          matches={openMatches.map((m) => ({ id: m.id, label: `${label(m)}: ${m.a_name ?? d.common.tbd} ${d.common.vs} ${m.b_name ?? d.common.tbd}` }))}
          back={`/${lang}/organizer/t/${t.slug}`}
          userId={user.id}
        />
      ) : null}

      {manager && (editable || status === "DRAFT") && !leaderboard ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Предпросмотр структуры" : "Structure preview"}</h2>
          <p className="small muted">
            {ru
              ? `Для ${registeredCount} зарегистрированных сейчас. При обязательном check-in в старт попадут только отметившиеся; посев фиксируется при старте.`
              : `For the ${registeredCount} entrants registered now. With check-in required only checked-in entrants start; seeds are fixed at the start.`}
          </p>
          <ul className="kv-list">
            {structurePreview(t.format, registeredCount, settings, ru, t.format_settings).map(([k, v]) => (
              <li key={k}>
                <span>{k}</span>
                <strong>{v}</strong>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="section-tight">
        <h2 className="h3">{o.report}</h2>
        <dl className="stat-grid">
          {report.map(([k, v]) => (
            <div key={k}>
              <dt>{o.reportItems[k]}</dt>
              <dd>{v}</dd>
            </div>
          ))}
          {leaderboard ? (
            <>
              <div>
                <dt>{ru ? "Строк результатов" : "Result lines"}</dt>
                <dd>{stats?.entries ?? 0}</dd>
              </div>
              <div>
                <dt>{ru ? "Ждут проверки" : "Awaiting review"}</dt>
                <dd>{stats?.pending ?? 0}</dd>
              </div>
            </>
          ) : null}
        </dl>
      </section>

      {openPostDisputes.length ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Оспаривания решённых матчей" : "Disputes of decided matches"}</h2>
          <ul className="list">
            {openPostDisputes.map((x) => (
              <li key={x.id}>
                <span className="grow small prewrap">{x.reason}</span>
                <Link href={matchPath(x.match_id)} className="btn btn-ghost btn-xs">
                  {o.open}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {leaderboard && (referee || manager) ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Проверка результатов" : "Result review"}</h2>
          <p className="small muted">{ru ? "Это проверка целостности данных, а не античит. Решение фиксируется в журнале." : "This is a data integrity check, not anti-cheat. Each decision is recorded in the log."}</p>
          {(stats?.pending ?? 0) > pendingLines.length ? (
            <p className="notice notice-info">{ru ? `Показаны ${pendingLines.length} старейших из ${stats.pending} результатов. После решения появятся следующие.` : `Showing the oldest ${pendingLines.length} of ${stats.pending} results. The next results appear as these are reviewed.`}</p>
          ) : null}
          {pendingLines.length ? (
            <ul className="list">
              {pendingLines.map((l) => (
                <li key={l.id} className="stack-sm">
                  <div className="row-between">
                    <strong>{l.name}</strong>
                    <span className="small">{l.flags.map((f) => flagLabel(f, lang)).join("; ")}</span>
                  </div>
                  <p className="small">
                    K {l.kills} · A {l.assists} · D {l.deaths} · HS {l.headshots} · DMG {l.damage} · {l.distance} m{l.placement ? ` · #${l.placement}` : ""}
                    {l.match_ref ? ` · ${l.match_ref}` : ""}
                    {l.evidence_url ? (
                      <>
                        {" "}
                        ·{" "}
                        <a href={l.evidence_url} target="_blank" rel="noopener noreferrer nofollow" className="text-link">
                          {ru ? "доказательство" : "evidence"} ↗
                        </a>
                      </>
                    ) : null}
                  </p>
                  {l.correction_reason ? <p className="small prewrap">{ru ? "Причина исправления" : "Correction reason"}: {l.correction_reason}</p> : null}
                  {l.previous_values ? <p className="small muted">{ru ? "До исправления" : "Before correction"}: K {l.previous_values.kills} · A {l.previous_values.assists} · D {l.previous_values.deaths} · HS {l.previous_values.headshots} · DMG {l.previous_values.damage} · {l.previous_values.distance} m{l.previous_values.placement ? ` · #${l.previous_values.placement}` : ""}</p> : null}
                  <div className="row">
                    {l.match_ref.trim() ? <ActionForm action="score.review" lang={lang} back={back} hidden={{ entry: l.id, expectedRevision: String(l.revision), decision: "approve" }} className="inline-form">
                      <input name="note" maxLength={500} placeholder={ru ? "Комментарий" : "Note"} aria-label={ru ? "Комментарий" : "Note"} />
                      <button className="btn btn-primary btn-xs" disabled={ownRosterIds.has(l.registration_id)}>{ru ? "Учесть" : "Approve"}</button>
                      {ownRosterIds.has(l.registration_id) ? <span className="small muted">{ru ? "Ваш результат должен утвердить другой судья." : "Another referee must approve your roster’s result."}</span> : null}
                    </ActionForm> : <p className="small muted">{ru ? "Для утверждения нужен ID матча. Отклоните запись с причиной, затем исправьте её." : "Approval requires a match ID. Reject with a reason, then correct the entry."}</p>}
                    <ActionForm action="score.review" lang={lang} back={back} hidden={{ entry: l.id, expectedRevision: String(l.revision), decision: "reject" }} className="inline-form">
                      <input name="note" required minLength={5} maxLength={500} placeholder={ru ? "Причина" : "Reason"} aria-label={ru ? "Причина" : "Reason"} />
                      <button className="btn btn-danger btn-xs">{ru ? "Отклонить" : "Reject"}</button>
                    </ActionForm>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{ru ? "Нет результатов на проверке." : "Nothing awaiting review."}</p>
          )}
          {t.status === "IN_PROGRESS" ? (
            <details className="disclosure card">
              <summary>{ru ? "Внести результат за участника" : "Log a result for a participant"}</summary>
              <p className="small muted">{ru ? "Для результата своей игровой заявки нужны доказательство и утверждение другим судьёй." : "Logging for your own playing roster requires evidence and approval by another referee."}</p>
              <ActionForm action="score.log" lang={lang} back={back} hidden={hidden} className="stack">
                <Field label={d.tournaments.participants}>
                  <select name="registration" required>
                    {list
                      .filter((p) => p.status === "registered")
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <div className="form-grid form-grid-4">
                  {(["kills", "assists", "deaths", "headshots", "damage", "distance"] as const).map((k) => (
                    <Field key={k} label={k}>
                      <input name={k} type="number" min={0} max={k === "damage" ? 99999 : k === "distance" ? 999999 : 999} defaultValue={0} required />
                    </Field>
                  ))}
                  <Field label={ru ? "Место" : "Placement"}>
                    <select name="placement" defaultValue="">
                      <option value="">—</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                    </select>
                  </Field>
                  <Field label={ru ? "ID матча" : "Match ID"}>
                    <input name="matchRef" maxLength={80} required />
                  </Field>
                </div>
                <Field label={ru ? "Доказательство (HTTPS)" : "Evidence URL (HTTPS)"}>
                  <input name="evidence" type="url" maxLength={500} placeholder="https://…" />
                </Field>
                <button className="btn btn-primary btn-sm">{ru ? "Внести" : "Log result"}</button>
              </ActionForm>
            </details>
          ) : null}
          {lines.length ? (
            <details className="disclosure" id="score-history" open={logPage > 1}>
              <summary>
                {ru ? "Журнал результатов" : "Score log"} ({stats.entries}) · {ru ? "Страница" : "Page"} {logPage}/{logPages}
              </summary>
              {logPages > 1 ? <nav className="row" aria-label={ru ? "Страницы журнала результатов" : "Score log pages"}>
                {logPage > 1 ? <Link className="btn btn-ghost btn-xs" href={scoreHistoryPath(logPage - 1)}>{ru ? "Новее" : "Newer"}</Link> : null}
                {logPage < logPages ? <Link className="btn btn-ghost btn-xs" href={scoreHistoryPath(logPage + 1)}>{ru ? "Старее" : "Older"}</Link> : null}
              </nav> : null}
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{d.tournaments.participants}</th>
                      <th>K / A / D / HS</th>
                      <th>DMG · m · #</th>
                      <th>{ru ? "Источник" : "Source"}</th>
                      <th>{d.match.status}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.id}>
                        <td>{l.name}</td>
                        <td>
                          {l.kills} / {l.assists} / {l.deaths} / {l.headshots}
                        </td>
                        <td>
                          {l.damage} · {l.distance} · {l.placement ?? "—"}
                        </td>
                        <td className="small">
                          {l.source === "organizer" ? (ru ? "организатор" : "organiser") : ru ? "участник" : "participant"} · {l.submitted_by}
                        </td>
                        <td>
                          <Badge status={l.review === "pending" ? "warn" : l.review === "rejected" ? "bad" : "ok"}>{reviewLabel(l.review, lang)}</Badge>
                        </td>
                        <td>
                          <ScoreCorrectionForm lang={lang} back={back} tournament={t} entry={l} />
                          {["accepted", "approved"].includes(l.review) && ["IN_PROGRESS", "PAUSED"].includes(t.status) ? (
                            <details className="disclosure">
                              <summary>{ru ? "Отклонить" : "Reject"}</summary>
                              <ActionForm action="score.review" lang={lang} back={back} hidden={{ entry: l.id, expectedRevision: String(l.revision), decision: "reject" }} className="inline-form">
                                <input name="note" required minLength={5} maxLength={500} placeholder={ru ? "Причина" : "Reason"} aria-label={ru ? "Причина" : "Reason"} />
                                <button className="btn btn-danger btn-xs">{ru ? "Отклонить" : "Reject"}</button>
                              </ActionForm>
                            </details>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </section>
      ) : null}

      <section className="section-tight">
        <h2 className="h3">{o.participantsTitle}</h2>
        {preStart && manager ? <p className="small muted">{o.seedsNote}</p> : null}
        {list.some((p) => p.status === "pending") ? (
          <p className="notice notice-warn">
            {ru
              ? `Заявок ждут решения: ${list.filter((p) => p.status === "pending").length}. Нерассмотренные заявки закрываются при старте.`
              : `Applications awaiting a decision: ${list.filter((p) => p.status === "pending").length}. Undecided applications close at the start.`}
          </p>
        ) : null}
        {list.length ? (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{d.tournaments.seed}</th>
                    <th>{d.tournaments.participants}</th>
                    <th>{d.match.status}</th>
                    <th>{d.tournaments.checkIn}</th>
                    {manager ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <tr key={p.id}>
                      <td>
                        {preStart && manager && p.status === "registered" ? (
                          <input className="seed-input" form="seeds-form" name={`seed_${p.id}`} type="number" min={1} max={512} defaultValue={p.seed ?? ""} aria-label={`${d.tournaments.seed}: ${p.name}`} />
                        ) : (
                          p.seed ?? "—"
                        )}
                      </td>
                      <td>
                        {p.name}
                        {p.team_slug ? <div className="small muted">{p.roster.join(", ")}</div> : null}
                        {fields.length && answersOf.get(p.id) ? (
                          <details className="disclosure">
                            <summary>{ru ? "Ответы при регистрации" : "Registration answers"}</summary>
                            <ul className="kv-list small">
                              {answerLines(fields, answersOf.get(p.id), ru ? "да" : "yes", ru ? "нет" : "no").map(([q, a]) => (
                                <li key={q}>
                                  <span>{q}</span>
                                  <strong>{a}</strong>
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                        {manager && t.participant_type === "team" && ["registered", "waitlisted"].includes(p.status) && !finished && rosterIds.some((r) => r.registration_id === p.id) ? (
                          <details className="disclosure">
                            <summary>{ru ? "Замена в составе" : "Roster substitution"}</summary>
                            <ActionForm action="tournament.substitute" lang={lang} back={back} hidden={{ ...hidden, registration: p.id }} className="stack-sm">
                              <label className="field">
                                <span className="field-label">{ru ? "Выходит" : "Out"}</span>
                                <select name="out" required>
                                  {rosterIds
                                    .filter((r) => r.registration_id === p.id)
                                    .map((r) => (
                                      <option key={r.user_id} value={r.user_id}>
                                        @{r.username}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              <label className="field">
                                <span className="field-label">{ru ? "Входит (игрок команды)" : "In (team player)"}</span>
                                <select name="in" required>
                                  {teamPool
                                    .filter((m) => m.team_id === teamOf.get(p.id) && !rosterIds.some((r) => r.registration_id === p.id && r.user_id === m.user_id))
                                    .map((m) => (
                                      <option key={m.user_id} value={m.user_id}>
                                        @{m.username}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              <input name="reason" required minLength={5} maxLength={300} placeholder={o.reason} aria-label={o.reason} />
                              <button className="btn btn-ghost btn-xs">{ru ? "Заменить" : "Substitute"}</button>
                            </ActionForm>
                          </details>
                        ) : null}
                      </td>
                      <td>
                        <Badge status={p.status === "pending" ? "in_review" : p.status}>{d.statuses.registration[p.status]}</Badge>
                        {p.placement ? <strong> #{p.placement}</strong> : null}
                        {manager && p.status === "pending" && preStart ? (
                          <div className="stack-sm">
                            <ActionForm action="tournament.approve" lang={lang} back={back} hidden={{ ...hidden, registration: p.id }}>
                              <button className="btn btn-primary btn-xs">{ru ? "Одобрить" : "Approve"}</button>
                            </ActionForm>
                            <details className="disclosure">
                              <summary>{ru ? "Отклонить" : "Reject"}</summary>
                              <ActionForm action="tournament.reject" lang={lang} back={back} hidden={{ ...hidden, registration: p.id }} className="inline-form">
                                <input name="reason" required minLength={5} maxLength={300} placeholder={ru ? "Причина для заявителя" : "Reason for the applicant"} aria-label={o.reason} />
                                <button className="btn btn-danger btn-xs">{ru ? "Отклонить" : "Reject"}</button>
                              </ActionForm>
                            </details>
                          </div>
                        ) : null}
                        {p.status === "rejected" && rejectionOf.get(p.id) ? (
                          <div className="small muted">{rejectionOf.get(p.id) === "expired" ? (ru ? "не рассмотрена до старта" : "not reviewed before the start") : rejectionOf.get(p.id)}</div>
                        ) : null}
                      </td>
                      <td>
                        {p.checked_in_at ? "✓" : "—"}
                        {manager && preStart && p.status === "registered" && status !== "PUBLISHED" ? (
                          <ActionForm action="tournament.checkin_override" lang={lang} back={back} hidden={{ ...hidden, registration: p.id, checked: p.checked_in_at ? "0" : "1" }}>
                            <button className="btn btn-ghost btn-xs">{p.checked_in_at ? o.unmarkCheckedIn : o.markCheckedIn}</button>
                          </ActionForm>
                        ) : null}
                      </td>
                      {manager ? (
                        <td>
                          {["registered", "waitlisted"].includes(p.status) && !["COMPLETED", "CANCELLED", "ARCHIVED"].includes(status) ? (
                            <details className="disclosure">
                              <summary>{o.disqualify}</summary>
                              <ActionForm action="tournament.disqualify" lang={lang} back={back} hidden={{ ...hidden, registration: p.id }} className="inline-form">
                                <input name="reason" required minLength={3} maxLength={300} placeholder={o.reason} aria-label={o.reason} />
                                <button className="btn btn-danger btn-xs">{o.disqualify}</button>
                              </ActionForm>
                            </details>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preStart && manager ? (
              <form id="seeds-form" method="post" action={`/api/a/tournament.seeds?lang=${lang}`}>
                <input type="hidden" name="lang" value={lang} />
                <input type="hidden" name="back" value={back} />
                <input type="hidden" name="tournament" value={t.id} />
                <button className="btn btn-ghost btn-sm">{o.saveSeeds}</button>
              </form>
            ) : null}
            {preStart ? (
              <p className="small muted">
                {ru
                  ? "Без ручного посева порядок определяет игровой опыт (XP) в этой игре, затем порядок регистрации. Посев никогда не случайный."
                  : "Without manual seeds, order follows experience (XP) in this game, then registration order. Seeding is never random."}
              </p>
            ) : null}
          </>
        ) : (
          <p className="muted">{d.tournaments.noParticipants}</p>
        )}
      </section>

      {matches.length ? (
        <section className="section-tight">
          <h2 className="h3">{o.matchesTitle}</h2>
          {openMatches.length ? (
            <ul className="list">
              {openMatches.map((m) => (
                <li key={m.id}>
                  <span className="grow">
                    {label(m)}: {m.a_name ?? d.common.tbd} {d.common.vs} {m.b_name ?? d.common.tbd}
                  </span>
                  <Badge status={m.status}>{d.statuses.match[m.status]}</Badge>
                  <Link href={matchPath(m.id)} className="btn btn-ghost btn-xs">
                    {o.open}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          <BracketView lang={lang} matches={rounds ? mainMatches : matches} format={t.format} series={seriesById} />
          {chainStages
            .filter((s) => s.matches.length)
            .map((s) => (
              <div key={s.stage} className="bracket-group">
                <h3 className="h3">
                  {`${stageTitle(s.stage, lang)} · ${chainStageLabel(s.spec, lang)}`}
                </h3>
                <BracketView lang={lang} matches={s.matches} format={s.spec.format} series={seriesById} scope={`s${s.stage}`} />
              </div>
            ))}
          {playoff && playoffMatches.length ? (
            <div className="bracket-group">
              <h3 className="h3">{ru ? "Плей-офф" : "Playoff"}</h3>
              <BracketView lang={lang} matches={playoffMatches} format={playoff.format} series={seriesById} scope="p" />
            </div>
          ) : null}
        </section>
      ) : null}

      {groupTables.length ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Таблицы групп" : "Group tables"}</h2>
          <div className="stage-tables">
            {groupTables.map((g) => (
              <div key={g.group} className="stack-sm">
                <h3 className="h4">{groupTitle(g.group, lang)}</h3>
                <StandingsTable lang={lang} format="groups" rows={g.rows} names={names} final={false} advance={settings.groups?.advance ?? 0} onward={chain.length ? "stage" : "playoff"} />
              </div>
            ))}
          </div>
        </section>
      ) : rounds && roundTable.length ? (
        <section className="section-tight">
          <h2 className="h3">{playoff ? (ru ? "Таблица основного этапа" : "Main-stage table") : d.tournaments.tabs.standings}</h2>
          <StandingsTable
            lang={lang}
            format={rounds}
            rows={roundTable}
            names={names}
            final={finished && !playoff && !chain.length}
            advance={(chain[0] ?? playoff) ? Math.min((chain[0] ?? playoff)!.size, roundTable.length) : 0}
            onward={chain.length ? "stage" : "playoff"}
          />
        </section>
      ) : null}

      {chainStages
        .filter((s) => s.tables.length)
        .map((s) => (
          <section key={s.stage} className="section-tight">
            <h2 className="h3">
              {`${stageTitle(s.stage, lang)} · ${chainStageLabel(s.spec, lang)}`}
            </h2>
            <StageStandings
              lang={lang}
              format={s.spec.format}
              tables={s.tables}
              names={names}
              final={finished && !playoff && s.stage === chain.length + 1}
              advance={
                s.spec.format === "groups"
                  ? (s.spec.groups?.advance ?? 0)
                  : (chain[s.stage - 1] ?? playoff)
                    ? Math.min((chain[s.stage - 1] ?? playoff)!.size, s.tables[0]?.rows.length ?? 0)
                    : 0
              }
              onward={s.stage < chain.length + 1 ? "stage" : "playoff"}
            />
          </section>
        ))}

      {manager && !finished && status !== "CANCELLED" ? (
        <section className="section-tight" id="place">
          <h2 className="h3">{ru ? "Место проведения" : "Where it is held"}</h2>
          <p className="small muted">
            {ru
              ? "Подтверждённая площадка вашего пространства: участники получают QR-пропуск, который проходит один раз. Добавить площадку — в разделе «Площадки» пространства."
              : "A confirmed venue of your space: participants get a QR pass that admits once. Add a venue in the space's “Venues” section."}
          </p>
          <ActionForm action="tournament.venue_set" lang={lang} back={`${back}#place`} hidden={hidden} className="inline-form">
            <select name="venue" defaultValue={placeId ?? ""} aria-label={ru ? "Площадка" : "Venue"}>
              <option value="">{ru ? "Онлайн, без площадки" : "Online, no venue"}</option>
              {places.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} · {v.city}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost btn-sm">{d.common.save}</button>
          </ActionForm>
        </section>
      ) : null}

      {manager ? <StreamsManager db={db} lang={lang} back={back} tournament={{ id: t.id, status }} /> : null}

      {manager && matchFormat && !finished && status !== "CANCELLED" ? (
        <section className="section-tight" id="schedule">
          <h2 className="h3">{ru ? "Площадки и расписание" : "Venues and schedule"}</h2>
          <p className="small muted">
            {ru
              ? `Площадка (сцена, станция, сервер) принимает один матч одновременно; участник и игрок не играют два матча сразу — в том числе в другом турнире. Длительность матча — ${t.match_minutes ?? DEFAULT_MATCH_MINUTES} мин (меняется в параметрах турнира). Изменение с пересечением сохраняется только с подтверждением и попадает в журнал (MV-SCHEDULE-1).`
              : `A venue (stage, station, server) hosts one match at a time; no entrant or player plays two matches at once — in another tournament either. Match length: ${t.match_minutes ?? DEFAULT_MATCH_MINUTES} min (set in the tournament settings). A change that creates an overlap is saved only when confirmed and is logged (MV-SCHEDULE-1).`}
          </p>
          <div className="stack-sm">
            <p className="field-label">{ru ? "Площадки" : "Venues"}</p>
            {venueList.length ? (
              <ul className="list">
                {venueList.map((v) => (
                  <li key={v.id}>
                    <span className="grow">
                      {v.name} <span className="muted small">· {kindLabel[v.kind] ?? v.kind}</span>
                    </span>
                    <ActionForm action="tournament.venue_remove" lang={lang} back={`${back}#schedule`} hidden={{ ...hidden, venue: v.id }}>
                      <button className="btn btn-ghost btn-xs">{ru ? "Удалить" : "Remove"}</button>
                    </ActionForm>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">{ru ? "Площадок нет: матчи играются онлайн или без привязки к месту." : "No venues: matches are played online or without a fixed place."}</p>
            )}
            <ActionForm action="tournament.venue_add" lang={lang} back={`${back}#schedule`} hidden={hidden} className="inline-form">
              <input name="name" required maxLength={60} placeholder={ru ? "Например: Сцена 1, Сервер EU-2" : "For example: Stage 1, Server EU-2"} aria-label={ru ? "Название площадки" : "Venue name"} />
              <select name="kind" defaultValue="station" aria-label={ru ? "Тип площадки" : "Venue type"}>
                {VENUE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {kindLabel[k]}
                  </option>
                ))}
              </select>
              <button className="btn btn-ghost btn-sm">{ru ? "Добавить площадку" : "Add venue"}</button>
            </ActionForm>
          </div>
          {running && openRounds.length ? (
            <div className="grid grid-3">
              <ActionForm action="tournament.reschedule" lang={lang} back={`${back}#schedule`} hidden={hidden} className="stack-sm card">
                <TimeZoneField />
                <Field label={ru ? "Тур или раунд" : "Round"}>
                  <select name="round" required>
                    {openRounds.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={ru ? "Новое время начала" : "New start time"}>
                  <LocalDateTimeInput name="at" required />
                </Field>
                <label className="check small">
                  <input type="checkbox" name="force" value="1" />
                  <span>{ru ? "Сохранить даже с пересечениями" : "Save even with overlaps"}</span>
                </label>
                <button className="btn btn-ghost btn-sm">{ru ? "Назначить время тура" : "Set the round time"}</button>
              </ActionForm>
              <ActionForm action="tournament.waves" lang={lang} back={`${back}#schedule`} hidden={hidden} className="stack-sm card">
                <TimeZoneField />
                <Field label={ru ? "Тур по площадкам" : "Round on venues"} hint={ru ? "Матч i — на площадке i по кругу, волнами" : "Match i on venue i in turn, in waves"}>
                  <select name="round" required>
                    {openRounds.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={ru ? "Начало первой волны" : "First wave starts"}>
                  <LocalDateTimeInput name="at" required />
                </Field>
                <label className="check small">
                  <input type="checkbox" name="force" value="1" />
                  <span>{ru ? "Сохранить даже с пересечениями" : "Save even with overlaps"}</span>
                </label>
                <button className="btn btn-ghost btn-sm" disabled={!venueList.length}>
                  {ru ? "Распределить по площадкам" : "Place on venues"}
                </button>
              </ActionForm>
              <ActionForm action="tournament.reschedule" lang={lang} back={`${back}#schedule`} hidden={{ ...hidden, round: "all" }} className="stack-sm card">
                <Field label={ru ? "Сдвинуть все назначенные матчи, минут" : "Shift every scheduled match, minutes"} hint={ru ? "Например 30 или −15" : "For example 30 or −15"}>
                  <input name="shiftMinutes" type="number" min={-1440} max={1440} required inputMode="numeric" />
                </Field>
                <label className="check small">
                  <input type="checkbox" name="force" value="1" />
                  <span>{ru ? "Сохранить даже с пересечениями" : "Save even with overlaps"}</span>
                </label>
                <button className="btn btn-ghost btn-sm">{ru ? "Сдвинуть расписание" : "Shift the schedule"}</button>
              </ActionForm>
            </div>
          ) : null}
          {conflicts.length ? (
            <div className="notice notice-warn stack-sm" role="status">
              <strong>
                {ru ? `Пересечения в расписании: ${conflicts.length}` : `Schedule overlaps: ${conflicts.length}`}
              </strong>
              <ul className="list small">
                {conflicts.slice(0, 30).map((c, i) => (
                  <li key={i}>
                    {c.kind === "venue"
                      ? `${ru ? "Площадка" : "Venue"} «${venueName.get(c.venue ?? "") ?? "—"}»`
                      : c.kind === "entrant"
                        ? ru
                          ? "Один участник в двух матчах"
                          : "One entrant in two matches"
                        : ru
                          ? "Один игрок в двух матчах"
                          : "One player in two matches"}
                    : {matchName(c.a)} ↔ {matchName(c.b)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {upcoming.length ? (
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{ru ? "Время" : "Time"}</th>
                    <th>{ru ? "Матч" : "Match"}</th>
                    <th>{ru ? "Площадка" : "Venue"}</th>
                  </tr>
                </thead>
                <tbody>
                  {upcoming.map((m) => (
                    <tr key={m.id} className={conflicted.has(m.id) ? "is-out" : undefined}>
                      <td className="nowrap">
                        <LocalTime iso={m.scheduled_at!} lang={lang} />
                      </td>
                      <td>
                        <Link href={matchPath(m.id)}>{matchName(m.id)}</Link>
                        {conflicted.has(m.id) ? <span className="small"> · {ru ? "пересечение" : "overlap"}</span> : null}
                      </td>
                      <td>{m.venue_name ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}

      {ffaLobbies.length ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Лобби" : "Lobbies"}</h2>
          <FfaRounds lang={lang} lobbies={ffaLobbies} names={names} advance={ffaSettingsOf(t).advance} finished={finished} />
        </section>
      ) : null}

      {rating ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Оценки участников" : "Participants' ratings"}</h2>
          {rating.count ? (
            <>
              <p>
                <strong>{rating.average?.toLocaleString(ru ? "ru-RU" : "en-US")}</strong> / 5 ·{" "}
                {rating.count} {ru ? ruPlural(rating.count, "оценка", "оценки", "оценок") : rating.count === 1 ? "rating" : "ratings"}
              </p>
              <ul className="list">
                {comments
                  .filter((c) => c.comment)
                  .map((c, i) => (
                    <li key={i} className="stack-sm">
                      <span className="small muted">
                        {"★".repeat(c.rating)}
                        {"☆".repeat(5 - c.rating)} · @{c.username} · <LocalTime iso={c.updated_at} lang={lang} />
                      </span>
                      <span className="prewrap">{c.comment}</span>
                    </li>
                  ))}
              </ul>
            </>
          ) : (
            <p className="muted small">{ru ? "Оценок пока нет: участники могут оценить турнир в течение 30 дней." : "No ratings yet: participants can rate the tournament within 30 days."}</p>
          )}
        </section>
      ) : null}

      {history.length ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "История турнира" : "Tournament history"}</h2>
          <details className="disclosure">
            <summary>{ru ? `Последние записи журнала: ${history.length}` : `Latest log records: ${history.length}`}</summary>
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{ru ? "Когда" : "When"}</th>
                    <th>{ru ? "Что" : "What"}</th>
                    <th>{ru ? "Кто" : "Who"}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td className="nowrap small">
                        <LocalTime iso={h.at} lang={lang} />
                      </td>
                      <td>
                        {historyLabel(h.action, lang)}
                        {h.action === "tournament.status" && h.data?.to ? <span className="muted small"> · {d.statuses.tournament[String(h.data.to)] ?? String(h.data.to)}</span> : null}
                      </td>
                      <td className="small">{h.actor ? `@${h.actor}` : ru ? "система" : "system"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">{ru ? "Полный журнал с hash-цепочкой — в центре управления." : "The full hash-chained log is in the control centre."}</p>
          </details>
        </section>
      ) : null}

      {manager ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Со-организаторы" : "Co-organisers"}</h2>
          <p className="small muted">
            {ru
              ? "Со-организатор управляет этим турниром: участники, результаты, споры. Список ведёт только основной организатор или руководитель пространства."
              : "A co-organiser manages this tournament: entrants, results, disputes. Only the primary organiser or the space's managers edit this list."}
          </p>
          {coorgs.length ? (
            <ul className="list">
              {coorgs.map((c) => (
                <li key={c.id}>
                  <span className="grow">
                    {c.display_name} <span className="muted">@{c.username}</span>
                  </span>
                  {primary ? (
                    <ActionForm action="tournament.coorg_remove" lang={lang} back={back} hidden={{ ...hidden, member: c.id }}>
                      <button className="btn btn-ghost btn-xs">{ru ? "Убрать доступ" : "Remove access"}</button>
                    </ActionForm>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{ru ? "Со-организаторов нет." : "No co-organisers."}</p>
          )}
          {primary ? (
            <ActionForm action="tournament.coorg_add" lang={lang} back={back} hidden={hidden} className="inline-form">
              <input name="username" required pattern="[A-Za-z0-9_]{3,24}" placeholder={ru ? "имя пользователя" : "username"} aria-label={ru ? "Имя пользователя со-организатора" : "Co-organiser username"} />
              <button className="btn btn-ghost btn-sm">{ru ? "Добавить со-организатора" : "Add co-organiser"}</button>
            </ActionForm>
          ) : null}
        </section>
      ) : null}

      {manager ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Баннер турнира" : "Tournament banner"}</h2>
          <form method="post" action={`/api/a/tournament.banner?lang=${lang}`} encType="multipart/form-data" className="inline-form">
            <input type="hidden" name="lang" value={lang} />
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="tournament" value={t.id} />
            <input name="banner" type="file" accept="image/png,image/jpeg,image/webp" aria-label={ru ? "Файл баннера" : "Banner file"} />
            <button className="btn btn-ghost btn-sm">{ru ? "Загрузить (до 1 МБ)" : "Upload (up to 1 MB)"}</button>
          </form>
          {t.banner_media_id ? (
            <ActionForm action="tournament.banner" lang={lang} back={back} hidden={{ ...hidden, clear: "1" }}>
              <button className="btn btn-ghost btn-xs">{ru ? "Убрать баннер" : "Remove banner"}</button>
            </ActionForm>
          ) : null}
        </section>
      ) : null}

      {manager && editable ? (
        <section className="section-tight">
          <h2 className="h3">{o.edit}</h2>
          <TournamentForm lang={lang} back={back} t={t} structuralLocked={list.length > 0} circuits={circuitOptions} />
        </section>
      ) : null}

      {orgManager ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Копия турнира" : "Copy this tournament"}</h2>
          <p className="small muted">
            {ru
              ? "Создаёт черновик с теми же форматом, настройками, правилами, форматом серий, допуском, площадками и связью с активной серией. Участники, матчи, со-организаторы, спонсоры и награда оператора не копируются."
              : "Creates a draft with the same format, settings, rules, series format, admission, venues and active circuit link. Entrants, matches, co-organisers, sponsors and the operator's award are not copied."}
          </p>
          <ActionForm action="tournament.clone" lang={lang} back={back} hidden={hidden} className="stack-sm">
            <TimeZoneField />
            <div className="form-grid">
              <Field label={o.tName}>
                <input name="name" required minLength={2} maxLength={80} defaultValue={`${t.name} (2)`.slice(0, 80)} />
              </Field>
              <Field label={o.startsAt} hint={ru ? "Пусто — через неделю" : "Empty = in a week"}>
                <LocalDateTimeInput name="startsAt" />
              </Field>
            </div>
            <button className="btn btn-ghost btn-sm">{ru ? "Создать копию" : "Create a copy"}</button>
          </ActionForm>
        </section>
      ) : null}

      {orgManager ? (
        <section className="section-tight">
          <h2 className="h3">{ru ? "Сохранить как шаблон" : "Save as a template"}</h2>
          <p className="small muted">
            {ru
              ? "Шаблон хранит формат, настройки, правила, вопросы регистрации, формат серий, допуск, площадки и сроки относительно старта. Новые турниры создаются из него в пространстве организатора."
              : "A template keeps the format, settings, rules, registration questions, series format, admission, venues and deadlines relative to the start. New tournaments are created from it in the organiser space."}
          </p>
          <ActionForm action="template.save" lang={lang} back={back} hidden={hidden} className="inline-form">
            <input name="name" required minLength={2} maxLength={80} defaultValue={t.name} aria-label={ru ? "Название шаблона" : "Template name"} />
            <input name="category" maxLength={40} placeholder={ru ? "Категория, например: Кубки недели" : "Category, e.g. Weekly cups"} aria-label={ru ? "Категория" : "Category"} />
            <button className="btn btn-ghost btn-sm">{ru ? "Сохранить шаблон" : "Save template"}</button>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
