import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { GameNames } from "@/components/game-names";
import { countryName, countryOptions } from "@/lib/countries.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { mailConfigured } from "@/server/mail.ts";
import { REFERRAL } from "@/server/progression.ts";
import { ActionForm, DbDown, Field, Flash, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "welcome", lang === "ru" ? "Первые шаги" : "Getting started", undefined, { noindex: true });
}

/**
 * Four optional steps after sign-up. Every step can be skipped; nothing here is required to use the portal.
 * Each form returns to this page, so a player can do the steps in any order.
 */
export default async function Welcome({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
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
  if (!user) redirect(`/${lang}/signin?next=/${lang}/welcome`);
  const back = `/${lang}/welcome`;
  const [[me], accounts, [team], [reg], [redeemed]] = await Promise.all([
    db.query<{ country_code: string | null; email_verified_at: Date | null; created_at: Date }>(
      "select country_code, email_verified_at, created_at from users where id = $1",
      [user.id],
    ),
    db.query<{ game: string; handle: string }>("select game, handle from all_game_accounts where user_id = $1 order by game", [user.id]),
    db.query<{ slug: string; name: string }>(
      "select t.slug, t.name from team_members m join teams t on t.id = m.team_id where m.user_id = $1 order by m.joined_at limit 1",
      [user.id],
    ),
    db.query<{ n: number }>(
      "select count(*)::int as n from roster_entries re join registrations r on r.id = re.registration_id where re.user_id = $1 and r.status in ('registered','waitlisted')",
      [user.id],
    ),
    db.query<{ code: string }>("select code from referral_redemptions where referee_id = $1", [user.id]),
  ]);
  const referralOpen = !redeemed && Date.now() - new Date(me.created_at).getTime() < REFERRAL.windowDays * 86400_000;
  const steps = [
    { id: "country", done: Boolean(me.country_code) },
    { id: "games", done: accounts.length > 0 },
    { id: "team", done: Boolean(team) },
    { id: "tournament", done: (reg?.n ?? 0) > 0 },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const mail = mailConfigured();

  return (
    <div className="container narrow page onboarding">
      <p className="eyebrow">{T("ПЕРВЫЕ ШАГИ", "GETTING STARTED")}</p>
      <h1>
        {T("Добро пожаловать", "Welcome")}, {user.displayName}
      </h1>
      <p className="lead">
        {T(
          "Четыре шага, каждый можно пропустить и вернуться к нему позже из хаба. Регистрация, команды и турниры бесплатны.",
          "Four steps; skip any of them and come back later from your hub. Sign-up, teams and tournaments are free.",
        )}
      </p>
      <Flash lang={lang} params={sp} />
      <p className="small muted" aria-live="polite">
        {T(`Выполнено: ${doneCount} из 4`, `Done: ${doneCount} of 4`)}
      </p>

      {!me.email_verified_at && mail ? (
        <div className="notice">
          <p>
            {T("Мы отправили письмо для подтверждения на", "We sent a confirmation email to")} <strong>{user.email}</strong>.{" "}
            {T("Подтверждение нужно для оплаты членства и восстановления доступа.", "Confirmation is needed for membership payments and account recovery.")}
          </p>
          <ActionForm action="auth.verify_request" lang={lang} back={back}>
            <button className="btn btn-ghost btn-sm">{T("Отправить письмо ещё раз", "Send the email again")}</button>
          </ActionForm>
        </div>
      ) : null}

      <ol className="step-list">
        <li className={steps[0].done ? "step-card is-done" : "step-card"} id="step-country">
          <div className="step-head">
            <span className="step-num" aria-hidden="true">
              1
            </span>
            <h2 className="h4">{T("Страна", "Country")}</h2>
            {steps[0].done ? <span className="badge badge-ok">{countryName(me.country_code, lang)}</span> : null}
          </div>
          <p className="small muted">
            {T(
              "Нужна только для турниров, которые организатор ограничил отдельными странами. В публичном профиле не показывается.",
              "Used only for tournaments an organiser limits to certain countries. It is not shown on your public profile.",
            )}
          </p>
          <ActionForm action="account.country" lang={lang} back={`${back}#step-country`} className="inline-form">
            <select name="countryCode" defaultValue={me.country_code ?? ""} aria-label={T("Страна", "Country")}>
              <option value="">{T("Не указывать", "Prefer not to say")}</option>
              {countryOptions(lang).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost btn-sm">{T("Сохранить", "Save")}</button>
          </ActionForm>
        </li>

        <li className={steps[1].done ? "step-card is-done" : "step-card"} id="step-games">
          <div className="step-head">
            <span className="step-num" aria-hidden="true">
              2
            </span>
            <h2 className="h4">{T("Игровые ники", "In-game names")}</h2>
          </div>
          <p className="small muted">
            {T(
              "Соперники и организаторы увидят, как найти вас в игре. Ники указываются вами и помечаются как непроверенные.",
              "Opponents and organisers see how to find you in the game. You enter the names yourself; they are marked unverified.",
            )}
          </p>
          <GameNames lang={lang} back={`${back}#step-games`} accounts={accounts} />
        </li>

        <li className={steps[2].done ? "step-card is-done" : "step-card"} id="step-team">
          <div className="step-head">
            <span className="step-num" aria-hidden="true">
              3
            </span>
            <h2 className="h4">{T("Команда", "Team")}</h2>
            {team ? (
              <Link href={`/${lang}/teams/${team.slug}`} className="badge badge-ok">
                {team.name}
              </Link>
            ) : null}
          </div>
          <p className="small muted">
            {T(
              "Для командных турниров создайте команду или попросите капитана пригласить вас по имени пользователя:",
              "For team tournaments, create a team or ask a captain to invite you by username:",
            )}{" "}
            <strong className="mono">@{user.username}</strong>
          </p>
          <div className="row">
            <Link href={`/${lang}/teams/new`} className="btn btn-ghost btn-sm">
              {T("Создать команду", "Create a team")}
            </Link>
            <Link href={`/${lang}/teams`} className="btn btn-ghost btn-sm">
              {T("Все команды", "All teams")}
            </Link>
          </div>
        </li>

        <li className={steps[3].done ? "step-card is-done" : "step-card"} id="step-tournament">
          <div className="step-head">
            <span className="step-num" aria-hidden="true">
              4
            </span>
            <h2 className="h4">{T("Первый турнир", "First tournament")}</h2>
          </div>
          <p className="small muted">
            {T(
              "Выберите турнир с открытой регистрацией или сыграйте быстрый матч 1v1 с реальным соперником. Ставок нет — за игру начисляется XP.",
              "Pick a tournament with open registration or play a 1v1 quick match against a real opponent. There are no stakes — games earn XP.",
            )}
          </p>
          <div className="row">
            <ActionForm action="onboarding.done" lang={lang} back={back} hidden={{ next: "tournaments" }}>
              <button className="btn btn-primary btn-sm">{T("Найти турнир", "Find a tournament")}</button>
            </ActionForm>
            <Link href={`/${lang}/matchmaking`} className="btn btn-ghost btn-sm">
              {T("Быстрый матч", "Quick match")}
            </Link>
          </div>
        </li>
      </ol>

      {referralOpen ? (
        <details className="disclosure card" id="referral">
          <summary>{T("Есть код приглашения?", "Have an invite code?")}</summary>
          <p className="small muted">
            {T(
              `Код друга даёт вам ${REFERRAL.refereeBonus} монет сразу. Монеты нельзя купить, передать или вывести — только потратить на косметику на портале.`,
              `A friend's code gives you ${REFERRAL.refereeBonus} coins right away. Coins cannot be bought, transferred or cashed out — only spent on cosmetics on the portal.`,
            )}
          </p>
          <ActionForm action="referral.redeem" lang={lang} back={`${back}#referral`} className="inline-form">
            <input name="code" required minLength={8} maxLength={12} autoCapitalize="characters" spellCheck={false} aria-label={T("Код приглашения", "Invite code")} placeholder="ABCD2345" />
            <button className="btn btn-ghost btn-sm">{T("Применить", "Apply")}</button>
          </ActionForm>
        </details>
      ) : null}

      <div className="row-between section-tight">
        <ActionForm action="onboarding.done" lang={lang} back={back} hidden={{ next: "hub" }}>
          <button className="btn btn-ghost">{doneCount === 4 ? T("Готово — в хаб", "Done — go to my hub") : T("Пропустить и перейти в хаб", "Skip and go to my hub")}</button>
        </ActionForm>
        <Link href={`/${lang}/progress`} className="text-link small">
          {T("Прогресс, цели и сезонный пропуск", "Progress, objectives and season pass")}
        </Link>
      </div>
    </div>
  );
}
