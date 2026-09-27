import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale, type Locale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import {
  balance,
  coinHistory,
  COSMETICS,
  objectiveStates,
  ownedCosmetics,
  passReward,
  premiumUnlocked,
  rankFor,
  REFERRAL,
  referralCode,
  SEASON,
  seasonXp,
  totalXp,
} from "@/server/progression.ts";
import { ActionForm, DbDown, Field, Flash, PageHead, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "progress", lang === "ru" ? "Прогресс" : "Progress", undefined, { noindex: true });
}

const OBJECTIVE_TEXT: Record<string, { ru: string; en: string }> = {
  profile_country: { ru: "Укажите страну в профиле", en: "Set your country in your profile" },
  verify_email: { ru: "Подтвердите email", en: "Confirm your email" },
  link_game: { ru: "Привяжите игровой ник", en: "Link an in-game name" },
  join_team: { ru: "Создайте команду или вступите в неё", en: "Create or join a team" },
  first_registration: { ru: "Зарегистрируйтесь на первый турнир", en: "Register for your first tournament" },
  first_match: { ru: "Сыграйте первый подтверждённый матч", en: "Play your first confirmed match" },
  first_win: { ru: "Выиграйте подтверждённый матч", en: "Win a confirmed match" },
  first_challenge: { ru: "Завершите вызов 1v1 или быстрый матч", en: "Complete a 1v1 challenge or quick match" },
  podium: { ru: "Займите место в тройке турнира", en: "Finish in a tournament's top three" },
  rank_bronze: { ru: "Достигните ранга «Бронза»", en: "Reach the Bronze rank" },
  rank_silver: { ru: "Достигните ранга «Серебро»", en: "Reach the Silver rank" },
  rank_gold: { ru: "Достигните ранга «Золото»", en: "Reach the Gold rank" },
};

const REASON_TEXT: Record<string, { ru: string; en: string }> = {
  objective: { ru: "Цель", en: "Objective" },
  pass_reward: { ru: "Уровень пропуска", en: "Pass tier" },
  pass_premium: { ru: "Премиальная линия пропуска", en: "Premium pass track" },
  cosmetic_purchase: { ru: "Покупка предмета", en: "Item purchase" },
  champion_award: { ru: "Награда победителю турнира", en: "Tournament winner's award" },
  referral_bonus: { ru: "Бонус по приглашению", en: "Invite bonus" },
  referral_reward: { ru: "Награда за приглашение", en: "Invite reward" },
};

const itemName = (id: string, lang: Locale) => {
  const ru: Record<string, string> = { graphite: "Графит", slate: "Сланец", violet: "Фиалка", emerald: "Изумруд", amber: "Янтарь", crimson: "Кармин", azure: "Лазурь", ivory: "Слоновая кость", sunset: "Закат", mint: "Мята", neon: "Неон", aurora: "Аврора", gold: "Золото участника" };
  const en: Record<string, string> = { graphite: "Graphite", slate: "Slate", violet: "Violet", emerald: "Emerald", amber: "Amber", crimson: "Crimson", azure: "Azure", ivory: "Ivory", sunset: "Sunset", mint: "Mint", neon: "Neon", aurora: "Aurora", gold: "Member gold" };
  return (lang === "ru" ? ru : en)[id] ?? id;
};

export default async function Progress({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user) redirect(`/${lang}/signin?next=/${lang}/progress`);
  const [xp, sxp, coins, objectives, owned, premium, history, code] = await Promise.all([
    totalXp(db, user.id),
    seasonXp(db, user.id),
    balance(db, user.id),
    objectiveStates(db, user.id),
    ownedCosmetics(db, user.id),
    premiumUnlocked(db, user.id),
    coinHistory(db, user.id, 30),
    referralCode(db, user.id),
  ]);
  const claims = await db.query<{ tier: number; track: string }>("select tier, track from pass_claims where user_id = $1 and season = $2", [user.id, SEASON.id]);
  const claimed = new Set(claims.map((c) => `${c.tier}:${c.track}`));
  const [redeemed] = await db.query<{ code: string }>("select code from referral_redemptions where referee_id = $1", [user.id]);
  const [me] = await db.query<{ created_at: Date; avatar_color: string }>("select created_at, avatar_color from users where id = $1", [user.id]);
  const canRedeem = !redeemed && Date.now() - new Date(me.created_at).getTime() < REFERRAL.windowDays * 86400_000;
  const { rank, next, progress } = rankFor(xp);
  const reached = Math.min(SEASON.tiers, Math.floor(sxp / SEASON.xpPerTier));
  const back = `/${lang}/progress`;

  return (
    <div className="container page">
      <PageHead
        eyebrow={T("ПРОГРЕСС", "PROGRESS")}
        title={T("Ранг, цели и сезонный пропуск", "Rank, objectives and season pass")}
        lead={T(
          "XP и монеты начисляются только за подтверждённую активность. Монеты не покупаются, не передаются, не выводятся и не ставятся на исход — их можно потратить только на косметику и премиальную линию пропуска.",
          "XP and coins come only from confirmed activity. Coins cannot be bought, transferred, withdrawn or staked on an outcome — they are spent only on cosmetics and the premium pass track.",
        )}
      />
      <Flash lang={lang} params={sp} />

      <section className="grid grid-3 facts">
        <div className="card">
          <p className="field-label">{T("Ранг", "Rank")}</p>
          <p className="big-number">{ru ? rank.ru : rank.en}</p>
          <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="small muted">
            {xp} XP{next ? ` · ${T("до", "to")} ${ru ? next.ru : next.en}: ${next.min - xp}` : ` · ${T("высший ранг", "top rank")}`}
          </p>
        </div>
        <div className="card">
          <p className="field-label">{T("Монеты", "Coins")}</p>
          <p className="big-number">{coins}</p>
          <p className="small muted">{T("Без денежной стоимости", "No cash value")}</p>
        </div>
        <div className="card">
          <p className="field-label">{T("Сезонный пропуск", "Season pass")}</p>
          <p className="big-number">
            {reached} / {SEASON.tiers}
          </p>
          <p className="small muted">
            {sxp} XP {T("в сезоне", "this season")} · {SEASON.xpPerTier} XP {T("за уровень", "per tier")}
          </p>
        </div>
      </section>

      <section className="section-tight" id="objectives">
        <h2 className="h3">{T("Цели", "Objectives")}</h2>
        <p className="small muted">{T("Проверяются по реальному состоянию аккаунта в момент получения и выплачиваются один раз.", "Checked against your real account state when claimed, and paid once.")}</p>
        <ul className="list">
          {objectives.map((o) => (
            <li key={o.id}>
              <span className="grow">
                {OBJECTIVE_TEXT[o.id]?.[lang] ?? o.id}
                <span className="small muted">
                  {" "}
                  · +{o.coins} {T("монет", "coins")}
                  {o.xp ? ` · +${o.xp} XP` : ""}
                </span>
              </span>
              {o.claimed ? (
                <span className="badge badge-ok">{T("Получено", "Claimed")}</span>
              ) : o.achieved ? (
                <ActionForm action="objective.claim" lang={lang} back={back} hidden={{ objective: o.id }}>
                  <button className="btn btn-primary btn-xs">{T("Получить", "Claim")}</button>
                </ActionForm>
              ) : (
                <span className="badge badge-muted">{T("Не выполнено", "Not yet")}</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="section-tight" id="pass">
        <div className="row-between">
          <h2 className="h3">{T("Сезонный пропуск", "Season pass")}</h2>
          {premium ? (
            <span className="badge badge-ok">{premium === "membership" ? T("Премиум по членству", "Premium via membership") : T("Премиум открыт", "Premium unlocked")}</span>
          ) : (
            <ActionForm action="pass.unlock" lang={lang} back={back}>
              <button className="btn btn-ghost btn-sm" disabled={coins < SEASON.premiumPrice}>
                {T("Открыть премиум за", "Unlock premium for")} {SEASON.premiumPrice} {T("монет", "coins")}
              </button>
            </ActionForm>
          )}
        </div>
        <div className="pass-track" role="list">
          {Array.from({ length: SEASON.tiers }, (_, i) => i + 1).map((tier) => {
            const open = tier <= reached;
            const cell = (track: "free" | "premium") => {
              const reward = passReward(tier, track);
              if (!reward) return <span className="muted small">—</span>;
              const text = reward.coins ? `+${reward.coins}` : itemName(reward.cosmetic!, lang);
              const key = `${tier}:${track}`;
              if (claimed.has(key)) return <span className="small ok-text">✓ {text}</span>;
              if (!open || (track === "premium" && !premium)) return <span className="small muted">{text}</span>;
              return (
                <ActionForm action="pass.claim" lang={lang} back={`${back}#pass`} hidden={{ tier: String(tier), track }}>
                  <button className="btn btn-primary btn-xs">{text}</button>
                </ActionForm>
              );
            };
            return (
              <div key={tier} className={`tier${open ? " is-open" : ""}`} role="listitem">
                <span className="tier-n">{tier}</span>
                <div className="tier-row">
                  <span className="tier-label">{T("Бесплатно", "Free")}</span>
                  {cell("free")}
                </div>
                <div className="tier-row">
                  <span className="tier-label">{T("Премиум", "Premium")}</span>
                  {cell("premium")}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="section-tight" id="shop">
        <h2 className="h3">{T("Цвет аватара", "Avatar colour")}</h2>
        <p className="small muted">{T("Косметика не даёт преимущества в игре. Часть цветов — только из пропуска или членства.", "Cosmetics give no in-game advantage. Some colours come only from the pass or membership.")}</p>
        <div className="swatches">
          {COSMETICS.map((c) => {
            const has = owned.has(c.id);
            const equipped = (me.avatar_color || "graphite") === c.id;
            return (
              <div key={c.id} className={`swatch-card${equipped ? " is-equipped" : ""}`}>
                <span className="swatch" style={{ background: c.color }} aria-hidden="true" />
                <span className="small">{itemName(c.id, lang)}</span>
                {equipped ? (
                  <span className="badge badge-ok">{T("Выбран", "Equipped")}</span>
                ) : has ? (
                  <ActionForm action="cosmetic.equip" lang={lang} back={`${back}#shop`} hidden={{ item: c.id }}>
                    <button className="btn btn-ghost btn-xs">{T("Выбрать", "Equip")}</button>
                  </ActionForm>
                ) : c.source === "shop" ? (
                  <ActionForm action="shop.buy" lang={lang} back={`${back}#shop`} hidden={{ item: c.id }}>
                    <button className="btn btn-ghost btn-xs" disabled={coins < (c.price ?? 0)}>
                      {c.price} {T("монет", "coins")}
                    </button>
                  </ActionForm>
                ) : (
                  <span className="small muted">{c.source === "pass" ? T("Из пропуска", "From the pass") : T("Для участников членства", "Members only")}</span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="section-tight grid grid-2" id="referral">
        <div className="card stack-sm">
          <h2 className="h4">{T("Пригласите игрока", "Invite a player")}</h2>
          <p className="small muted">
            {T(
              `Приглашённый получает ${REFERRAL.refereeBonus} монет. Вы получаете ${REFERRAL.referrerBonus} монет, когда он сыграет первый подтверждённый матч (до ${REFERRAL.referrerCap} приглашений).`,
              `The invited player gets ${REFERRAL.refereeBonus} coins. You get ${REFERRAL.referrerBonus} coins once they play their first confirmed match (up to ${REFERRAL.referrerCap} invites).`,
            )}
          </p>
          <p>
            {T("Ваш код", "Your code")}: <strong className="mono">{code}</strong>
          </p>
        </div>
        <div className="card stack-sm">
          <h2 className="h4">{T("Код приглашения", "Invite code")}</h2>
          {redeemed ? (
            <p className="small">
              {T("Использован код", "Code used")}: <span className="mono">{redeemed.code}</span>
            </p>
          ) : canRedeem ? (
            <ActionForm action="referral.redeem" lang={lang} back={`${back}#referral`} className="inline-form">
              <Field label={T("Код друга", "Friend's code")}>
                <input name="code" required minLength={8} maxLength={12} autoCapitalize="characters" spellCheck={false} />
              </Field>
              <button className="btn btn-ghost btn-sm">{T("Применить", "Apply")}</button>
            </ActionForm>
          ) : (
            <p className="small muted">{T(`Код можно ввести в первые ${REFERRAL.windowDays} дней после регистрации.`, `A code can be entered within ${REFERRAL.windowDays} days of signing up.`)}</p>
          )}
        </div>
      </section>

      <section className="section-tight">
        <h2 className="h3">{T("История монет", "Coin history")}</h2>
        {history.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{T("Когда", "When")}</th>
                  <th>{T("Операция", "Entry")}</th>
                  <th>{T("Изменение", "Change")}</th>
                  <th>{T("Баланс", "Balance")}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="small">
                      <LocalTime iso={h.created_at} lang={lang} />
                    </td>
                    <td>{REASON_TEXT[h.reason]?.[lang] ?? h.reason}</td>
                    <td className={h.delta > 0 ? "ok-text" : undefined}>{h.delta > 0 ? `+${h.delta}` : h.delta}</td>
                    <td>{h.balance_after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small">{T("Операций пока нет.", "No entries yet.")}</p>
        )}
      </section>
    </div>
  );
}
