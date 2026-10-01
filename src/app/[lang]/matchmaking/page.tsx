import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, type Locale } from "@/lib/i18n.ts";
import { GAMES, gameBySlug, isGame } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { quickText } from "@/lib/quick-text.ts";
import { viewer } from "@/server/viewer.ts";
import { challengesFor } from "@/server/challenges.ts";
import { partyView, pulseQueue, queueView, type PartyView, type QueueView } from "@/server/quickmatch.ts";
import { ratingsFor, type RatingRow } from "@/server/rating.ts";
import { MAX_PARTY } from "@/server/matchmaking-rules.ts";
import { ActionForm, Badge, DbDown, Field, Flash, PageHead, SignInPrompt, type SearchParams } from "@/components/ui";
import { ChallengeList } from "@/components/challenges";
import { LocalTime } from "@/components/time";
import { AutoRefresh, SecondsLeft } from "@/components/auto-refresh";
import { FeatureNotice } from "@/components/feature-notice";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(
    lang,
    "matchmaking",
    lang === "ru" ? "Быстрый матч" : "Quick match",
    lang === "ru"
      ? "Соперник из реальной очереди по вашей игре — один или группой. Без ставок."
      : "An opponent from the real queue for your game — alone or as a party. No stakes.",
  );
}

export default async function QuickMatch({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const x = quickText[lang];
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  const requestedGame = typeof sp.game === "string" && isGame(sp.game) ? sp.game : undefined;
  const back = `/${lang}/matchmaking${requestedGame ? `?game=${requestedGame}` : ""}`;
  return (
    <div className="container page">
      <PageHead eyebrow={lang === "ru" ? "ИГРАТЬ" : "PLAY"} title={lang === "ru" ? "Быстрый матч" : "Quick match"} lead={x.lead}>
        <Link href={`/${lang}/challenges`} className="btn btn-ghost btn-sm">
          {x.challengeSomeone}
        </Link>
      </PageHead>
      <Flash lang={lang} params={sp} />
      <FeatureNotice db={db} lang={lang} feature="quick_match" />
      {dbError || !db ? (
        <DbDown lang={lang} />
      ) : !user ? (
        <SignInPrompt lang={lang} back={back} />
      ) : (
        <QuickMatchBody lang={lang} userId={user.id} username={user.username} back={back} selectedGame={requestedGame} />
      )}
    </div>
  );
}

async function QuickMatchBody({
  lang,
  userId,
  username,
  back,
  selectedGame,
}: {
  lang: Locale;
  userId: string;
  username: string;
  back: string;
  selectedGame?: string;
}) {
  const x = quickText[lang];
  const { db } = await viewer();
  // While the player waits, each view moves the queue on: overdue ready checks end, widened windows pair.
  const [queued] = await db!.query<{ game: string }>(
    "select game from quick_queue where user_id = $1 union select p.game from party_members m join parties p on p.id = m.party_id where m.user_id = $1",
    [userId],
  );
  if (queued) await pulseQueue(db!, queued.game);
  const [state, party, ratings, list] = await Promise.all([
    queueView(db!, userId),
    partyView(db!, userId),
    ratingsFor(db!, userId),
    challengesFor(db!, userId),
  ]);
  const quick = list.filter((c) => c.kind === "quick");
  const live = Boolean(state.mine || state.check);
  return (
    <div className="stack">
      {live ? <AutoRefresh seconds={5} /> : null}
      {state.cooldownUntil ? (
        <p className="notice notice-warn">
          <span>
            {x.cooldown} <LocalTime iso={state.cooldownUntil} lang={lang} />: {x.cooldownWhy}
          </span>
        </p>
      ) : null}
      {state.last && !state.check && (state.last.outcome !== "returned" || state.mine) ? <p className="notice">{x.last[state.last.outcome]}</p> : null}
      <div className="quick-grid">
        <div className="stack">
          {state.check ? (
            <ReadyCheck lang={lang} check={state.check} back={back} />
          ) : state.mine ? (
            <QueueCard lang={lang} mine={state.mine} back={back} />
          ) : (
            <SearchForm lang={lang} state={state} party={party} userId={userId} selectedGame={selectedGame} back={back} />
          )}
          <Ratings lang={lang} ratings={ratings} username={username} />
        </div>
        <PartyPanel lang={lang} view={party} userId={userId} back={back} selectedGame={selectedGame} queued={live} />
      </div>
      <section>
        <h2 className="h3">{x.myMatches}</h2>
        <p className="small muted">{x.resultNote}</p>
        <ChallengeList lang={lang} list={quick} userId={userId} back={back} />
      </section>
    </div>
  );
}

const minutes = (seconds: number) => Math.floor(seconds / 60);

function ReadyCheck({ lang, check, back }: { lang: Locale; check: NonNullable<QueueView["check"]>; back: string }) {
  const x = quickText[lang];
  const r = check.reasons;
  const hidden = { check: check.id };
  return (
    <section className="card stack-sm ready-check" aria-live="polite">
      <div className="row-between">
        <p className="field-label">{x.checkTitle}</p>
        <SecondsLeft iso={check.expiresAt} lang={lang} />
      </div>
      <p className="small">
        {gameBySlug(check.game)?.name ?? check.game} · {x.size}: {check.size} {x.vs} {check.size}
      </p>
      <div className="ready-sides">
        <div>
          <p className="small muted">{x.yourSide}</p>
          <ul className="ready-list">
            {check.own.map((p) => (
              <li key={p.username}>
                <span>{p.displayName}</span>{" "}
                <Badge status={p.answer === "ready" ? "ok" : p.answer === "declined" ? "bad" : "warn"}>{x.answers[p.answer ?? "none"]}</Badge>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="small muted">{x.opponents}</p>
          <p>
            {x.readyOf} {check.other.ready} {x.of} {check.other.total}
          </p>
        </div>
      </div>
      {check.myAnswer === "ready" ? (
        <p className="small">{x.youReady}</p>
      ) : (
        <div className="row">
          <ActionForm action="quick.ready" lang={lang} back={back} hidden={hidden}>
            <button className="btn btn-primary">{x.ready}</button>
          </ActionForm>
          <ActionForm action="quick.decline" lang={lang} back={back} hidden={hidden}>
            <button className="btn btn-ghost btn-sm">{x.decline}</button>
          </ActionForm>
        </div>
      )}
      <details className="disclosure">
        <summary>{x.why}</summary>
        <ul className="small reasons">
          <li>
            {x.size}: {r.size} {x.vs} {r.size}
          </li>
          <li>
            {x.gap}: {r.gap} ({r.window === null ? x.anyAfter : `${x.allowed} ${r.window}`})
          </li>
          <li>{r.region === "same" ? x.regionSame : r.region === "relaxed" ? x.regionRelaxed : x.regionAny}</li>
          <li>
            {x.waitedLong}: {minutes(r.waitedSeconds)} {x.min} {r.waitedSeconds % 60} {x.sec}
          </li>
        </ul>
      </details>
      <p className="small muted">{x.declineNote}</p>
    </section>
  );
}

function QueueCard({ lang, mine, back }: { lang: Locale; mine: NonNullable<QueueView["mine"]>; back: string }) {
  const x = quickText[lang];
  return (
    <section className="card stack-sm">
      <p className="field-label">{mine.party ? x.queuedParty : x.queued}</p>
      <p>
        {gameBySlug(mine.game)?.name ?? mine.game}
        {mine.region ? ` · ${mine.region}` : ""} · {x.waited} {minutes(mine.waitedSeconds)} {x.min}
      </p>
      <p className="small muted">{mine.window === null ? x.anyGap : `${x.window}: ${mine.window}`}</p>
      <p className="small">{x.keepOpen}</p>
      <ActionForm action="quick.leave" lang={lang} back={back}>
        <button className="btn btn-ghost btn-sm">{x.cancel}</button>
      </ActionForm>
    </section>
  );
}

function SearchForm({
  lang,
  state,
  party,
  userId,
  selectedGame,
  back,
}: {
  lang: Locale;
  state: QueueView;
  party: PartyView;
  userId: string;
  selectedGame?: string;
  back: string;
}) {
  const x = quickText[lang];
  const p = party.party;
  if (p && p.leaderId !== userId)
    return (
      <section className="card">
        <p className="field-label">{x.search}</p>
        <p className="small muted">{x.leaderStarts}</p>
      </section>
    );
  return (
    <ActionForm action="quick.join" lang={lang} back={back} className="card form-card">
      <p className="field-label">{x.search}</p>
      {p ? (
        <>
          <input type="hidden" name="game" value={p.game} />
          <p>
            {gameBySlug(p.game)?.name ?? p.game} · {p.members.length} {x.vs} {p.members.length}
            {state.waiting[p.game] ? ` · ${x.waiting}: ${state.waiting[p.game]}` : ""}
          </p>
        </>
      ) : (
        <Field label={x.game}>
          <select name="game" required defaultValue={selectedGame}>
            {GAMES.filter((g) => !g.legacy).map((g) => (
              <option key={g.slug} value={g.slug}>
                {g.name}
                {state.waiting[g.slug] ? ` · ${x.waiting}: ${state.waiting[g.slug]}` : ""}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={x.region} hint={x.regionHint}>
        <input name="region" maxLength={40} placeholder="MENA, EU…" />
      </Field>
      <button className="btn btn-primary" disabled={Boolean(state.cooldownUntil) || Boolean(p && p.members.length < 2)}>
        {p ? x.findParty : x.find}
      </button>
    </ActionForm>
  );
}

function PartyPanel({
  lang,
  view,
  userId,
  back,
  selectedGame,
  queued,
}: {
  lang: Locale;
  view: PartyView;
  userId: string;
  back: string;
  selectedGame?: string;
  /** A solo player in the queue or a ready check: a party is created after the search ends. */
  queued: boolean;
}) {
  const x = quickText[lang];
  const p = view.party;
  const leader = p?.leaderId === userId;
  return (
    <section className="card stack-sm party-panel" aria-label={x.party}>
      <p className="field-label">{x.party}</p>
      {p ? (
        <>
          <p className="small muted">
            {gameBySlug(p.game)?.name ?? p.game} · {x.players}: {p.members.length} / {MAX_PARTY}
          </p>
          <ul className="party-members">
            {p.members.map((m) => (
              <li key={m.id}>
                <span className="grow">
                  <Link href={`/${lang}/players/${m.username}`}>{m.displayName}</Link> <span className="small muted">@{m.username}</span>{" "}
                  {m.id === p.leaderId ? <Badge status="info">{x.leader}</Badge> : null}
                </span>
                <span className="small muted">
                  {x.rating} {m.rating}
                </span>
                {leader && m.id !== userId && !p.queued ? (
                  <ActionForm action="party.remove" lang={lang} back={back} hidden={{ member: m.id }}>
                    <button className="btn btn-ghost btn-xs">{x.remove}</button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
          {p.invites.length ? (
            <div className="stack-sm">
              <p className="small muted">{x.invited}</p>
              <ul className="party-members">
                {p.invites.map((i) => (
                  <li key={i.id}>
                    <span className="grow small">
                      {i.displayName} <span className="muted">@{i.username}</span>
                    </span>
                    {leader ? (
                      <ActionForm action="party.revoke" lang={lang} back={back} hidden={{ invite: i.id }}>
                        <button className="btn btn-ghost btn-xs">{x.revoke}</button>
                      </ActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {p.queued ? (
            <p className="small muted">{x.frozen}</p>
          ) : leader && p.members.length + p.invites.length < MAX_PARTY ? (
            <ActionForm action="party.invite" lang={lang} back={back} className="inline-form">
              <input name="username" required minLength={3} maxLength={24} placeholder={x.inviteLabel} aria-label={x.inviteLabel} />
              <button className="btn btn-primary btn-sm">{x.invite}</button>
            </ActionForm>
          ) : null}
          {p.held ? null : (
            <ActionForm action="party.leave" lang={lang} back={back}>
              <button className="btn btn-ghost btn-sm">{leader ? x.disband : x.leave}</button>
            </ActionForm>
          )}
        </>
      ) : (
        <>
          <p className="small muted">{x.partyLead}</p>
          {queued ? (
            <p className="small muted">{x.partyAfterSearch}</p>
          ) : (
            <ActionForm action="party.create" lang={lang} back={back} className="inline-form">
              <select name="game" required defaultValue={selectedGame} aria-label={x.game}>
                {GAMES.filter((g) => !g.legacy).map((g) => (
                  <option key={g.slug} value={g.slug}>
                    {g.name}
                  </option>
                ))}
              </select>
              <button className="btn btn-ghost btn-sm">{x.createParty}</button>
            </ActionForm>
          )}
        </>
      )}
      {view.incoming.length ? (
        <div className="stack-sm">
          <p className="small muted">{x.incoming}</p>
          <ul className="party-members">
            {view.incoming.map((i) => (
              <li key={i.id}>
                <span className="grow small">
                  {i.byName} <span className="muted">@{i.by}</span> · {gameBySlug(i.game)?.name ?? i.game} · {x.players}: {i.size}
                </span>
                <ActionForm action="party.respond" lang={lang} back={back} hidden={{ invite: i.id, accept: "1" }}>
                  <button className="btn btn-primary btn-xs">{x.accept}</button>
                </ActionForm>
                <ActionForm action="party.respond" lang={lang} back={back} hidden={{ invite: i.id, accept: "0" }}>
                  <button className="btn btn-ghost btn-xs">{x.declineInvite}</button>
                </ActionForm>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Ratings({ lang, ratings, username }: { lang: Locale; ratings: RatingRow[]; username: string }) {
  const x = quickText[lang];
  return (
    <section className="card stack-sm">
      <p className="field-label">{x.ratings}</p>
      {ratings.length ? (
        <ul className="ratings-list">
          {ratings.map((r) => (
            <li key={r.game}>
              <span className="grow">{gameBySlug(r.game)?.name ?? r.game}</span>
              <strong className="rating-value">{r.rating}</strong>
              <span className="small muted">
                {x.matches}: {r.matches} · {r.wins}–{r.losses} · {x.peak}: {r.peak}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">{x.noRatings}</p>
      )}
      <p className="small muted">{x.ratingsNote}</p>
      <Link href={`/${lang}/players/${username}#rating`} className="text-link small">
        {x.history}
      </Link>
    </section>
  );
}
