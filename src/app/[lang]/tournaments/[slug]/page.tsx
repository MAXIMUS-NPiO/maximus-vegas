import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { bracket, getTournament, participants, type BracketMatch, type Participant } from "@/server/queries.ts";
import { canManageOrg } from "@/server/access.ts";
import { planSingleElimination } from "@/server/bracket.ts";
import type { Database } from "@/server/db.ts";
import type { SessionUser } from "@/server/auth.ts";
import { ActionForm, Badge, DbDown, Empty, Flash, SignInPrompt, type SearchParams } from "@/components/ui";
import { BracketView } from "@/components/tournament";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  const { db } = await viewer();
  const t = db ? await getTournament(db, slug).catch(() => null) : null;
  if (!t || t.status === "DRAFT") return pageMeta(lang, `tournaments/${slug}`, dict(lang).tournaments.title, undefined, { noindex: true });
  return pageMeta(lang, `tournaments/${slug}`, t.name, `${gameBySlug(t.game)?.name ?? t.game} · ${t.org_name}`);
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

function preview(list: Participant[]): BracketMatch[] {
  const seeded = list
    .filter((p) => p.status === "registered")
    .sort((a, b) => (a.seed ?? 1e9) - (b.seed ?? 1e9) || new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  if (seeded.length < 2) return [];
  const plan = planSingleElimination(seeded);
  return plan.matches.map((m) => ({
    id: `p-${m.round}-${m.position}`,
    round: m.round,
    position: m.position,
    status: "pending",
    outcome: m.round === 1 && Boolean(m.a) !== Boolean(m.b) ? "bye" : null,
    a_reg: m.a?.id ?? null,
    b_reg: m.b?.id ?? null,
    a_name: m.a?.name ?? null,
    b_name: m.b?.name ?? null,
    winner_reg: null,
    score_a: null,
    score_b: null,
    scheduled_at: null,
  })) as BracketMatch[];
}

export default async function TournamentPage({ params, searchParams }: { params: Promise<{ lang: string; slug: string }>; searchParams: SearchParams }) {
  const { lang, slug } = await params;
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
  const t = await getTournament(db, slug);
  if (!t) notFound();
  const manager = await canManageOrg(db, t.org_id, user);
  if (t.status === "DRAFT" && !manager) notFound();
  const [list, matches] = await Promise.all([participants(db, t.id), bracket(db, t.id)]);
  const entry = user ? await myEntry(db, t.id, user) : null;
  const teams = user && !entry && t.participant_type === "team" && t.status === "REGISTRATION_OPEN" ? await eligibleTeams(db, user, t.game, t.team_size) : [];
  const game = gameBySlug(t.game);
  const back = `/${lang}/tournaments/${t.slug}`;
  const started = matches.length > 0;
  const previewMatches = !started ? preview(list) : [];
  const standings = t.status === "COMPLETED" ? list.filter((p) => p.placement !== null).sort((a, b) => (a.placement ?? 0) - (b.placement ?? 0)) : [];
  const full = t.registered >= t.max_participants;
  const hidden = { tournament: t.id };

  return (
    <div className="container page">
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
            <dd>{d.tournaments.formatSingle}</dd>
          </div>
          {t.region ? (
            <div>
              <dt>{d.tournaments.region}</dt>
              <dd>{t.region}</dd>
            </div>
          ) : null}
          <div>
            <dt>{d.tournaments.organizer}</dt>
            <dd>{t.org_name}</dd>
          </div>
        </dl>
        {manager ? (
          <Link href={`/${lang}/organizer/t/${t.slug}`} className="btn btn-ghost btn-sm">
            {d.tournaments.manage}
          </Link>
        ) : null}
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
        {(["overview", "rules", "participants", "bracket", "standings"] as const).map((k) => (
          <a key={k} href={`#${k}`}>
            {d.tournaments.tabs[k]}
          </a>
        ))}
      </nav>

      <section id="overview" className="section-tight">
        <h2 className="h3">{d.tournaments.tabs.overview}</h2>
        {t.description ? <p className="prewrap">{t.description}</p> : <p className="muted">—</p>}
      </section>

      <section id="rules" className="section-tight">
        <h2 className="h3">{d.tournaments.tabs.rules}</h2>
        {t.rules ? <p className="prewrap">{t.rules}</p> : <p className="muted">{d.tournaments.noRules}</p>}
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

      <section id="bracket" className="section-tight">
        <h2 className="h3">{d.tournaments.tabs.bracket}</h2>
        {started ? (
          <BracketView lang={lang} matches={matches} />
        ) : previewMatches.length ? (
          <>
            <p className="muted small">{d.tournaments.bracketPreview}</p>
            <BracketView lang={lang} matches={previewMatches} linkMatches={false} />
          </>
        ) : (
          <p className="muted">{d.tournaments.bracketNotYet}</p>
        )}
      </section>

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
