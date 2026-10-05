import Link from "next/link";
import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n.ts";
import { GAMES } from "@/lib/games.ts";
import { EXPERIENCE_PROVIDERS, dotaRankName, type ExperienceAvailability, type ExperienceConnection, type ExperienceProvider, type ExperienceRecord, type ProfileExperience } from "@/lib/player-experience.ts";
import { Check } from "./ui";
import { LocalTime } from "./time";
import { SubmitGuard } from "./submit-guard";

const providerNames: Record<ExperienceProvider, string> = { steam: "Steam", opendota: "OpenDota · Dota 2", faceit: "FACEIT · CS2" };
export function ExperienceForm({ action, lang, hidden = {}, children }: { action: string; lang: Locale; hidden?: Record<string, string>; children: ReactNode }) {
  return <form method="post" action={`/api/experience/${action}`} className="stack">
    <input type="hidden" name="lang" value={lang} />
    {Object.entries(hidden).map(([key, value]) => <input type="hidden" name={key} value={value} key={key} />)}
    {children}<SubmitGuard pending={lang === "ru" ? "Обрабатываем…" : "Working…"} />
  </form>;
}
function Metrics({ metrics, lang }: { metrics: Record<string, number>; lang: Locale }) {
  const ru = lang === "ru";
  const names: Record<string, string> = { playtimeMinutes: ru ? "Часов в игре" : "Hours played", matches: ru ? "Матчей у источника" : "Matches recorded by source", wins: ru ? "Побед" : "Wins", losses: ru ? "Поражений" : "Losses", leaderboardRank: ru ? "Место в рейтинге Dota 2" : "Dota 2 leaderboard position", faceitElo: "FACEIT Elo", kills: ru ? "Убийств" : "Kills", deaths: ru ? "Смертей" : "Deaths", assists: ru ? "Помощи" : "Assists", durationSeconds: ru ? "Длительность, сек." : "Duration, sec." };
  return <dl className="stat-grid">{Object.entries(metrics).map(([key, value]) => <div key={key}><dt>{names[key] ?? key}</dt><dd>{new Intl.NumberFormat(ru ? "ru-RU" : "en-GB", { maximumFractionDigits: key === "playtimeMinutes" ? 1 : 0 }).format(key === "playtimeMinutes" ? value / 60 : value)}</dd></div>)}</dl>;
}
function Record({ record, lang }: { record: ExperienceRecord; lang: Locale }) {
  const T = (ru: string, en: string) => lang === "ru" ? ru : en;
  const rank = record.game === "dota2" && record.rankCode ? dotaRankName(record.rankCode, lang) : record.rank?.replace("FACEIT level ", T("Уровень FACEIT ", "FACEIT level "));
  return <div className="stack"><h4>{GAMES.find(g => g.slug === record.game)?.name ?? record.game}</h4>
    {rank && <p><strong>{rank}</strong></p>}<Metrics metrics={record.metrics} lang={lang} />
    <a className="text-link" href={record.sourceUrl} target="_blank" rel="noopener noreferrer">{T("Открыть источник", "View source")} ↗</a>
    {record.recentMatches.length > 0 && <details><summary>{T("Недавние матчи", "Recent matches")} · {record.recentMatches.length}</summary>
      <ul className="stack">{record.recentMatches.map(match => <li key={match.id}><a className="text-link" href={match.sourceUrl} target="_blank" rel="noopener noreferrer"><LocalTime iso={match.playedAt} lang={lang} dateOnly /> · {match.id}</a>{match.result && <> · {match.result === "win" ? T("Победа", "Win") : T("Поражение", "Loss")}</>}<Metrics metrics={match.metrics} lang={lang} /></li>)}</ul>
      <p className="small muted">{T("До 20 последних матчей, доступных у источника; история может быть неполной.", "Up to 20 recent matches available from this source; history may be incomplete.")}</p>
    </details>}
  </div>;
}
function SourceCard({ provider, connection, lang, manage, availability, identityVerified }: { provider: ExperienceProvider; connection?: ExperienceConnection; lang: Locale; manage: boolean; availability?: ExperienceAvailability; identityVerified: boolean }) {
  const T = (ru: string, en: string) => lang === "ru" ? ru : en;
  const descriptions = {
    steam: T("Время игры в поддерживаемые игры Steam. Оно помогает показать накопленный опыт; игровой ранг из часов не выводится.", "Playtime in supported Steam games helps show existing experience. Hours are not converted into a skill rank."),
    opendota: T("Ранг Dota 2, доступные победы и поражения, последние матчи по данным OpenDota. OpenDota — независимый источник, полнота данных зависит от открытой истории игры.", "Dota 2 rank, available wins and losses, and recent matches from OpenDota. OpenDota is an independent source; coverage depends on public match history."),
    faceit: T("Уровень, Elo и доступная история CS2 в FACEIT для подтверждённого Steam-аккаунта.", "FACEIT level, Elo and available CS2 history matched to your verified Steam account."),
  };
  const statuses = { pending: T("Ожидает первого обновления", "Awaiting first sync"), available: T("Данные получены", "Data imported"), private: T("Данные закрыты у источника", "Source data is private"), unavailable: T("Данные недоступны", "Data unavailable"), error: T("Не удалось обновить", "Refresh failed"), stale: T("Сохранённые данные требуют обновления", "Saved data needs refreshing") };
  const issues: Record<string, string> = {
    private_profile: T("Профиль Steam закрыт. Откройте его у источника, если хотите импортировать данные.", "The Steam profile is private. Make it public at the source if you want to import its data."),
    game_details_hidden: T("Steam не открыл сведения об играх. Проверьте видимость «Мои игры» и времени в игре в настройках Steam.", "Steam did not expose game details. Check your Steam game-details and playtime privacy settings."),
    profile_unavailable: T("Источник пока не вернул профиль. Это не означает отсутствие опыта.", "The source has not returned a profile. This does not mean the player lacks experience."),
    no_supported_games: T("В ответе источника нет поддерживаемых игр. Это не оценка вашего уровня.", "The response contains no supported games. This is not an assessment of your level."),
    identity_mismatch: T("Аккаунт в ответе не совпал с подтверждённым. Импорт отклонён; старые данные скрыты.", "The returned account did not match the verified identity. Import was rejected and previous data was hidden."),
    rate_limited: T("Достигнут лимит источника. Автоматическое обновление повторится позже.", "The source request limit was reached. Automatic refresh will retry later."),
    access_denied: T("Источник отказал в доступе. Данные скрыты до восстановления доступа.", "The source denied access. Data is hidden until access is restored."),
    not_found: T("Источник не нашёл профиль или статистику этой игры.", "The source could not find the profile or statistics for this game."),
  };
  const configured = availability?.available ?? false;
  const cooldown = connection?.lastAttemptAt && Date.now() - new Date(connection.lastAttemptAt).getTime() < 15 * 60_000;
  return <article className="card stack" data-experience-provider={provider} style={{ overflowWrap: "anywhere" }}><h3>{providerNames[provider]}</h3><p className="muted">{descriptions[provider]}</p>
    {connection ? <>
      <p><span className="badge">{statuses[connection.status]}</span>{connection.displayName && <> · {connection.displayName}</>}</p>
      {connection.verifiedAt && <p className="small">{T("Аккаунт сопоставлен с подтверждённым Steam", "Account matched to verified Steam")} · <LocalTime iso={connection.verifiedAt} lang={lang} dateOnly /></p>}
      {connection.issue && <p className="notice">{issues[connection.issue] ?? T("Источник временно недоступен. Сохранённая история показана с датой последнего успешного импорта.", "The source is temporarily unavailable. Saved history retains its last successful import date.")}</p>}
      {connection.status === "stale" && <p className="notice">{T("Это последний сохранённый снимок, а не текущий ранг. Временная ошибка не обнуляет опыт.", "This is the last saved snapshot, not a current rank. A temporary error does not reset experience.")}</p>}
      {connection.lastSuccessAt && <p className="small muted">{T("Последний успешный импорт", "Last successful import")}: <LocalTime iso={connection.lastSuccessAt} lang={lang} /></p>}
      {connection.records.map(record => <Record record={record} lang={lang} key={record.game} />)}
      {manage && <>
        <p className="small muted">{T("Следующее плановое обновление не раньше", "Next scheduled refresh no earlier than")}: <LocalTime iso={connection.nextSyncAt} lang={lang} /></p>
        {!configured && <p className="notice">{T("Источник временно отключён оператором. Сохранённые данные доступны с указанной датой.", "This source is currently disabled by the operator. Saved data retains its import date.")}</p>}
        <ExperienceForm action="refresh" lang={lang} hidden={{ connection: connection.id }}><button className="btn btn-secondary" disabled={!configured || Boolean(cooldown)}>{T("Обновить данные", "Refresh data")}</button>{cooldown && <p className="small muted">{T("Повторное ручное обновление доступно через 15 минут после предыдущей попытки.", "Manual refresh is available 15 minutes after the previous attempt.")}</p>}</ExperienceForm>
        <ExperienceForm action="sharing" lang={lang} hidden={{ connection: connection.id }}><Check name="shared" defaultChecked={connection.shared} label={T("Показывать эту историю в моём публичном профиле", "Show this history on my public profile")} /><button className="btn btn-ghost">{T("Сохранить видимость", "Save visibility")}</button></ExperienceForm>
        <details><summary>{T("Отключить источник", "Disconnect source")}</summary><p className="small muted">{T("Обновления прекратятся, импортированные данные этого источника будут удалены из MAXIMUS VEGAS.", "Refreshes will stop and this source's imported data will be removed from MAXIMUS VEGAS.")}</p><ExperienceForm action="disconnect" lang={lang} hidden={{ connection: connection.id }}><Check name="confirm" required label={T("Отключить и удалить импортированные данные", "Disconnect and delete imported data")} /><button className="btn btn-ghost">{T("Отключить и удалить", "Disconnect and delete")}</button></ExperienceForm></details>
      </>}
    </> : manage ? <>
      {!configured && <p className="notice">{availability?.reason === "site_not_configured" ? T("Подключение появится после настройки адреса сайта оператором.", "Connection will be available after the operator configures the site address.") : T("Источник требует подключения оператором. Данные пока не импортируются.", "The operator must enable this source. Data is not being imported yet.")}</p>}
      {!identityVerified && <p className="small muted">{T("Сначала подтвердите свой Steam-аккаунт выше.", "First verify your Steam account above.")}</p>}
      <ExperienceForm action="connect" lang={lang} hidden={{ provider }}><Check name="consent" required label={T(`Разрешаю получать и обновлять мои открытые игровые данные из ${providerNames[provider]}. Источнику передаётся мой подтверждённый Steam ID.`, `I allow importing and refreshing my public game data from ${providerNames[provider]}. The source receives my verified Steam ID.`)} /><Check name="shared" label={T("Показывать историю в моём публичном профиле", "Show history on my public profile")} /><button className="btn btn-secondary" disabled={!configured || !identityVerified}>{T("Подключить и импортировать", "Connect and import")}</button></ExperienceForm>
    </> : null}
  </article>;
}

/** Profile embeds stay compact; management controls are explicitly opted in on /experience. */
export function PlayerExperienceCard({ lang, data, availability = [], manage = false }: { lang: Locale; data: ProfileExperience; availability?: ExperienceAvailability[]; manage?: boolean }) {
  const T = (ru: string, en: string) => lang === "ru" ? ru : en;
  const controls = manage && data.canManage;
  return <section className="section-tight stack" aria-label={T("Игровой опыт из других сервисов", "Experience from other services")}>
    <div><h2>{data.canManage ? T("Ваш опыт в игре", "Your game experience") : T("Игровой опыт", "Game experience")}</h2><p className="muted">{data.canManage && <>{T("Сохраните историю, которую уже заработали.", "Bring the history you have already earned.")} </>}{T("Внешние ранги и матчи отображаются с источником и датой; локальная активность MAXIMUS VEGAS учитывается отдельно.", "External ranks and matches keep their source and date; MAXIMUS VEGAS activity is tracked separately.")}</p></div>
    {!controls && data.canManage && <Link className="text-link" href={`/${lang}/experience`}>{T("Подключить или обновить источники", "Connect or refresh sources")} →</Link>}
    {controls && <article className="card stack"><h3>{T("1. Подтвердите игровой аккаунт", "1. Verify your game account")}</h3>
      {data.steamIdentity ? <><p>{T("Steam подтверждён", "Steam verified")}: <a className="text-link" href={`https://steamcommunity.com/profiles/${data.steamIdentity.steamId}`} target="_blank" rel="noopener noreferrer">{data.steamIdentity.steamId}</a></p><p className="small muted">{T("Повторно подтверждать его для каждого источника не нужно.", "You do not need to verify this account again for each source.")}</p><details><summary>{T("Отключить Steam и все импорты", "Disconnect Steam and all imports")}</summary><ExperienceForm action="disconnect-steam" lang={lang}><Check name="confirm" required label={T("Удалить привязку Steam, все импортированные данные и настройки их публикации", "Remove the Steam link, all imported data and their sharing settings")} /><button className="btn btn-ghost">{T("Отключить и удалить", "Disconnect and delete")}</button></ExperienceForm></details></> : <><p>{T("Войдите на странице Steam. MAXIMUS VEGAS получит только идентификатор аккаунта для привязки; пароль Steam сюда не передаётся.", "Sign in on Steam's page. MAXIMUS VEGAS receives your account identifier for linking; your Steam password is not sent here.")}</p><ExperienceForm action="verify-steam" lang={lang}><Check name="consent" required label={T("Разрешаю сохранить мой Steam ID для подтверждения принадлежности игровых данных", "I allow storing my Steam ID to verify ownership of game data")} /><button className="btn" disabled={availability.every(p => p.reason === "site_not_configured" || p.reason === "disabled")}>{T("Подтвердить через Steam", "Verify through Steam")}</button></ExperienceForm></>}
    </article>}
    {controls && <h3>{T("2. Выберите источники опыта", "2. Choose your experience sources")}</h3>}
    {!controls && !data.connections.length && !data.partnerRecords.length && <p className="notice">{data.canManage ? T("Внешний опыт ещё не подключён. Это не оценка вашего игрового уровня.", "External experience is not connected yet. This is not an assessment of your skill.") : T("Игрок пока не опубликовал внешний игровой опыт.", "This player has not shared external game experience yet.")}</p>}
    <div className="grid grid-2">{(controls ? EXPERIENCE_PROVIDERS : data.connections.map(c => c.provider)).map(provider => <SourceCard key={provider} provider={provider} lang={lang} connection={data.connections.find(c => c.provider === provider)} manage={controls} availability={availability.find(p => p.provider === provider)} identityVerified={Boolean(data.steamIdentity)} />)}</div>
    {(controls || data.partnerRecords.length > 0) && <article className="card stack" style={{ overflowWrap: "anywhere" }}><h3>{T("Подписанная история партнёров", "Signed partner history")}</h3><p className="small muted">{T("Записи от одобренных источников с подтверждённой привязкой и проверкой организатора. Это не подтверждение издателя игры.", "Records from approved sources with a verified link and organiser review. This is not game-publisher verification.")}</p>
      {data.partnerRecords.length ? <ul className="stack">{data.partnerRecords.map(record => <li key={record.id}><strong>{record.source}</strong> · {GAMES.find(g => g.slug === record.game)?.name ?? record.game} · <LocalTime iso={record.playedAt} lang={lang} dateOnly /><p>{record.matchRef}</p><Metrics metrics={record.metrics} lang={lang} /><a className="text-link" href={record.sourceUrl} target="_blank" rel="noopener noreferrer">{T("Источник", "Source")} ↗</a></li>)}</ul> : <p className="muted">{T("Подтверждённых записей пока нет.", "No confirmed records yet.")}</p>}
      {controls && <><ExperienceForm action="partner-sharing" lang={lang}><Check name="shared" defaultChecked={data.sharePartner} label={T("Показывать подтверждённую историю партнёров в публичном профиле", "Show confirmed partner history on my public profile")} /><button className="btn btn-ghost">{T("Сохранить видимость", "Save visibility")}</button></ExperienceForm><Link className="text-link" href={`/${lang}/statistics`}>{T("Подключить партнёрский источник", "Connect a partner source")} →</Link></>}
    </article>}
    {controls && <p className="small muted">{T("Источники становятся доступны для планового обновления раз в сутки. Обновление запускается при посещении этой страницы и планировщиком, с учётом очереди, доступности и лимитов. После фонового обновления перезагрузите страницу. Импорт не начисляет XP и не меняет результаты турниров.", "Sources become due for scheduled refresh once a day. Refresh runs when you visit this page and through the scheduler, subject to the queue, availability and limits. Reload the page after a background refresh. Imports do not award XP or alter tournament results.")}</p>}
  </section>;
}
