import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { participants } from "@/server/queries.ts";
import { canRefereeTournament, regLeaders } from "@/server/tournaments.ts";
import { lobbyDetail } from "@/server/lobbies.ts";
import { ffaSettingsOf, placementPoints } from "@/server/ffa.ts";
import { ActionForm, Badge, DbDown, Field, Flash, type SearchParams } from "@/components/ui";
import { LocalDateTimeInput, LocalTime, TimeZoneField } from "@/components/time";
import { LobbyTableView, lobbyTitle, type StandingName } from "@/components/tournament";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; id: string }> }): Promise<Metadata> {
  const { lang, id } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, `lobbies/${id}`, lang === "ru" ? "Лобби FFA" : "FFA lobby", undefined, { noindex: true });
}

export default async function LobbyPage({ params, searchParams }: { params: Promise<{ lang: string; id: string }>; searchParams: SearchParams }) {
  const { lang, id } = await params;
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
  const data = await lobbyDetail(db, id);
  if (!data || data.lobby.t_status === "DRAFT") notFound();
  const { lobby, games, disputes, rows } = data;
  const settings = ffaSettingsOf({ format_settings: lobby.t_settings });
  const referee = await canRefereeTournament(db, { id: lobby.tournament_id, org_id: lobby.org_id }, user);
  const list = await participants(db, lobby.tournament_id);
  const names = new Map<string, StandingName>(list.map((p) => [p.id, { name: p.name, username: p.username, team_slug: p.team_slug }]));
  // Entrants of this lobby the viewer leads (they see the lobby code and may dispute a game).
  const mine: string[] = [];
  if (user) for (const r of rows) if ((await regLeaders(db, r.id)).includes(user.id)) mine.push(r.id);
  const member = user ? list.some((p) => rows.some((r) => r.id === p.id) && p.roster.includes(user.username)) : false;
  const seesCode = referee || mine.length > 0 || member;
  const latest = lobby.round === lobby.rounds;
  const live = lobby.t_status === "IN_PROGRESS";
  const correctable = latest && ["IN_PROGRESS", "PAUSED", "COMPLETED"].includes(lobby.t_status);
  const back = `/${lang}/lobbies/${lobby.id}`;
  const ordered = [...rows].sort((a, b) => a.seed - b.seed);
  const openDisputes = disputes.filter((x) => x.status === "open");

  const resultForm = (gameId: string, existing: Array<{ registration_id: string; placement: number; kills: number }>, correction: boolean) => (
    <ActionForm action="lobby.result" lang={lang} back={back} hidden={correction ? { game: gameId, correction: "1" } : { game: gameId }} className="stack-sm">
      <div className="result-grid">
        <span className="field-label">{ru ? "Участник" : "Entrant"}</span>
        <span className="field-label">{ru ? "Место" : "Place"}</span>
        <span className="field-label">{ru ? "Убийства" : "Kills"}</span>
        {ordered.map((r) => {
          const line = existing.find((l) => l.registration_id === r.id);
          const label = names.get(r.id)?.name ?? "—";
          return (
            <div key={r.id} style={{ display: "contents" }}>
              <span className={r.disqualified ? "muted" : undefined}>{label}</span>
              <input name={`place_${r.id}`} type="number" min={1} max={256} defaultValue={line?.placement ?? ""} inputMode="numeric" aria-label={`${ru ? "Место" : "Place"}: ${label}`} />
              <input name={`kills_${r.id}`} type="number" min={0} max={999} defaultValue={line?.kills ?? ""} inputMode="numeric" aria-label={`${ru ? "Убийства" : "Kills"}: ${label}`} />
            </div>
          );
        })}
      </div>
      <p className="small muted">
        {ru
          ? "Места сыгравших — 1, 2, 3 … без пропусков; пустое место — не играл (0 очков)."
          : "Places of those who played are 1, 2, 3 … with no gaps; an empty place means did not play (0 points)."}
      </p>
      <Field label={d.match.evidence} hint={d.common.optional}>
        <input name="evidence" type="url" maxLength={500} placeholder="https://" />
      </Field>
      {correction ? (
        <Field label={d.match.correctReason}>
          <textarea name="note" required minLength={5} rows={2} maxLength={1000} />
        </Field>
      ) : null}
      <button className={correction ? "btn btn-danger btn-sm" : "btn btn-primary btn-sm"}>{correction ? d.match.correct : ru ? "Записать результат" : "Record result"}</button>
    </ActionForm>
  );

  return (
    <div className="container page">
      <p className="eyebrow">
        <Link href={`/${lang}/tournaments/${lobby.t_slug}`}>{lobby.t_name}</Link> · FFA
      </p>
      <div className="row-between">
        <h1>{lobbyTitle(lobby.round, lobby.lobby_no, lobby.lobbies, lang)}</h1>
        <Badge status={lobby.status === "completed" ? "completed" : "in_progress"}>
          {lobby.status === "completed" ? (ru ? "Игры сыграны" : "Games played") : ru ? "Идёт" : "Under way"}
        </Badge>
      </div>
      <Flash lang={lang} params={sp} />

      <div className="grid grid-3 facts">
        <div className="card">
          <p className="field-label">{ru ? "Начало" : "Start"}</p>
          <p>{lobby.scheduled_at ? <LocalTime iso={lobby.scheduled_at} lang={lang} /> : <span className="muted">{d.match.notScheduled}</span>}</p>
          <p className="small muted">{d.common.timeNote}</p>
        </div>
        <div className="card">
          <p className="field-label">{ru ? "Код лобби" : "Lobby code"}</p>
          {seesCode ? (
            lobby.room_code ? (
              <p className="mono">{lobby.room_code}</p>
            ) : (
              <p className="muted small">{ru ? "Судья ещё не передал код." : "The referee has not shared the code yet."}</p>
            )
          ) : (
            <p className="muted small">{ru ? "Виден участникам лобби и судьям." : "Visible to the lobby's entrants and referees."}</p>
          )}
        </div>
        <div className="card">
          <p className="field-label">{ru ? "Игры" : "Games"}</p>
          <p>
            {games.filter((g) => g.status === "completed").length} / {games.length}
          </p>
          <p className="small muted">
            {lobby.lobbies > 1
              ? ru
                ? `В раунд ${lobby.round + 1} выходят лучшие ${settings.advance} (никогда не всё лобби).`
                : `The best ${settings.advance} advance to round ${lobby.round + 1} (never the whole lobby).`
              : ru
                ? "Финальное лобби: его таблица определяет итоговые места."
                : "Final lobby: its table decides the final places."}
          </p>
        </div>
      </div>

      {referee && lobby.status === "open" && live ? (
        <section className="card action-card referee">
          <h2 className="h4">{ru ? "Код и время лобби" : "Lobby code and time"}</h2>
          <ActionForm action="lobby.details" lang={lang} back={back} hidden={{ lobby: lobby.id }} className="inline-form">
            <TimeZoneField />
            <input name="roomCode" maxLength={80} defaultValue={lobby.room_code} placeholder={d.match.setRoom} aria-label={d.match.setRoom} />
            <LocalDateTimeInput name="scheduledAt" iso={lobby.scheduled_at ? new Date(lobby.scheduled_at).toISOString() : null} />
            <button className="btn btn-ghost btn-sm">{d.match.save}</button>
          </ActionForm>
        </section>
      ) : null}

      <section className="section-tight">
        <h2 className="h3">{ru ? "Таблица лобби" : "Lobby table"}</h2>
        <LobbyTableView lang={lang} rows={rows} names={names} advance={lobby.lobbies > 1 ? settings.advance : 0} final={lobby.lobbies === 1 && lobby.t_status === "COMPLETED"} />
      </section>

      <section className="section-tight">
        <h2 className="h3">{ru ? "Игры" : "Games"}</h2>
        <div className="stack">
          {games.map((g) => {
            const disputesOfGame = disputes.filter((x) => x.game_id === g.id);
            return (
              <article key={g.id} className="card stack-sm">
                <div className="row-between">
                  <h3 className="h4">{ru ? `Игра ${g.game_no}` : `Game ${g.game_no}`}</h3>
                  <Badge status={g.status === "completed" ? "completed" : "pending"}>
                    {g.status === "completed" ? (ru ? `Результат, версия ${g.version}` : `Result, version ${g.version}`) : ru ? "Ожидается" : "Pending"}
                  </Badge>
                </div>
                {g.lines.length ? (
                  <div className="table-wrap">
                    <table className="table table-compact">
                      <thead>
                        <tr>
                          <th>{ru ? "Место" : "Place"}</th>
                          <th>{ru ? "Участник" : "Entrant"}</th>
                          <th className="num">{ru ? "Убийства" : "Kills"}</th>
                          <th className="num">{ru ? "Очки" : "Pts"}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.lines.map((l) => (
                          <tr key={l.registration_id}>
                            <td>{l.placement}</td>
                            <td>{names.get(l.registration_id)?.name ?? "—"}</td>
                            <td className="num">{l.kills}</td>
                            <td className="num">{placementPoints(settings.placementPoints, l.placement) + l.kills * settings.killPoints}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
                {g.evidence_url ? (
                  <a href={g.evidence_url} target="_blank" rel="noopener noreferrer nofollow" className="text-link small">
                    {ru ? "Доказательство" : "Evidence"} ↗
                  </a>
                ) : null}
                {disputesOfGame.length ? (
                  <ul className="list">
                    {disputesOfGame.map((x) => (
                      <li key={x.id} className="stack-sm">
                        <span>
                          <Badge status={x.status === "open" ? "open" : "resolved"}>
                            {x.status === "open" ? (ru ? "Спор открыт" : "Dispute open") : x.decision === "corrected" ? (ru ? "Исправлено" : "Corrected") : ru ? "Оставлено в силе" : "Upheld"}
                          </Badge>{" "}
                          <span className="small muted">@{x.opened_by}</span>
                        </span>
                        <span className="prewrap">{x.reason}</span>
                        {x.evidence_url ? (
                          <a href={x.evidence_url} target="_blank" rel="noopener noreferrer nofollow" className="text-link small">
                            {ru ? "Доказательство" : "Evidence"} ↗
                          </a>
                        ) : null}
                        {x.resolution ? <span className="small muted">{x.resolution}</span> : null}
                        {referee && x.status === "open" ? (
                          <ActionForm action="lobby.uphold" lang={lang} back={back} hidden={{ dispute: x.id }} className="inline-form">
                            <input name="note" required minLength={5} maxLength={1000} placeholder={ru ? "Обоснование" : "Reasoning"} aria-label={ru ? "Обоснование" : "Reasoning"} />
                            <button className="btn btn-ghost btn-sm">{ru ? "Оставить результат в силе" : "Uphold the result"}</button>
                          </ActionForm>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {referee && g.status !== "completed" && live ? resultForm(g.id, [], false) : null}
                {referee && g.status === "completed" && correctable ? (
                  <details className="disclosure">
                    <summary>{ru ? "Исправить результат (новая версия)" : "Correct the result (new version)"}</summary>
                    <p className="small muted">
                      {ru
                        ? "Исправление сохраняет прежнюю версию и закрывает открытые споры по этой игре как «исправлено». После старта следующего раунда результаты этого раунда не меняются."
                        : "A correction keeps the previous version and closes open disputes about this game as corrected. Once the next round starts, this round's results are final."}
                    </p>
                    {resultForm(g.id, g.lines, true)}
                  </details>
                ) : null}
                {mine.length && g.status === "completed" && correctable && !disputesOfGame.some((x) => x.status === "open" && x.opened_by === user?.username) ? (
                  <details className="disclosure">
                    <summary>{ru ? "Оспорить результат игры" : "Dispute this game's result"}</summary>
                    <ActionForm action="lobby.dispute" lang={lang} back={back} hidden={{ game: g.id }} className="stack-sm">
                      <Field label={ru ? "Что не так" : "What is wrong"}>
                        <textarea name="reason" required minLength={10} maxLength={1000} rows={3} />
                      </Field>
                      <Field label={ru ? "Ссылка на доказательство" : "Evidence link"} hint={d.common.optional}>
                        <input name="evidence" type="url" maxLength={500} placeholder="https://" />
                      </Field>
                      <button className="btn btn-danger btn-sm">{ru ? "Отправить" : "Submit"}</button>
                    </ActionForm>
                  </details>
                ) : null}
              </article>
            );
          })}
        </div>
        {openDisputes.length && lobby.lobbies > 1 ? (
          <p className="small muted">
            {ru ? "Следующий раунд создаётся после решения открытых споров этого раунда." : "The next round is created once this round's open disputes are decided."}
          </p>
        ) : null}
      </section>
    </div>
  );
}
