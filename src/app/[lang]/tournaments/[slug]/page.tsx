import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale, type Locale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { countryName } from "@/lib/countries.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { bracket, getTournament, participants, type BracketMatch, type Participant } from "@/server/queries.ts";
import { canManageTournament } from "@/server/tournaments.ts";
import { planSingleElimination } from "@/server/bracket.ts";
import { planDoubleElimination } from "@/server/double.ts";
import { leaderboardStandings, scoreLog } from "@/server/leaderboard.ts";
import { DEFAULT_WEIGHTS, mergeWeights, WEIGHT_KEYS } from "@/server/scoring.ts";
import { tournamentSponsors } from "@/server/sponsors.ts";
import { mediaUrl } from "@/server/media.ts";
import type { Database } from "@/server/db.ts";
import type { SessionUser } from "@/server/auth.ts";
import { ActionForm, Badge, DbDown, Empty, Field, Flash, SignInPrompt, type SearchParams } from "@/components/ui";
import { BracketView, formatLabel } from "@/components/tournament";
import { Countdown, LocalTime } from "@/components/time";
import { reviewLabel } from "@/lib/labels.ts";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  const { db } = await viewer();
  const t = db ? await getTournament(db, slug).catch(() => null) : null;
  if (!t || t.status === "DRAFT") return pageMeta(lang, `tournaments/${slug}`, dict(lang).tournaments.title, undefined, { noindex: true });
  return pageMeta(lang, `tournaments/${slug}`, t.name, `${gameBySlug(t.game)?.name ?? t.game} · ${formatLabel(t.format, lang)} · ${t.org_name}`);
}

async function myEntry(db: Database, tournamentId: string, user: SessionUser) {
  const [reg] = await db.query<{ id: string; status: string; checked_in_at: Date | null; leader: boolean; team_name: string | null }>(
    `select r.id, r.status, r.checked_in_at, tm.name as team_name,
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

function preview(list: Participant[], format: string): BracketMatch[] {
  const seeded = list
    .filter((p) => p.status === "registered")
    .sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9) || new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  if (seeded.length < 2) return [];
  const base = (m: { round: number; position: number; a: Participant | null; b: Participant | null }, bracketKey: "W" | "L" | "GF", aVoid = false, bVoid = false) => ({
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
  const [list, matches, sponsorsList] = await Promise.all([participants(db, t.id), leaderboard ? Promise.resolve([]) : bracket(db, t.id), tournamentSponsors(db, t.id)]);
  const entry = user ? await myEntry(db, t.id, user) : null;
  const teams = user && !entry && t.participant_type === "team" && t.status === "REGISTRATION_OPEN" ? await eligibleTeams(db, user, t.game, t.team_size) : [];
  const game = gameBySlug(t.game);
  const back = `/${lang}/tournaments/${t.slug}`;
  const started = matches.length > 0;
  const previewMatches = !started && !leaderboard ? preview(list, t.format) : [];
  const standings = t.status === "COMPLETED" ? list.filter((p) => p.placement !== null).sort((a, b) => (a.placement ?? 0) - (b.placement ?? 0)) : [];
  const full = t.registered >= t.max_participants;
  const hidden = { tournament: t.id };
  const table = leaderboard && ["IN_PROGRESS", "PAUSED", "COMPLETED", "ARCHIVED"].includes(t.status) ? await leaderboardStandings(db, t) : [];
  const weights = mergeWeights(t.scoring);
  const deadlinePassed = Boolean(t.submission_deadline && new Date(t.submission_deadline).getTime() < Date.now());
  const canSubmit = leaderboard && entry?.leader && entry.status === "registered" && t.status === "IN_PROGRESS" && !deadlinePassed;
  const myLines = leaderboard && entry ? await scoreLog(db, t.id, { registrationId: entry.id }) : [];
  const [myCountry] = user && t.region_lock.length ? await db.query<{ country_code: string | null }>("select country_code from users where id = $1", [user.id]) : [];
  const tabs = leaderboard ? (["overview", "rules", "participants", "leaderboard", "standings"] as const) : (["overview", "rules", "participants", "bracket", "standings"] as const);

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
        {entry ? (
          <div className="stack">
            <p>
              {d.tournaments.yourStatus}: <Badge status={entry.status}>{d.statuses.registration[entry.status]}</Badge>
              {entry.team_name ? ` · ${entry.team_name}` : ""}
              {entry.checked_in_at ? (
                <>
                  {" "}
                  · <Badge status="confirmed">{d.tournaments.checkedIn}</Badge>
                </>
              ) : null}
            </p>
            <div className="row">
              {entry.leader && entry.status === "registered" && !entry.checked_in_at && t.check_in_open ? (
                <ActionForm action="tournament.checkin" lang={lang} back={back} hidden={hidden}>
                  <button className="btn btn-primary btn-sm">{d.tournaments.checkInNow}</button>
                </ActionForm>
              ) : null}
              {entry.leader && ["registered", "waitlisted"].includes(entry.status) && ["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(t.status) ? (
                <ActionForm action="tournament.withdraw" lang={lang} back={back} hidden={hidden}>
                  <button className="btn btn-ghost btn-sm">{d.tournaments.withdraw}</button>
                </ActionForm>
              ) : null}
            </div>
          </div>
        ) : t.status !== "REGISTRATION_OPEN" ? (
          <p className="muted">{d.tournaments.registrationClosed}</p>
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
            {full ? <p className="muted small">{d.tournaments.waitlistNote}</p> : null}
            <button className="btn btn-primary">{d.tournaments.register}</button>
          </ActionForm>
        ) : teams.length ? (
          <ActionForm action="tournament.register" lang={lang} back={back} hidden={hidden} className="stack">
            {full ? <p className="muted small">{d.tournaments.waitlistNote}</p> : null}
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
            <button className="btn btn-primary">{d.tournaments.registerTeam}</button>
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
            {k === "leaderboard" ? (ru ? "Таблица" : "Leaderboard") : d.tournaments.tabs[k as keyof typeof d.tournaments.tabs]}
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
                {list.map((p) => (
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
          <h2 className="h3">{d.tournaments.tabs.bracket}</h2>
          {started ? (
            <BracketView lang={lang} matches={matches} format={t.format} />
          ) : previewMatches.length ? (
            <>
              <p className="muted small">{d.tournaments.bracketPreview}</p>
              <BracketView lang={lang} matches={previewMatches} linkMatches={false} format={t.format} />
            </>
          ) : (
            <p className="muted">{d.tournaments.bracketNotYet}</p>
          )}
        </section>
      )}

      <section id="standings" className="section-tight">
        <h2 className="h3">{d.tournaments.tabs.standings}</h2>
        {standings.length ? (
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
      </section>
    </div>
  );
}
