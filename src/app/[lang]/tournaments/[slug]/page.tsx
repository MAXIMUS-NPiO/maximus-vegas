import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale, ruPlural, type Locale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { countryName } from "@/lib/countries.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { bracket, getTournament, participants, type BracketMatch, type Participant } from "@/server/queries.ts";
import { canManageTournament, registrationOpen } from "@/server/tournaments.ts";
import { rosterHistory, rosterLocked } from "@/server/rosters.ts";
import { fieldsOf } from "@/server/registration.ts";
import { planSingleElimination } from "@/server/bracket.ts";
import { planDoubleElimination } from "@/server/double.ts";
import { roundRobinSchedule } from "@/server/roundrobin.ts";
import { pairSwissRound } from "@/server/swiss.ts";
import { isRoundFormat, settingsOf, type FormatSettings } from "@/server/format-settings.ts";
import { groupStandings, roundStandings } from "@/server/rounds.ts";
import { roundTables } from "@/server/lobbies.ts";
import { dealLobbies, ffaSettingsOf, planRounds } from "@/server/ffa.ts";
import { planGauntlet, snakeGroups } from "@/server/stages.ts";
import { leaderboardStandings, scoreLog } from "@/server/leaderboard.ts";
import { DEFAULT_WEIGHTS, mergeWeights, WEIGHT_KEYS } from "@/server/scoring.ts";
import { tournamentSponsors } from "@/server/sponsors.ts";
import { mediaUrl } from "@/server/media.ts";
import type { Database } from "@/server/db.ts";
import type { SessionUser } from "@/server/auth.ts";
import { ActionForm, Badge, DbDown, Empty, Field, Flash, SignInPrompt, type SearchParams } from "@/components/ui";
import { AdmissionView, AnswerFields, BracketView, FfaRounds, FfaRules, formatLabel, groupTitle, playoffFormatLabel, RoundRules, SeriesRulesView, StandingsTable, type StandingName } from "@/components/tournament";
import { Countdown, LocalTime } from "@/components/time";
import { reviewLabel } from "@/lib/labels.ts";
import { seriesCustomised, seriesMap, seriesRulesOf } from "@/server/series.ts";
import { admissionOf, playerStandings, unmetCriteria } from "@/server/admission.ts";
import { canRate, feedbackSummary, ownFeedback } from "@/server/feedback.ts";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  const { db } = await viewer();
  const t = db ? await getTournament(db, slug).catch(() => null) : null;
  if (!t || t.status === "DRAFT") return pageMeta(lang, `tournaments/${slug}`, dict(lang).tournaments.title, undefined, { noindex: true });
  return pageMeta(lang, `tournaments/${slug}`, t.name, `${gameBySlug(t.game)?.name ?? t.game} · ${formatLabel(t.format, lang)} · ${t.org_name}`);
}

async function myEntry(db: Database, tournamentId: string, user: SessionUser) {
  const [reg] = await db.query<{ id: string; status: string; checked_in_at: Date | null; leader: boolean; team_name: string | null; team_id: string | null; decision_note: string }>(
    `select r.id, r.status, r.checked_in_at, tm.name as team_name, r.team_id, r.decision_note,
            (r.user_id = $2 or tm.owner_id = $2 or tm.captain_id = $2) as leader
       from registrations r left join teams tm on tm.id = r.team_id
      where r.tournament_id = $1 and r.status <> 'withdrawn'
        and (r.user_id = $2 or tm.owner_id = $2 or tm.captain_id = $2
             or exists (select 1 from roster_entries re where re.registration_id = r.id and re.user_id = $2))
      order by r.created_at desc limit 1`,
    [tournamentId, user.id],
  );
  return reg ?? null;
}

async function eligibleTeams(db: Database, user: SessionUser, game: string, size: number) {
  return db.query<{ id: string; name: string; members: number }>(
    `select t.id, t.name, (select count(*)::int from team_members m where m.team_id = t.id) as members
       from teams t where t.game = $2 and (t.owner_id = $1 or t.captain_id = $1)
      order by t.name`,
    [user.id, game],
  ).then((rows) => rows.filter((r) => r.members >= size && r.members <= size + 3));
}

/** Rounds shown in a round-robin preview before the start; the full schedule appears at the start. */
const PREVIEW_ROUNDS = 5;

/** Registered entrants in the order the start will seed them (manual seeds first, then registration). */
const seededList = (list: Participant[]) =>
  list
    .filter((p) => p.status === "registered")
    .sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9) || new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

function preview(list: Participant[], format: string, settings: FormatSettings): BracketMatch[] {
  const seeded = seededList(list);
  if (seeded.length < 2 || format === "groups") return [];
  const game = (id: string, bracketKey: "RR" | "SW", round: number, position: number, a: Participant, b: Participant | null): BracketMatch => ({
    id,
    bracket: bracketKey,
    a_void: false,
    b_void: !b,
    round,
    position,
    status: "pending",
    outcome: b ? null : "bye",
    a_reg: a.id,
    b_reg: b?.id ?? null,
    a_name: a.name,
    b_name: b?.name ?? null,
    winner_reg: null,
    score_a: null,
    score_b: null,
    scheduled_at: null,
  });
  if (format === "round_robin")
    return roundRobinSchedule(seeded, settings.legs ?? 1)
      .matches.filter((m) => m.round <= PREVIEW_ROUNDS)
      .map((m) => game(`p-RR-${m.round}-${m.position}`, "RR", m.round, m.position, m.a, m.b));
  if (format === "swiss") {
    // Round 1 only: later rounds depend on results. Everyone starts on zero points, so seeds decide.
    const byId = new Map(seeded.map((p) => [p.id, p]));
    const pairing = pairSwissRound(seeded.map((p, i) => ({ id: p.id, seed: i + 1, points: 0, byes: 0 })), () => false);
    const out = pairing.pairs.map(([a, b], i) => game(`p-SW-1-${i}`, "SW", 1, i, byId.get(a)!, byId.get(b)!));
    if (pairing.bye) out.push(game("p-SW-1-bye", "SW", 1, out.length, byId.get(pairing.bye)!, null));
    return out;
  }
  const base = (m: { round: number; position: number; a: Participant | null; b: Participant | null }, bracketKey: "W" | "L" | "GF" | "G", aVoid = false, bVoid = false) => ({
    id: `p-${bracketKey}-${m.round}-${m.position}`,
    bracket: bracketKey,
    a_void: aVoid,
    b_void: bVoid,
    round: m.round,
    position: m.position,
    status: "pending",
    outcome: bracketKey === "W" && m.round === 1 && Boolean(m.a) !== Boolean(m.b) ? "bye" : null,
    a_reg: m.a?.id ?? null,
    b_reg: m.b?.id ?? null,
    a_name: m.a?.name ?? null,
    b_name: m.b?.name ?? null,
    winner_reg: null,
    score_a: null,
    score_b: null,
    scheduled_at: null,
  });
  if (format === "double_elimination") return planDoubleElimination(seeded).matches.map((m) => base(m, m.bracket, m.aVoid, m.bVoid)) as BracketMatch[];
  if (format === "gauntlet") return planGauntlet(seeded).matches.map((m) => base({ round: m.round, position: 0, a: m.a, b: m.b }, "G")) as BracketMatch[];
  return planSingleElimination(seeded).matches.map((m) => base(m, "W")) as BracketMatch[];
}

const weightLabel = (key: string, lang: Locale) => {
  const ru: Record<string, string> = { kills: "Убийство", assists: "Помощь", headshots: "Убийство в голову", damage: "Единица урона", distance: "Метр пути", place1: "1-е место", place2: "2-е место", place3: "3-е место" };
  const en: Record<string, string> = { kills: "Kill", assists: "Assist", headshots: "Headshot kill", damage: "Damage point", distance: "Metre travelled", place1: "1st place", place2: "2nd place", place3: "3rd place" };
  return (lang === "ru" ? ru : en)[key] ?? key;
};

export default async function TournamentPage({ params, searchParams }: { params: Promise<{ lang: string; slug: string }>; searchParams: SearchParams }) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const ru = lang === "ru";
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  const t = await getTournament(db, slug);
  if (!t) notFound();
  const manager = await canManageTournament(db, t, user);
  if (t.status === "DRAFT" && !manager) notFound();
  const leaderboard = t.format === "leaderboard";
  const rounds = isRoundFormat(t.format) ? t.format : null;
  const settings = settingsOf(t);
  const [list, matches, sponsorsList] = await Promise.all([participants(db, t.id), leaderboard ? Promise.resolve([]) : bracket(db, t.id), tournamentSponsors(db, t.id)]);
  const entry = user ? await myEntry(db, t.id, user) : null;
  const applying = !entry || entry.status === "rejected";
  const teams = user && applying && t.participant_type === "team" && registrationOpen(t) ? await eligibleTeams(db, user, t.game, t.team_size) : [];
  const fields = fieldsOf(t);
  // A team leader's event roster: current line-up, the team's members to choose from, and the change history.
  const rosterRows =
    entry?.team_id && entry.leader
      ? await Promise.all([
          db.query<{ user_id: string; username: string }>(
            "select re.user_id, u.username from roster_entries re join users u on u.id = re.user_id where re.registration_id = $1 order by u.username",
            [entry.id],
          ),
          db.query<{ user_id: string; username: string; display_name: string }>(
            "select m.user_id, u.username, u.display_name from team_members m join users u on u.id = m.user_id where m.team_id = $1 and u.status = 'active' order by u.username",
            [entry.team_id],
          ),
          rosterHistory(db, entry.id),
        ])
      : null;
  const entryRoster = rosterRows?.[0] ?? [];
  const teamMembers = rosterRows?.[1] ?? [];
  const entryHistory = rosterRows?.[2] ?? [];
  const game = gameBySlug(t.game);
  const back = `/${lang}/tournaments/${t.slug}`;
  const ffa = t.format === "ffa";
  const ffaRules = ffaSettingsOf(t);
  const lobbyTables = ffa && t.started_at ? await roundTables(db, t) : [];
  const started = matches.length > 0 || lobbyTables.length > 0;
  const previewMatches = !started && !leaderboard && !ffa ? preview(list, t.format, settings) : [];
  const plannedLobbies = ffa && !started && seededList(list).length >= 2 ? dealLobbies(seededList(list), ffaRules.lobbySize) : [];
  const plannedRounds = ffa && !started ? planRounds(seededList(list).length, ffaRules) : [];
  const previewRounds = rounds === "round_robin" ? roundRobinSchedule(list.filter((p) => p.status === "registered"), settings.legs ?? 1).rounds : 0;
  const standings = t.status === "COMPLETED" ? list.filter((p) => p.placement !== null).sort((a, b) => (a.placement ?? 0) - (b.placement ?? 0)) : [];
  // A main stage (round robin, Swiss or groups) may be followed by a playoff (stage 2).
  const playoff = rounds ? (settings.playoff ?? null) : null;
  const seriesRules = seriesRulesOf(t);
  const seriesById =
    seriesCustomised(seriesRules) || matches.some((m) => m.series_override) ? seriesMap(seriesRules, matches, { main: t.format, playoff: playoff?.format ?? null }) : undefined;
  const admission = admissionOf(t);
  const [myStanding] = admission && user ? await playerStandings(db, t.game, [user.id]) : [];
  const unmet = admission && myStanding ? unmetCriteria(admission, myStanding) : [];
  const mainMatches = matches.filter((m) => (m.stage ?? 1) === 1);
  const playoffMatches = matches.filter((m) => m.stage === 2);
  const roundTable = (rounds === "round_robin" || rounds === "swiss") && started ? await roundStandings(db, t) : [];
  const groupTables = rounds === "groups" && started ? await groupStandings(db, t) : [];
  const groupCount = settings.groups?.count ?? 0;
  const plannedGroups = rounds === "groups" && !started && seededList(list).length >= 2 ? snakeGroups(seededList(list), groupCount) : [];
  const groupMinimum = groupCount * Math.max(2, settings.groups?.advance ?? 1);
  const finished = t.status === "COMPLETED" || t.status === "ARCHIVED";
  const [rating, myRating, rateable] = finished
    ? await Promise.all([feedbackSummary(db, t.id), ownFeedback(db, t.id, user?.id), canRate(db, t.id, user?.id)])
    : [null, null, false];
  const names = new Map<string, StandingName>(list.map((p) => [p.id, { name: p.name, username: p.username, team_slug: p.team_slug }]));
  const linked = await db.query<{ id: string; slug: string; name: string; season: string }>(
    "select id, slug, name, season from circuits where id = any($1)",
    [[t.circuit_id, t.qualifier_circuit_id].filter(Boolean)],
  );
  const circuit = linked.find((c) => c.id === t.circuit_id) ?? null;
  const qualifier = linked.find((c) => c.id === t.qualifier_circuit_id) ?? null;
  const full = t.registered >= t.max_participants;
  const hidden = { tournament: t.id };
  const table = leaderboard && ["IN_PROGRESS", "PAUSED", "COMPLETED", "ARCHIVED"].includes(t.status) ? await leaderboardStandings(db, t) : [];
  const weights = mergeWeights(t.scoring);
  const deadlinePassed = Boolean(t.submission_deadline && new Date(t.submission_deadline).getTime() < Date.now());
  const canSubmit = leaderboard && entry?.leader && entry.status === "registered" && t.status === "IN_PROGRESS" && !deadlinePassed;
  const myLines = leaderboard && entry ? await scoreLog(db, t.id, { registrationId: entry.id }) : [];
  const [myCountry] = user && t.region_lock.length ? await db.query<{ country_code: string | null }>("select country_code from users where id = $1", [user.id]) : [];
  const tabs = leaderboard ? (["overview", "rules", "participants", "leaderboard", "standings"] as const) : (["overview", "rules", "participants", "bracket", "standings"] as const);
  const MainTables = () =>
    groupTables.length ? (
      <div className="stage-tables">
        {groupTables.map((g) => (
          <div key={g.group} className="stack-sm">
            <h3 className="h4">{groupTitle(g.group, lang)}</h3>
            <StandingsTable lang={lang} format="groups" rows={g.rows} names={names} final={false} advance={settings.groups?.advance ?? 0} />
          </div>
        ))}
      </div>
    ) : rounds ? (
      <StandingsTable lang={lang} format={rounds} rows={roundTable} names={names} final={finished && !playoff} advance={playoff ? Math.min(playoff.size, roundTable.length) : 0} />
    ) : null;

  return (
    <div className="container page">
      {t.banner_media_id ? <img className="banner-img" src={mediaUrl(t.banner_media_id)!} alt="" width={1200} height={300} /> : null}
      <header className="t-head">
        <div className="row">
          <Link href={`/${lang}/games/${t.game}`} className="eyebrow">
            {game?.name ?? t.game}
          </Link>
          <Badge status={t.status}>{d.statuses.tournament[t.status]}</Badge>
        </div>
        <h1>{t.name}</h1>
        <dl className="t-facts">
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
              {t.waitlisted ? ` (+${t.waitlisted})` : ""}
            </dd>
          </div>
          <div>
            <dt>{d.tournaments.type}</dt>
            <dd>{t.participant_type === "solo" ? d.tournaments.solo : `${d.tournaments.team} ${t.team_size}v${t.team_size}`}</dd>
          </div>
          <div>
            <dt>{d.tournaments.checkIn}</dt>
            <dd>
              {t.check_in_required ? d.tournaments.checkInRequired : d.tournaments.checkInNotRequired}
              {t.check_in_open ? ` · ${d.tournaments.checkInOpenNow}` : ""}
            </dd>
          </div>
          <div>
            <dt>{d.tournaments.format}</dt>
            <dd>{formatLabel(t.format, lang)}</dd>
          </div>
          {playoff ? (
            <div>
              <dt>{ru ? "Плей-офф" : "Playoff"}</dt>
              <dd>
                {playoffFormatLabel(playoff.format, lang)} · {playoff.size}
                {t.stage === 2 && !finished ? ` · ${ru ? "идёт" : "under way"}` : ""}
              </dd>
            </div>
          ) : null}
          {t.region ? (
            <div>
              <dt>{d.tournaments.region}</dt>
              <dd>{t.region}</dd>
            </div>
          ) : null}
          {t.region_lock.length ? (
            <div>
              <dt>{ru ? "Только для стран" : "Countries allowed"}</dt>
              <dd>{t.region_lock.map((c) => countryName(c, lang)).join(", ")}</dd>
            </div>
          ) : null}
          <div>
            <dt>{d.tournaments.organizer}</dt>
            <dd>{t.org_name}</dd>
          </div>
          {circuit ? (
            <div>
              <dt>{ru ? "Серия" : "Circuit"}</dt>
              <dd>
                <Link href={`/${lang}/circuits/${circuit.slug}`}>
                  {circuit.name} · {circuit.season}
                </Link>
                {t.circuit_division ? ` · ${ru ? "дивизион" : "division"} ${t.circuit_division}` : ""}
                {t.circuit_weight !== 100 ? ` · ×${(t.circuit_weight / 100).toLocaleString(ru ? "ru-RU" : "en-US")}` : ""}
              </dd>
            </div>
          ) : null}
          {qualifier ? (
            <div>
              <dt>{ru ? "Отбор" : "Qualification"}</dt>
              <dd>
                {ru ? "Только квалифицированные из " : "Only qualified from "}
                <Link href={`/${lang}/circuits/${qualifier.slug}`}>
                  {qualifier.name} · {qualifier.season}
                </Link>
              </dd>
            </div>
          ) : null}
          {t.prize_coins > 0 ? (
            <div>
              <dt>{ru ? "Награда победителю" : "Winner's award"}</dt>
              <dd>
                {t.prize_coins} {ru ? "монет каждому игроку состава" : "coins to each roster player"}
              </dd>
            </div>
          ) : null}
        </dl>
        {t.prize_coins > 0 ? (
          <p className="small muted">{ru ? "Монеты не имеют денежной стоимости и не выводятся. Награду назначает оператор портала, а не взносы участников." : "Coins have no cash value and cannot be withdrawn. The award is set by the portal operator, never funded by participant fees."}</p>
        ) : null}
        {t.prize_text ? (
          <p className="notice notice-quiet prewrap">
            <strong>{ru ? "Призы от организатора" : "Organiser's prizes"}: </strong>
            {t.prize_text}
          </p>
        ) : null}
        <div className="row">
          {t.livestream_url ? (
            <a href={t.livestream_url} target="_blank" rel="noopener noreferrer nofollow" className="btn btn-ghost btn-sm">
              {ru ? "Трансляция" : "Livestream"} ↗
            </a>
          ) : null}
          {manager ? (
            <Link href={`/${lang}/organizer/t/${t.slug}`} className="btn btn-ghost btn-sm">
              {d.tournaments.manage}
            </Link>
          ) : null}
        </div>
      </header>

      <Flash lang={lang} params={sp} />

      <section className="card reg-panel" aria-labelledby="reg-title">
        <h2 id="reg-title" className="h3">
          {d.tournaments.registerTitle}
        </h2>
        {t.registration_closes_at && t.status === "REGISTRATION_OPEN" ? (
          <p className="small muted">
            {ru ? "Регистрация до" : "Registration closes"} <LocalTime iso={t.registration_closes_at} lang={lang} />
            {t.approval_required ? (ru ? " · заявки рассматривает организатор" : " · the organiser reviews applications") : ""}
          </p>
        ) : t.approval_required && t.status === "REGISTRATION_OPEN" ? (
          <p className="small muted">{ru ? "Заявки рассматривает организатор." : "The organiser reviews applications."}</p>
        ) : null}
        {admission && ["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status) ? (
          <AdmissionView lang={lang} admission={admission} unmet={applying ? unmet : undefined} />
        ) : null}
        {entry ? (
          <div className="stack">
            <p>
              {d.tournaments.yourStatus}: <Badge status={entry.status === "pending" ? "in_review" : entry.status}>{d.statuses.registration[entry.status]}</Badge>
              {entry.team_name ? ` · ${entry.team_name}` : ""}
              {entry.checked_in_at ? (
                <>
                  {" "}
                  · <Badge status="confirmed">{d.tournaments.checkedIn}</Badge>
                </>
              ) : null}
            </p>
            {entry.status === "rejected" ? (
              <p className="notice notice-warn">
                {entry.decision_note === "expired"
                  ? ru
                    ? "Заявку не успели рассмотреть до старта, и она закрыта."
                    : "The application was not reviewed before the start and is closed."
                  : `${ru ? "Причина" : "Reason"}: ${entry.decision_note}`}
              </p>
            ) : null}
            <div className="row">
              {entry.leader && entry.status === "registered" && !entry.checked_in_at && t.check_in_open ? (
                <ActionForm action="tournament.checkin" lang={lang} back={back} hidden={hidden}>
                  <button className="btn btn-primary btn-sm">{d.tournaments.checkInNow}</button>
                </ActionForm>
              ) : null}
              {entry.leader && ["registered", "waitlisted", "pending"].includes(entry.status) && ["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status) ? (
                <ActionForm action="tournament.withdraw" lang={lang} back={back} hidden={hidden}>
                  <button className="btn btn-ghost btn-sm">{d.tournaments.withdraw}</button>
                </ActionForm>
              ) : null}
            </div>
            {entry.team_id && entry.leader && ["registered", "waitlisted", "pending"].includes(entry.status) ? (
              <details className="disclosure">
                <summary>{ru ? "Состав на турнир" : "Event roster"}</summary>
                {rosterLocked(t) ? (
                  <>
                    <p className="small muted">
                      {ru ? "Состав зафиксирован. Замену проводит организатор." : "The roster is locked. The organiser makes substitutions."}
                    </p>
                    <p>{entryRoster.map((m) => m.username).join(", ")}</p>
                  </>
                ) : (
                  <ActionForm action="registration.roster" lang={lang} back={back} hidden={{ ...hidden, registration: entry.id }} className="stack-sm">
                    <p className="small muted">
                      {ru
                        ? `Отметьте игроков: от ${t.team_size} до ${t.team_size + 3}. ${t.roster_locks_at ? "Изменения до " : "Изменения до старта."}`
                        : `Tick the players: ${t.team_size} to ${t.team_size + 3}. ${t.roster_locks_at ? "Changes until " : "Changes until the start."}`}
                      {t.roster_locks_at ? <LocalTime iso={t.roster_locks_at} lang={lang} /> : null}
                    </p>
                    {teamMembers.map((m) => (
                      <label key={m.user_id} className="check">
                        <input type="checkbox" name="member" value={m.user_id} defaultChecked={entryRoster.some((r) => r.user_id === m.user_id)} />
                        <span>
                          {m.display_name} <span className="muted">@{m.username}</span>
                        </span>
                      </label>
                    ))}
                    <button className="btn btn-ghost btn-sm">{d.common.save}</button>
                  </ActionForm>
                )}
                {entryHistory.length ? (
                  <ul className="list small">
                    {entryHistory.map((h, i) => (
                      <li key={i}>
                        <LocalTime iso={h.created_at} lang={lang} /> ·{" "}
                        {h.kind === "substitution"
                          ? `${ru ? "замена" : "substitution"}: ${h.out_name ?? "—"} → ${h.in_name ?? "—"}${h.reason ? ` (${h.reason})` : ""}`
                          : h.in_name
                            ? `${ru ? "добавлен" : "added"} ${h.in_name}`
                            : `${ru ? "убран" : "removed"} ${h.out_name ?? "—"}`}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </details>
            ) : null}
          </div>
        ) : null}
        {entry && entry.status !== "rejected" ? null : !registrationOpen(t) ? (
          entry ? null : <p className="muted">{d.tournaments.registrationClosed}</p>
        ) : !user ? (
          <SignInPrompt lang={lang} back={back} />
        ) : t.region_lock.length && !myCountry?.country_code ? (
          <div className="stack">
            <p className="notice notice-warn">{d.errors.country_required}</p>
            <Link href={`/${lang}/settings#profile`} className="btn btn-ghost btn-sm">
              {ru ? "Указать страну" : "Set my country"}
            </Link>
          </div>
        ) : t.participant_type === "solo" ? (
          <ActionForm action="tournament.register" lang={lang} back={back} hidden={hidden} className="stack">
            {full && !t.approval_required ? <p className="muted small">{d.tournaments.waitlistNote}</p> : null}
            <AnswerFields lang={lang} fields={fields} />
            <button className="btn btn-primary">{t.approval_required ? (ru ? "Подать заявку" : "Apply") : d.tournaments.register}</button>
          </ActionForm>
        ) : teams.length ? (
          <ActionForm action="tournament.register" lang={lang} back={back} hidden={hidden} className="stack">
            {full && !t.approval_required ? <p className="muted small">{d.tournaments.waitlistNote}</p> : null}
            <label className="field">
              <span className="field-label">{d.tournaments.chooseTeam}</span>
              <select name="team" required>
                {teams.map((tm) => (
                  <option key={tm.id} value={tm.id}>
                    {tm.name} ({tm.members})
                  </option>
                ))}
              </select>
            </label>
            <AnswerFields lang={lang} fields={fields} />
            <button className="btn btn-primary">{t.approval_required ? (ru ? "Подать заявку команды" : "Apply with the team") : d.tournaments.registerTeam}</button>
          </ActionForm>
        ) : (
          <div className="stack">
            <p className="muted">{d.tournaments.noEligibleTeam}</p>
            <Link href={`/${lang}/teams/new?game=${t.game}`} className="btn btn-ghost btn-sm">
              {d.tournaments.createTeam}
            </Link>
          </div>
        )}
      </section>

      <nav className="tabs" aria-label={t.name}>
        {tabs.map((k) => (
          <a key={k} href={`#${k}`}>
            {k === "leaderboard"
              ? ru
                ? "Таблица"
                : "Leaderboard"
              : k === "bracket" && ffa
                ? ru
                  ? "Лобби"
                  : "Lobbies"
                : k === "bracket" && rounds
                  ? ru
                    ? "Туры"
                    : "Rounds"
                  : d.tournaments.tabs[k as keyof typeof d.tournaments.tabs]}
          </a>
        ))}
      </nav>

      <section id="overview" className="section-tight">
        <h2 className="h3">{d.tournaments.tabs.overview}</h2>
        {t.description ? <p className="prewrap">{t.description}</p> : <p className="muted">—</p>}
        {sponsorsList.length ? (
          <div className="sponsor-strip" aria-label={ru ? "Спонсоры турнира" : "Tournament sponsors"}>
            {sponsorsList.map((s) =>
              s.website_url ? (
                <a key={s.id} href={s.website_url} target="_blank" rel="noopener noreferrer sponsored" className="sponsor">
                  {s.logo_media_id ? <img src={mediaUrl(s.logo_media_id)!} alt={s.name} height={40} /> : s.name}
                </a>
              ) : (
                <span key={s.id} className="sponsor">
                  {s.logo_media_id ? <img src={mediaUrl(s.logo_media_id)!} alt={s.name} height={40} /> : s.name}
                </span>
              ),
            )}
          </div>
        ) : null}
      </section>

      <section id="rules" className="section-tight">
        <h2 className="h3">{d.tournaments.tabs.rules}</h2>
        {t.rules ? <p className="prewrap">{t.rules}</p> : <p className="muted">{d.tournaments.noRules}</p>}
        {rounds ? <RoundRules lang={lang} format={rounds} settings={settings} started={Boolean(t.started_at)} /> : null}
        {ffa ? <FfaRules lang={lang} settings={ffaRules} started={Boolean(t.started_at)} /> : null}
        {seriesCustomised(seriesRules) ? <SeriesRulesView lang={lang} rules={seriesRules} format={t.format} playoffFormat={playoff?.format ?? null} /> : null}
        {admission ? <AdmissionView lang={lang} admission={admission} /> : null}
        {t.no_show_minutes !== null || t.roster_locks_at || t.participant_type === "team" ? (
          <ul className="kv-list card">
            {t.no_show_minutes !== null ? (
              <li>
                <span>{ru ? "Неявка" : "No-show"}</span>
                <strong>
                  {ru
                    ? `засчитывается через ${t.no_show_minutes} мин после назначенного времени`
                    : `recorded ${t.no_show_minutes} min after the scheduled time`}
                </strong>
              </li>
            ) : null}
            {t.participant_type === "team" ? (
              <li>
                <span>{ru ? "Составы" : "Rosters"}</span>
                <strong>
                  {t.roster_locks_at ? (
                    <>
                      {ru ? "фиксируются " : "lock at "}
                      <LocalTime iso={t.roster_locks_at} lang={lang} />
                    </>
                  ) : ru ? (
                    "фиксируются при старте"
                  ) : (
                    "lock at the start"
                  )}
                  {ru ? "; после — замены только через организатора" : "; after that, substitutions only through the organiser"}
                </strong>
              </li>
            ) : null}
          </ul>
        ) : null}
        {leaderboard ? (
          <div className="card stack-sm">
            <p className="field-label">{ru ? "Как считаются очки" : "How points are counted"}</p>
            <ul className="kv-list">
              {WEIGHT_KEYS.map((k) => (
                <li key={k}>
                  <span>{weightLabel(k, lang)}</span>
                  <strong>{weights[k]}</strong>
                  {weights[k] !== DEFAULT_WEIGHTS[k] ? <span className="small muted"> ({ru ? "изменено организатором" : "set by the organiser"})</span> : null}
                </li>
              ))}
            </ul>
            <p className="small muted">
              {t.best_of
                ? ru
                  ? `Учитываются ${t.best_of} лучших результатов участника.`
                  : `Each participant's best ${t.best_of} results count.`
                : ru
                  ? "Учитываются все подтверждённые результаты."
                  : "All accepted results count."}{" "}
              {ru ? "При равенстве очков выше KDA ((убийства + помощь) / смерти), затем число убийств." : "Ties are broken by KDA ((kills + assists) / deaths), then by kills."}
            </p>
            <p className="small muted">
              {ru
                ? "Невозможные (попаданий в голову больше, чем убийств) и неправдоподобные строки (более 40 убийств, 6000 урона или 20 000 м) не учитываются до решения организатора. Это проверка целостности данных, а не античит."
                : "Impossible lines (more headshots than kills) and implausible ones (over 40 kills, 6,000 damage or 20,000 m) do not count until the organiser decides. This is a data integrity check, not anti-cheat."}
            </p>
          </div>
        ) : null}
        <Link href={`/${lang}/trust`} className="text-link small">
          {d.tournaments.generalRules}
        </Link>
      </section>

      <section id="participants" className="section-tight">
        <h2 className="h3">
          {d.tournaments.tabs.participants} <span className="muted">({list.filter((p) => p.status === "registered").length})</span>
          {list.some((p) => p.status === "pending") ? (
            <span className="muted small"> · {ru ? "на рассмотрении" : "under review"}: {list.filter((p) => p.status === "pending").length}</span>
          ) : null}
        </h2>
        {list.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{d.tournaments.seed}</th>
                  <th>{d.tournaments.participants}</th>
                  <th>{d.tournaments.roster}</th>
                  <th>{d.match.status}</th>
                </tr>
              </thead>
              <tbody>
                {list.filter((p) => p.status !== "rejected").map((p) => (
                  <tr key={p.id}>
                    <td>{p.seed ?? "—"}</td>
                    <td>
                      {p.team_slug ? (
                        <Link href={`/${lang}/teams/${p.team_slug}`}>{p.name}</Link>
                      ) : p.username ? (
                        <Link href={`/${lang}/players/${p.username}`}>{p.name}</Link>
                      ) : (
                        p.name
                      )}
                    </td>
                    <td className="small muted">{p.team_slug ? p.roster.join(", ") : "—"}</td>
                    <td>
                      <Badge status={p.status}>{d.statuses.registration[p.status]}</Badge>
                      {p.checked_in_at && !started ? <span className="small ok-text"> ✓</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={d.tournaments.noParticipants} />
        )}
      </section>

      {leaderboard ? (
        <section id="leaderboard" className="section-tight">
          <h2 className="h3">{ru ? "Таблица" : "Leaderboard"}</h2>
          {t.submission_deadline ? (
            <p className="small muted">
              {ru ? "Самостоятельная отправка результатов до" : "Self-submission closes at"} <LocalTime iso={t.submission_deadline} lang={lang} />
              {deadlinePassed ? ` · ${ru ? "срок истёк" : "closed"}` : t.status === "IN_PROGRESS" ? (
                <>
                  {" · "}
                  <Countdown iso={t.submission_deadline} lang={lang} />
                </>
              ) : null}
            </p>
          ) : null}
          {table.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>{d.tournaments.participants}</th>
                    <th>{ru ? "Очки" : "Points"}</th>
                    <th>KDA</th>
                    <th>{ru ? "Убийства" : "Kills"}</th>
                    <th>{ru ? "Учтено / отправлено" : "Counted / logged"}</th>
                    <th>{ru ? "На проверке" : "In review"}</th>
                  </tr>
                </thead>
                <tbody>
                  {table.map((r) => (
                    <tr key={r.participantId}>
                      <td>{r.counted ? r.rank : "—"}</td>
                      <td>{r.team_slug ? <Link href={`/${lang}/teams/${r.team_slug}`}>{r.name}</Link> : r.username ? <Link href={`/${lang}/players/${r.username}`}>{r.name}</Link> : r.name}</td>
                      <td>
                        <strong>{r.points}</strong>
                      </td>
                      <td>{r.kda}</td>
                      <td>{r.kills}</td>
                      <td>
                        {r.counted} / {r.logged}
                      </td>
                      <td>{r.pending ? <Badge status="warn">{r.pending}</Badge> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">{ru ? "Таблица появится после старта турнира." : "The leaderboard appears once the tournament starts."}</p>
          )}
          {canSubmit ? (
            <div className="card form-card">
              <h3 className="h4">{ru ? "Отправить результат матча" : "Submit a match result"}</h3>
              <ActionForm action="score.submit" lang={lang} back={`${back}#leaderboard`} hidden={hidden} className="stack">
                <div className="form-grid form-grid-4">
                  {(["kills", "assists", "deaths", "headshots"] as const).map((k) => (
                    <Field key={k} label={{ kills: ru ? "Убийства" : "Kills", assists: ru ? "Помощь" : "Assists", deaths: ru ? "Смерти" : "Deaths", headshots: ru ? "В голову" : "Headshots" }[k]}>
                      <input name={k} type="number" min={0} max={999} defaultValue={0} required inputMode="numeric" />
                    </Field>
                  ))}
                  <Field label={ru ? "Урон" : "Damage"}>
                    <input name="damage" type="number" min={0} max={99999} defaultValue={0} required inputMode="numeric" />
                  </Field>
                  <Field label={ru ? "Путь, м" : "Distance, m"}>
                    <input name="distance" type="number" min={0} max={999999} defaultValue={0} required inputMode="numeric" />
                  </Field>
                  <Field label={ru ? "Место" : "Placement"}>
                    <select name="placement" defaultValue="">
                      <option value="">—</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                      <option value="3">3</option>
                    </select>
                  </Field>
                  <Field label={ru ? "ID матча в игре" : "In-game match ID"} hint={d.common.optional}>
                    <input name="matchRef" maxLength={80} />
                  </Field>
                </div>
                <Field label={d.match.evidence} hint={ru ? "Ссылка на скриншот или запись" : "Link to a screenshot or recording"}>
                  <input name="evidence" type="url" maxLength={500} placeholder="https://" />
                </Field>
                <button className="btn btn-primary">{ru ? "Отправить" : "Submit"}</button>
              </ActionForm>
            </div>
          ) : null}
          {myLines.length ? (
            <details className="disclosure">
              <summary>{ru ? "Мои отправленные результаты" : "My submitted results"}</summary>
              <ul className="list">
                {myLines.map((l) => (
                  <li key={l.id} className="row-between">
                    <span className="small">
                      K {l.kills} · A {l.assists} · D {l.deaths} · HS {l.headshots} · DMG {l.damage} · {l.distance} m
                      {l.placement ? ` · #${l.placement}` : ""}
                      {l.match_ref ? ` · ${l.match_ref}` : ""}
                    </span>
                    <Badge status={l.review === "pending" ? "warn" : l.review === "rejected" ? "bad" : "ok"}>{reviewLabel(l.review, lang)}</Badge>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : (
        <section id="bracket" className="section-tight">
          <h2 className="h3">{ffa ? (ru ? "Лобби" : "Lobbies") : rounds ? (ru ? "Туры" : "Rounds") : d.tournaments.tabs.bracket}</h2>
          {ffa ? (
            lobbyTables.length ? (
              <FfaRounds lang={lang} lobbies={lobbyTables} names={names} advance={ffaRules.advance} finished={finished} />
            ) : plannedLobbies.length ? (
              <>
                <p className="muted small">
                  {ru
                    ? `Предварительно: лобби по текущему посеву (змейка). Раундов — ${plannedRounds.length}: ${plannedRounds.map((r) => `${r.entrants} в ${r.lobbies} лобби`).join(" → ")}.`
                    : `Preview: lobbies by the current seeds (snake). Rounds — ${plannedRounds.length}: ${plannedRounds.map((r) => `${r.entrants} in ${r.lobbies} lobb${r.lobbies === 1 ? "y" : "ies"}`).join(" → ")}.`}
                </p>
                <div className="group-grid">
                  {plannedLobbies.map((g, i) => (
                    <div key={i} className="card">
                      <h3 className="h4">{plannedLobbies.length === 1 ? (ru ? "Финальное лобби" : "Final lobby") : ru ? `Лобби ${i + 1}` : `Lobby ${i + 1}`}</h3>
                      <ol>
                        {g.map((p) => (
                          <li key={p.id}>{p.name}</li>
                        ))}
                      </ol>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="muted">{d.tournaments.bracketNotYet}</p>
            )
          ) : started ? (
            <>
              <BracketView lang={lang} matches={rounds ? mainMatches : matches} format={t.format} series={seriesById} mine={entry ? [entry.id] : undefined} />
              {playoff ? (
                <div className="bracket-group">
                  <h3 className="h3">{ru ? "Плей-офф" : "Playoff"}</h3>
                  {playoffMatches.length ? (
                    <BracketView lang={lang} matches={playoffMatches} format={playoff.format} series={seriesById} mine={entry ? [entry.id] : undefined} scope="p" />
                  ) : t.stage === 2 ? (
                    <p className="muted">
                      {ru
                        ? "Плей-офф не состоялся: из основного этапа вышло меньше двух участников. Места определены по основному этапу."
                        : "No playoff was played: fewer than two entrants came through the main stage. Places follow the main stage."}
                    </p>
                  ) : (
                    <p className="muted">
                      {ru
                        ? `Плей-офф (${playoffFormatLabel(playoff.format, lang)}, ${playoff.size} участников) будет создан автоматически после последнего матча основного этапа.`
                        : `The playoff (${playoffFormatLabel(playoff.format, lang)}, ${playoff.size} entrants) is created automatically after the last main-stage match.`}
                    </p>
                  )}
                </div>
              ) : null}
            </>
          ) : plannedGroups.length ? (
            <>
              <p className="muted small">
                {ru
                  ? "Предварительно: состав групп по текущему посеву (змейка). Расписание туров появится при старте."
                  : "Preview: groups by the current seeds (snake). The round schedule appears at the start."}
                {seededList(list).length < groupMinimum
                  ? ru
                    ? ` Для старта нужно не меньше ${groupMinimum} участников.`
                    : ` At least ${groupMinimum} entrants are needed to start.`
                  : ""}
              </p>
              <div className="group-grid">
                {plannedGroups.map((g, i) => (
                  <div key={i} className="card">
                    <h3 className="h4">{groupTitle(i + 1, lang)}</h3>
                    <ol>
                      {g.map((p) => (
                        <li key={p.id}>{p.name}</li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
              {playoff ? (
                <p className="small muted">
                  {ru
                    ? `Затем плей-офф: ${playoffFormatLabel(playoff.format, lang)}, ${playoff.size} участников.`
                    : `Then a playoff: ${playoffFormatLabel(playoff.format, lang)}, ${playoff.size} entrants.`}
                </p>
              ) : null}
            </>
          ) : previewMatches.length ? (
            <>
              <p className="muted small">
                {rounds === "swiss"
                  ? ru
                    ? "Предварительно: пары первого тура по текущему посеву. Следующие туры составляются по очкам после каждого тура."
                    : "Preview: round 1 pairings by the current seeds. Later rounds are paired by points after each round."
                  : rounds === "round_robin"
                    ? ru
                      ? `Предварительное расписание по текущему посеву: всего туров — ${previewRounds}${previewRounds > PREVIEW_ROUNDS ? `, показаны первые ${PREVIEW_ROUNDS}` : ""}.`
                      : `Preview schedule by the current seeds: ${previewRounds} rounds in total${previewRounds > PREVIEW_ROUNDS ? `, the first ${PREVIEW_ROUNDS} shown` : ""}.`
                    : d.tournaments.bracketPreview}
              </p>
              <BracketView lang={lang} matches={previewMatches} linkMatches={false} format={t.format} scope="v" />
              {playoff ? (
                <p className="small muted">
                  {ru
                    ? `После основного этапа — плей-офф: ${playoffFormatLabel(playoff.format, lang)}, ${playoff.size} лучших по таблице.`
                    : `After the main stage, a playoff: ${playoffFormatLabel(playoff.format, lang)} for the top ${playoff.size} of the table.`}
                </p>
              ) : null}
            </>
          ) : (
            <p className="muted">{d.tournaments.bracketNotYet}</p>
          )}
        </section>
      )}

      <section id="standings" className="section-tight">
        <h2 className="h3">{d.tournaments.tabs.standings}</h2>
        {playoff && finished && standings.length ? (
          <>
            <ol className="standings">
              {standings.map((p) => (
                <li key={p.id} className={p.placement === 1 ? "is-first" : undefined}>
                  <span className="place">{p.placement}</span>
                  <span>{p.name}</span>
                </li>
              ))}
            </ol>
            <p className="small muted">
              {ru
                ? "Места: сначала плей-офф, затем остальные по основному этапу."
                : "Places: the playoff first, then everyone else by the main stage."}
            </p>
            {groupTables.length || roundTable.length ? (
              <details className="disclosure">
                <summary>{ru ? "Таблица основного этапа" : "Main-stage table"}</summary>
                <MainTables />
              </details>
            ) : null}
          </>
        ) : rounds && (roundTable.length || groupTables.length) ? (
          <>
            {!finished ? (
              <p className="small muted">
                {playoff
                  ? t.stage === 2
                    ? ru
                      ? "Основной этап завершён: таблица окончательная. Итоговые места определит плей-офф."
                      : "The main stage is over: the table is final. The playoff decides the final places."
                    : ru
                      ? "Промежуточная таблица: выделены места, которые сейчас выходят в плей-офф."
                      : "Provisional table: highlighted places currently advance to the playoff."
                  : ru
                    ? "Промежуточная таблица: места фиксируются после последнего тура."
                    : "Provisional table: places are fixed after the last round."}
              </p>
            ) : null}
            <MainTables />
          </>
        ) : standings.length ? (
          <ol className="standings">
            {standings.map((p) => (
              <li key={p.id} className={p.placement === 1 ? "is-first" : undefined}>
                <span className="place">{p.placement}</span>
                <span>{p.name}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">{d.tournaments.standingsNotYet}</p>
        )}
        {finished && rating ? (
          <div className="card stack-sm feedback-card">
            <p className="field-label">{ru ? "Оценка участников" : "Participants' rating"}</p>
            {rating.count ? (
              <p>
                <strong className="big-number">{rating.average?.toLocaleString(ru ? "ru-RU" : "en-US")}</strong> <span className="muted">/ 5 · {rating.count} {ru ? ruPlural(rating.count, "оценка", "оценки", "оценок") : rating.count === 1 ? "rating" : "ratings"}</span>
              </p>
            ) : (
              <p className="muted small">{ru ? "Оценок пока нет." : "No ratings yet."}</p>
            )}
            {rateable ? (
              <ActionForm action="tournament.rate" lang={lang} back={`${back}#standings`} hidden={hidden} className="stack-sm">
                <Field label={ru ? "Ваша оценка" : "Your rating"}>
                  <select name="rating" defaultValue={myRating ? String(myRating.rating) : "5"}>
                    {[5, 4, 3, 2, 1].map((n) => (
                      <option key={n} value={n}>
                        {"★".repeat(n)}
                        {"☆".repeat(5 - n)} · {n}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={ru ? "Комментарий для организатора" : "Comment for the organiser"} hint={ru ? "Необязательно; виден только организаторам турнира" : "Optional; seen by the tournament's organisers only"}>
                  <textarea name="comment" rows={2} maxLength={500} defaultValue={myRating?.comment ?? ""} />
                </Field>
                <button className="btn btn-ghost btn-sm">{myRating ? (ru ? "Обновить оценку" : "Update rating") : ru ? "Оценить" : "Rate"}</button>
              </ActionForm>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
