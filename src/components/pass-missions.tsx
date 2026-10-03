import Link from "next/link";
import { ActionForm, Field } from "./ui";
import { LocalTime } from "./time";
import type { Locale } from "@/lib/i18n.ts";
import { GAMES } from "@/lib/games.ts";
import type { Database } from "@/server/db.ts";
import { currentSeason } from "@/server/progression.ts";
import { MISSIONS, missionStates, missionHistory, rewardCatalogue } from "@/server/missions.ts";

export async function PassMissions({ db, userId, lang }: { db: Database; userId: string; lang: Locale }) {
  const T = (ru: string, en: string) => lang === "ru" ? ru : en, back = `/${lang}/progress`;
  const [missions, history, catalogue, preferences, seasons] = await Promise.all([
    missionStates(db, userId), missionHistory(db, userId), rewardCatalogue(db, userId),
    db.query<{ game: string }>("select game from mission_preferences where user_id=$1", [userId]),
    db.query<{ season: string; n: number }>("select season,count(*)::int as n from pass_claims where user_id=$1 group by season order by season", [userId]),
  ]);
  const season = currentSeason();
  return <section className="section-tight" id="missions">
    <h2>{T("Задания сезона", "Season missions")} {season.id.toUpperCase()}</h2>
    <p className="muted">{T("Сезон заканчивается", "Season ends")} <LocalTime iso={season.endsAt} lang={lang} />. {T("Ежедневное обновление в 00:00 UTC, еженедельное — в понедельник. Награду заберите до конца периода.", "Daily reset at 00:00 UTC; weekly reset on Monday. Claim each reward before its period ends.")}</p>
    <ActionForm action="mission.preference" lang={lang} back={back} className="row">
      <Field label={T("Игра для следующих заданий", "Game for future missions")} hint={T("Уже выданные задания не меняются.", "Existing assignments stay unchanged.")}><select name="game" defaultValue={preferences[0]?.game ?? ""}><option value="">{T("Все игры", "All games")}</option>{GAMES.map(g => <option key={g.slug} value={g.slug}>{g.name}</option>)}</select></Field>
      <button className="btn btn-ghost">{T("Сохранить", "Save")}</button>
    </ActionForm>
    <div className="grid grid-2">{missions.map(m => <article key={m.mission} className="card">
      <h3>{MISSIONS.find(d => d.id === m.mission)?.[lang]}</h3>
      <p>{m.game ? GAMES.find(g => g.slug === m.game)?.name : T("Все игры", "All games")} · {m.progress}/{m.target} · +{m.coins} {T("монет", "coins")} · +{m.xp} XP</p>
      <progress value={m.progress} max={m.target} aria-label={T("Выполнение задания", "Mission progress")} />
      <p className="small muted">{T("До", "Until")} <LocalTime iso={m.window_end} lang={lang} /></p>
      <ActionForm action="mission.claim" lang={lang} back={back} hidden={{ mission: m.mission }}><button className="btn btn-primary" disabled={Boolean(m.claimed_at) || m.progress < m.target}>{m.claimed_at ? T("Получено", "Claimed") : T("Получить награду", "Claim reward")}</button></ActionForm>
    </article>)}</div>
    <details className="section-tight"><summary>{T("История заданий и сезонов", "Mission and season history")}</summary>
      <ul>{history.map(m => <li key={`${m.mission}:${m.window_start}`}>{MISSIONS.find(d => d.id === m.mission)?.[lang]} · +{m.coins} · {m.claimed_at && <LocalTime iso={m.claimed_at} lang={lang} />}</li>)}</ul>
      {seasons.map(s => <p key={s.season}>{s.season.toUpperCase()} · {s.n} {T("наград пропуска получено", "pass rewards claimed")}</p>)}
      {!history.length && !seasons.length && <p>{T("Полученные награды появятся здесь.", "Claimed rewards will appear here.")}</p>}
    </details>
    <h2>{T("Подарки на площадках", "Venue gifts")}</h2>
    <p className="muted">{T("Подарки предоставляют подтверждённые площадки с указанными условиями и остатком. Участие бесплатное; обмена монет на товары нет.", "Verified venues supply gifts with stated terms and stock. Participation is free; coins cannot be exchanged for goods.")}</p>
    {!catalogue.rewards.length && <p>{T("Площадки пока не разместили подарки.", "Venues have not listed gifts yet.")}</p>}
    <div className="grid grid-2">{catalogue.rewards.map(r => <article className="card" key={r.id}><h3>{r.title}</h3><p className="prewrap">{r.description}</p><p><Link href={`/${lang}/venues/${r.slug}`}>{r.venue}</Link> · {r.city}</p><p>{T("Уровень", "Tier")} {r.tier} · {T("Осталось", "Remaining")}: {r.remaining}</p><ActionForm action="reward.reserve" lang={lang} back={back} hidden={{ reward: r.id }}><button className="btn btn-primary" disabled={r.remaining < 1 || catalogue.claims.some(c => c.reward_id === r.id)}>{T("Зарезервировать", "Reserve")}</button></ActionForm></article>)}</div>
    {catalogue.claims.map(c => <article className="card section-tight" key={c.id}><h3>{c.title}</h3><p>{c.venue} · {c.status === "reserved" ? T("Готово к получению", "Reserved for collection") : c.status === "collected" ? T("Получено", "Collected") : T("Отменено", "Cancelled")}</p>{c.code && <><p>{T("При получении покажите сотруднику номер и код. Не публикуйте код.", "Show the attendant this reference and code when collecting. Keep the code private.")}</p><p className="mono break-word">{c.id}</p><p className="mono break-word">{c.code}</p><ActionForm action="reward.cancel" lang={lang} back={back} hidden={{ claim: c.id }}><button className="btn btn-ghost">{T("Отменить резерв подарка", "Cancel gift reservation")}</button></ActionForm></>}</article>)}
  </section>;
}
