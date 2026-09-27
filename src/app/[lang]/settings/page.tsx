import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { GAMES, gameBySlug } from "@/lib/games.ts";
import { countryOptions } from "@/lib/countries.ts";
import { LEGAL_VERSIONS } from "@/lib/legal.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { sessionsFor } from "@/server/queries.ts";
import { latestConsents } from "@/server/accounts.ts";
import { mailConfigured } from "@/server/mail.ts";
import { isStaff } from "@/server/access.ts";
import { ActionForm, Badge, Check, DbDown, Field, Flash, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "settings", dict(lang).settings.title, undefined, { noindex: true });
}

export default async function Settings({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
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
  if (!user) redirect(`/${lang}/signin?next=/${lang}/settings`);
  const [[profile], accounts, sessions, consents] = await Promise.all([
    db.query<{
      display_name: string;
      country: string;
      country_code: string | null;
      bio: string;
      profile_public: boolean;
      email: string;
      email_verified_at: Date | null;
      marketing_opt_in_at: Date | null;
    }>(
      "select display_name, country, country_code, bio, profile_public, email, email_verified_at, marketing_opt_in_at from users where id = $1",
      [user.id],
    ),
    db.query<{ game: string; handle: string }>("select game, handle from linked_game_accounts where user_id = $1 order by game", [user.id]),
    sessionsFor(db, user.id),
    latestConsents(db, user.id),
  ]);
  const back = `/${lang}/settings`;
  const mail = mailConfigured();
  const marketingOn = Boolean(profile.marketing_opt_in_at);
  const termsCurrent = consents.terms?.version === LEGAL_VERSIONS.terms && consents.privacy?.version === LEGAL_VERSIONS.privacy;
  const consentRows: Array<[string, string]> = [
    ["terms", T("Условия использования", "Terms of use")],
    ["privacy", T("Уведомление о конфиденциальности", "Privacy notice")],
    ["marketing", T("Рассылки", "Marketing emails")],
  ];

  return (
    <div className="container narrow page">
      <h1>{d.settings.title}</h1>
      <Flash lang={lang} params={sp} />

      <section className="section-tight">
        <h2 className="h3">{d.settings.profile}</h2>
        <ActionForm action="account.profile" lang={lang} back={back} className="card form-card">
          <Field label={d.settings.displayName}>
            <input name="displayName" required minLength={2} maxLength={60} defaultValue={profile.display_name} />
          </Field>
          <Field
            label={T("Страна для турниров", "Country for tournaments")}
            hint={T("Нужна только для турниров с ограничением по странам. Не публикуется.", "Needed only for country-limited tournaments. Not published.")}
          >
            <select name="countryCode" defaultValue={profile.country_code ?? ""}>
              <option value="">{T("Не указывать", "Prefer not to say")}</option>
              {countryOptions(lang).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={T("Город или регион — виден в профиле", "City or region — shown on your profile")} hint={d.common.optional}>
            <input name="country" maxLength={60} defaultValue={profile.country} />
          </Field>
          <Field label={d.settings.bio} hint={d.common.optional}>
            <textarea name="bio" rows={3} maxLength={600} defaultValue={profile.bio} />
          </Field>
          <Check name="profilePublic" label={d.settings.public} defaultChecked={profile.profile_public} />
          <button className="btn btn-primary">{d.common.save}</button>
        </ActionForm>
        <p className="small muted">
          {T("Цвет аватара и косметика — в разделе", "Avatar colour and cosmetics are in")}{" "}
          <Link href={`/${lang}/progress#shop`} className="text-link">
            {T("«Прогресс»", "Progress")}
          </Link>
          .
        </p>
      </section>

      <section className="section-tight" id="email">
        <h2 className="h3">Email</h2>
        <div className="card stack-sm">
          <div className="row-between">
            <span className="mono">{profile.email}</span>
            {profile.email_verified_at ? (
              <Badge status="ok">{T("Подтверждён", "Confirmed")}</Badge>
            ) : (
              <Badge status="warn">{T("Не подтверждён", "Not confirmed")}</Badge>
            )}
          </div>
          {profile.email_verified_at ? (
            <p className="small muted">
              {T("Подтверждён", "Confirmed")} <LocalTime iso={profile.email_verified_at} lang={lang} dateOnly />.{" "}
              {T("Подтверждение доказывает доступ к почте, но не личность.", "Confirmation proves access to the mailbox, not identity.")}
            </p>
          ) : mail ? (
            <>
              <p className="small muted">
                {T(
                  "Подтверждённый email нужен для оплаты членства и восстановления доступа.",
                  "A confirmed email is needed for membership payments and account recovery.",
                )}
              </p>
              <ActionForm action="auth.verify_request" lang={lang} back={`${back}#email`}>
                <button className="btn btn-ghost btn-sm">{T("Отправить письмо для подтверждения", "Send a confirmation email")}</button>
              </ActionForm>
            </>
          ) : (
            <p className="small muted">
              {T(
                "Отправка писем пока не подключена, поэтому подтвердить email сейчас нельзя. Остальные функции портала работают.",
                "Email delivery is not connected yet, so the address cannot be confirmed right now. Everything else on the portal works.",
              )}
            </p>
          )}
        </div>
      </section>

      <section className="section-tight">
        <h2 className="h3">{d.settings.games}</h2>
        <p className="small muted">{d.settings.gamesNote}</p>
        {accounts.length ? (
          <ul className="list">
            {accounts.map((a) => (
              <li key={a.game}>
                <span className="grow">{gameBySlug(a.game)?.name ?? a.game}</span>
                <span className="mono">{a.handle}</span>
                <ActionForm action="account.game" lang={lang} back={back} hidden={{ game: a.game, handle: "" }}>
                  <button className="btn btn-ghost btn-xs">{d.organizer.remove}</button>
                </ActionForm>
              </li>
            ))}
          </ul>
        ) : null}
        <ActionForm action="account.game" lang={lang} back={back} className="inline-form">
          <select name="game" aria-label={d.teams.game}>
            {GAMES.map((g) => (
              <option key={g.slug} value={g.slug}>
                {g.name}
              </option>
            ))}
          </select>
          <input name="handle" required maxLength={60} placeholder={d.settings.handle} aria-label={d.settings.handle} />
          <button className="btn btn-ghost btn-sm">{d.common.save}</button>
        </ActionForm>
      </section>

      <section className="section-tight">
        <h2 className="h3">{d.settings.security}</h2>
        <ActionForm action="account.password" lang={lang} back={back} className="card form-card">
          <Field label={d.settings.currentPassword}>
            <input name="current" type="password" required autoComplete="current-password" />
          </Field>
          <Field label={d.settings.newPassword} hint={d.auth.password}>
            <input name="password" type="password" required minLength={10} autoComplete="new-password" />
          </Field>
          <button className="btn btn-primary">{d.settings.changePassword}</button>
        </ActionForm>
        {isStaff(user) ? (
          <p className="small">
            <Link href={`/${lang}/admin/security`} className="text-link">
              {T("Второй фактор входа для сотрудников", "Staff second sign-in factor")}
            </Link>
          </p>
        ) : null}
        <h3 className="h4">{d.settings.sessions}</h3>
        <ul className="list">
          {sessions.map((s) => (
            <li key={s.id}>
              <span className="grow small">
                {s.user_agent.slice(0, 80) || "—"}
                {s.id === user.sessionId ? <strong> · {d.settings.thisSession}</strong> : null}
              </span>
              <span className="small muted">
                {d.settings.lastSeen}: <LocalTime iso={s.last_seen_at} lang={lang} withZone={false} />
              </span>
              {s.id !== user.sessionId ? (
                <ActionForm action="account.session" lang={lang} back={back} hidden={{ session: s.id }}>
                  <button className="btn btn-ghost btn-xs">{d.settings.revoke}</button>
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
        {sessions.length > 1 ? (
          <ActionForm action="account.session" lang={lang} back={back} hidden={{ session: "others" }}>
            <button className="btn btn-ghost btn-sm">{d.settings.revokeOthers}</button>
          </ActionForm>
        ) : null}
      </section>

      <section className="section-tight" id="consents">
        <h2 className="h3">{T("Согласия", "Consents")}</h2>
        {!termsCurrent ? (
          <div className="notice notice-warn">
            <p>
              {T("Опубликована новая редакция условий и уведомления о конфиденциальности.", "A new version of the terms and privacy notice has been published.")}{" "}
              <Link href={`/${lang}/terms`} className="text-link">
                {T("Условия", "Terms")}
              </Link>{" "}
              ·{" "}
              <Link href={`/${lang}/privacy`} className="text-link">
                {T("Конфиденциальность", "Privacy")}
              </Link>
            </p>
            <ActionForm action="account.accept_terms" lang={lang} back={`${back}#consents`}>
              <button className="btn btn-primary btn-sm">{T("Принять новую редакцию", "Accept the new version")}</button>
            </ActionForm>
          </div>
        ) : null}
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{T("Документ", "Document")}</th>
                <th>{T("Версия", "Version")}</th>
                <th>{T("Статус", "Status")}</th>
              </tr>
            </thead>
            <tbody>
              {consentRows.map(([kind, label]) => {
                const c = consents[kind];
                return (
                  <tr key={kind}>
                    <td>{label}</td>
                    <td className="mono small">{c?.version ?? "—"}</td>
                    <td>
                      {c ? c.granted ? <Badge status="ok">{T("Дано", "Given")}</Badge> : <Badge status="muted">{T("Не дано", "Not given")}</Badge> : "—"}
                      {c ? (
                        <div className="small muted">
                          <LocalTime iso={c.created_at} lang={lang} dateOnly />
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <ActionForm action="account.marketing" lang={lang} back={`${back}#consents`} hidden={{ optIn: marketingOn ? "0" : "1" }} className="row">
          <span className="small grow">
            {marketingOn
              ? T("Вы согласились получать новости и анонсы турниров.", "You agreed to receive news and tournament announcements.")
              : T("Новости и анонсы турниров вам не отправляются.", "You do not receive news or tournament announcements.")}
          </span>
          <button className="btn btn-ghost btn-sm">{marketingOn ? T("Отказаться от рассылок", "Unsubscribe") : T("Подписаться на рассылки", "Subscribe")}</button>
        </ActionForm>
      </section>

      <section className="section-tight" id="privacy">
        <h2 className="h3">{d.settings.privacy}</h2>
        <p>
          <a href="/api/account/export" className="btn btn-ghost btn-sm">
            {d.settings.export}
          </a>
        </p>
        <details className="disclosure danger-zone">
          <summary>{d.settings.delete}</summary>
          <p className="small muted">{d.settings.deleteNote}</p>
          <p className="small muted">
            {T(
              "Незавершённые заявки на членство будут отозваны, неоплаченные счета аннулированы, членство прекращено. Монеты и XP прекращаются вместе с аккаунтом.",
              "Open membership applications will be withdrawn, unpaid invoices voided and any membership ended. Coins and XP end with the account.",
            )}
          </p>
          <ActionForm action="account.delete" lang={lang} back={back} className="inline-form">
            <input name="password" type="password" required placeholder={d.settings.deleteConfirm} aria-label={d.settings.deleteConfirm} autoComplete="current-password" />
            <button className="btn btn-danger btn-sm">{d.settings.delete}</button>
          </ActionForm>
        </details>
      </section>
    </div>
  );
}
