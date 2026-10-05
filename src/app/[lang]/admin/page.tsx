import { OperationsDashboard, OperationsTournaments, OperationsUser, OperationsGames, OperationsApplications, OperationsAudit, OperationsSponsors } from "@/components/admin-operations";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, fill, isLocale, type Locale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import {
  applicationStatus,
  attemptStatus,
  challengeStatus,
  invoiceStatus,
  membershipStatus,
  missingLabel,
  offerStatus,
  readinessReason,
} from "@/lib/labels.ts";
import { viewer } from "@/server/viewer.ts";
import { adminDisputes, adminOverview, adminUsers } from "@/server/queries.ts";
import { isAdmin, isStaff } from "@/server/access.ts";
import { MFA_SESSION_HOURS, mfaStatus, secretEncryption, staffMfaOverview } from "@/server/mfa.ts";
import { adminBilling, CURRENCIES, formatMoney, missingFields, offers as allOffers, paymentReadiness, publicOffer, type Offer } from "@/server/billing.ts";
import { mailConfigured, mailTransport, outboxSummary } from "@/server/mail.ts";
import { disputedChallenges } from "@/server/challenges.ts";
import type { Database } from "@/server/db.ts";
import type { SessionUser } from "@/server/auth.ts";
import { ActionForm, Badge, DbDown, Empty, Field, Flash, one, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";
import { ConductTab } from "@/components/conduct-admin";
import { SocialAdmin } from "@/components/social-admin";
import { RentalAdmin } from "@/components/rental-admin";
import { P2pAdmin } from "@/components/p2p-admin";
import { StatsAdmin } from "@/components/stats-admin";
import { MessagesTab } from "@/components/messages-admin";
import { SystemTab } from "@/components/system-admin";
import { sectionsFor, STAFF_ROLES } from "@/server/staff-roles.ts";
import { roleNames } from "@/lib/staff-text.ts";
import { recordStaffSearch } from "@/server/admin.ts";
import { VenuesTab } from "@/components/venues-admin";
import { CommunityHostsAdmin, CommunityReportsAdmin } from "@/components/community-admin";
import { AcademyTab } from "@/components/academy-admin";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "admin", dict(lang).admin.title, undefined, { noindex: true });
}

const TABS = [
  "overview",
  "users",
  "disputes",
  "challenges",
  "conduct",
  "applications",
  "venues",
  "academy",
  "memberships",
  "offers",
  "payments",
  "outbox",
  "messages",
  "tournaments",
  "games",
  "sponsors",
  "system",
  "security",
  "audit",
] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS: Record<Tab, { ru: string; en: string }> = {
  games: {ru:"Каталог игр",en:"Games catalog"},
  overview: { ru: "Обзор", en: "Overview" },
  users: { ru: "Пользователи", en: "Users" },
  disputes: { ru: "Споры матчей", en: "Match disputes" },
  challenges: { ru: "Споры вызовов", en: "Challenge disputes" },
  conduct: { ru: "Честная игра", en: "Fair play" },
  applications: { ru: "Обращения", en: "Inquiries" },
  venues: { ru: "Площадки", en: "Venues" },
  academy: { ru: "Тренеры и поддержка", en: "Coaches & support" },
  memberships: { ru: "Членство", en: "Membership" },
  offers: { ru: "Предложения", en: "Offers" },
  payments: { ru: "Оплаты", en: "Payments" },
  outbox: { ru: "Письма", en: "Email" },
  messages: { ru: "Сообщения", en: "Messages" },
  system: { ru: "Система", en: "System" },
  tournaments: { ru: "Турниры", en: "Tournaments" },
  sponsors: { ru: "Спонсоры", en: "Sponsors" },
  security: { ru: "Безопасность", en: "Security" },
  audit: { ru: "Журнал", en: "Audit log" },
};

const COUNT_LABELS: Record<string, { ru: string; en: string; tab?: Tab }> = {
  pending_scores: { ru: "Результаты leaderboard на проверке", en: "Leaderboard results in review", tab: "tournaments" },
  disputed_challenges: { ru: "Споры по вызовам", en: "Disputed challenges", tab: "challenges" },
  membership_queue: { ru: "Заявки на членство", en: "Membership applications", tab: "memberships" },
  open_invoices: { ru: "Неоплаченные счета", en: "Open invoices", tab: "payments" },
  active_memberships: { ru: "Действующие членства", en: "Active memberships", tab: "memberships" },
  mail_queue: { ru: "Письма в очереди", en: "Emails queued", tab: "outbox" },
  open_disputes: { ru: "Открытые споры матчей", en: "Open match disputes", tab: "disputes" },
  new_applications: { ru: "Новые обращения", en: "New inquiries", tab: "applications" },
  conduct_reports: { ru: "Жалобы на нарушения", en: "Violation reports", tab: "conduct" },
  conduct_appeals: { ru: "Апелляции на санкции", en: "Sanction appeals", tab: "conduct" },
  transfer_disputes: { ru: "Споры о переходах", en: "Transfer disputes", tab: "conduct" },
  war_disputes: { ru: "Споры клановых войн", en: "Clan war disputes", tab: "conduct" },
  venue_reviews: { ru: "Площадки на проверке", en: "Venues in review", tab: "venues" },
  coach_reviews: { ru: "Тренеры на проверке", en: "Coaches in review", tab: "academy" },
};

export default async function Admin({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const a = d.admin;
  const ru = lang === "ru";
  const T = (x: string, y: string) => (ru ? x : y);
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user) redirect(`/${lang}/signin?next=/${lang}/admin`);
  if (!isStaff(user))
    return (
      <div className="container narrow page">
        <h1>{a.title}</h1>
        <p className="notice notice-warn">{a.forbidden}</p>
        <Link href={`/${lang}/admin/claim`} className="text-link">
          {a.claimTitle}
        </Link>
      </div>
    );
  // Each staff role opens only its sections (MV-STAFF-1); the server checks the section of every action again.
  const allowed = new Set<string>(sectionsFor(user.roles));
  const requested = one(sp.tab);
  const tab: Tab = (TABS as readonly string[]).includes(requested) && allowed.has(requested) ? (requested as Tab) : "overview";
  const back = `/${lang}/admin?tab=${tab}`;

  // Control-centre gate: an enrolled second factor, verified in this session within the window.
  const factor = await mfaStatus(db, user.id);
  if (!factor.enrolled) redirect(`/${lang}/admin/security`);
  if (!user.mfaAt || Date.now() - user.mfaAt.getTime() > MFA_SESSION_HOURS * 3600_000) redirect(`/${lang}/admin/mfa?next=${encodeURIComponent(back)}`);

  const admin = isAdmin(user);
  const ctx = { db, user, lang, back, admin, T, sp };
  let body: React.ReactNode = null;

  if (tab === "overview") {
    const counts = await adminOverview(db);
    const readiness = paymentReadiness(await publicOffer(db));
    const mail = mailConfigured();
    body = (
      <>
        <h2 className="h3">{T("Рабочая сводка", "Operations overview")}</h2>
        <dl className="stat-grid">
          {Object.entries(counts).map(([k, v]) => {
            const label = COUNT_LABELS[k];
            if (label?.tab && !allowed.has(label.tab)) return null;
            return (
              <div key={k}>
                <dt>{label ? (ru ? label.ru : label.en) : a.counts[k] ?? k}</dt>
                <dd>{label?.tab ? <Link href={`/${lang}/admin?tab=${label.tab}`}>{v}</Link> : v}</dd>
              </div>
            );
          })}
        </dl>
        <div className="grid grid-2 section-tight">
          {allowed.has("outbox") ? (
            <div className="card stack-sm">
              <p className="field-label">Email</p>
              <p>{mail ? <Badge status="ok">{T("Подключён", "Connected")}</Badge> : <Badge status="warn">{T("Не подключён", "Not connected")}</Badge>}</p>
              <Link href={`/${lang}/admin?tab=outbox`} className="text-link small">
                {T("Очередь писем", "Email queue")}
              </Link>
            </div>
          ) : null}
          {allowed.has("payments") ? (
            <div className="card stack-sm">
              <p className="field-label">{T("Приём оплат", "Payment collection")}</p>
              <p>{readiness.ready ? <Badge status="ok">{T("Готов", "Ready")}</Badge> : <Badge status="warn">{T("Выключен", "Off")}</Badge>}</p>
              <Link href={`/${lang}/admin?tab=payments`} className="text-link small">
                {T("Причины и настройки", "Reasons and settings")}
              </Link>
            </div>
          ) : null}
        </div>
        <OperationsDashboard {...ctx}/>
      </>
    );
  } else if (tab === "users") {
    body = one(sp.user) ? await OperationsUser(ctx) : await UsersTab(ctx);
  } else if (tab === "disputes") {
    const list = await adminDisputes(db);
    body = list.length ? (
      <ul className="list">
        {list.map((x) => (
          <li key={x.id}>
            <span className="grow">
              <Link href={`/${lang}/matches/${x.match_id}`}>{x.t_name}</Link>
              <span className="small muted">
                {" "}
                · @{x.opened_by} · <LocalTime iso={x.created_at} lang={lang} />
              </span>
              <div className="small prewrap">{x.reason === "conflicting_results" ? T("Стороны отправили разные результаты", "The sides submitted different results") : x.reason}</div>
            </span>
            <Link href={`/${lang}/matches/${x.match_id}`} className="btn btn-ghost btn-xs">
              {d.organizer.open}
            </Link>
          </li>
        ))}
      </ul>
    ) : (
      <Empty title={a.noDisputes} />
    );
  } else if (tab === "challenges") {
    const list = await disputedChallenges(db);
    body = list.length ? (
      <ul className="list">
        {list.map((c) => (
          <li key={c.id} className="stack-sm">
            <div className="row-between">
              <strong>
                @{c.challenger} {d.common.vs} @{c.opponent}
              </strong>
              <span className="small muted">
                {gameBySlug(c.game)?.name ?? c.game} · <LocalTime iso={c.created_at} lang={lang} />
              </span>
            </div>
            {c.resolution ? <p className="small prewrap">{c.resolution}</p> : null}
            <ActionForm action="challenge.resolve" lang={lang} back={back} hidden={{ challenge: c.id }} className="inline-form">
              <select name="winner" required aria-label={T("Решение", "Decision")}>
                <option value={c.challenger_id}>
                  {T("Победа", "Win for")} @{c.challenger}
                </option>
                <option value={c.opponent_id}>
                  {T("Победа", "Win for")} @{c.opponent}
                </option>
                <option value="void">{T("Аннулировать вызов", "Void the challenge")}</option>
              </select>
              <input name="note" required minLength={5} maxLength={600} placeholder={T("Обоснование", "Reasoning")} aria-label={T("Обоснование", "Reasoning")} />
              <button className="btn btn-primary btn-xs">{T("Решить", "Decide")}</button>
            </ActionForm>
            <p className="small muted">{challengeStatus("disputed", lang)}</p>
          </li>
        ))}
      </ul>
    ) : (
      <Empty title={T("Спорных вызовов нет.", "No disputed challenges.")} />
    );
  } else if (tab === "conduct") {
    body = <><CommunityReportsAdmin db={db} user={user} lang={lang} back={back} /><SocialAdmin db={db} user={user} lang={lang} back={back} /><ConductTab db={db} user={user} lang={lang} back={back} subject={one(sp.subject)} /></>;
  } else if (tab === "venues") {
    body = <VenuesTab db={db} lang={lang} back={back} />;
  } else if (tab === "academy") {
    body = <><CommunityHostsAdmin db={db} user={user} lang={lang} back={back} /><AcademyTab db={db} lang={lang} back={back} /></>;
  } else if (tab === "applications") {
    body = await OperationsApplications(ctx);
  } else if (tab === "memberships") {
    body = await MembershipsTab(ctx);
  } else if (tab === "offers") {
    body = await OffersTab(ctx);
  } else if (tab === "payments") {
    body = await PaymentsTab(ctx);
  } else if (tab === "outbox") {
    body = await OutboxTab(ctx);
  } else if (tab === "tournaments") {
    body = await OperationsTournaments(ctx);
  } else if (tab === "games") {
    body = await OperationsGames(ctx);
  } else if (tab === "sponsors") {
    body = await OperationsSponsors(ctx);
  } else if (tab === "messages") {
    body = <MessagesTab db={db} user={user} lang={lang} back={back} />;
  } else if (tab === "system") {
    body = <><RentalAdmin db={db} lang={lang} back={back} /><P2pAdmin db={db} lang={lang} back={back} /><StatsAdmin db={db} lang={lang} back={back} /><SystemTab db={db} user={user} lang={lang} back={back} /></>;
  } else if (tab === "security") {
    body = await SecurityTab(ctx);
  } else if (tab === "audit") {
    body = await OperationsAudit(ctx);
  }

  return (
    <div className="container page admin-shell">
      <div className="row-between">
        <h1>{a.title}</h1>
        <Link href={`/${lang}/admin/security`} className="text-link small">
          {T("Мой второй фактор", "My second factor")}
        </Link>
      </div>
      <Flash lang={lang} params={sp} />
      <div className="admin-layout">
      <nav className="admin-nav" aria-label={a.title}>
        {TABS.filter((k) => allowed.has(k)).map((k) => (
          <Link key={k} href={`/${lang}/admin?tab=${k}`} className={k === tab ? "admin-nav-link is-active" : "admin-nav-link"} aria-current={k === tab ? "page" : undefined}>
            {ru ? TAB_LABELS[k].ru : TAB_LABELS[k].en}
          </Link>
        ))}
      </nav>
      <div className="admin-main">
      <p className="small muted">
        {T(
          "Критичные действия (роли, блокировки, решения по заявкам, счета, возвраты, предложения) требуют свежего кода второго фактора, если с последнего прошло больше 15 минут.",
          "Critical actions (roles, suspensions, application decisions, invoices, refunds, offers) ask for a fresh second-factor code if the last one was more than 15 minutes ago.",
        )}
      </p>
      <section className="section-tight">{body}</section>
      </div></div>
    </div>
  );
}

type Ctx = {
  db: Database;
  user: SessionUser;
  lang: Locale;
  back: string;
  admin: boolean;
  T: (ru: string, en: string) => string;
  sp: Record<string, string | string[] | undefined>;
};

async function UsersTab({ db, user, lang, back, admin, sp }: Ctx) {
  const d = dict(lang);
  const a = d.admin;
  const q = one(sp.q).slice(0, 60);
  // A search over names and emails is recorded (the query, not the results): MV-STAFF-1.
  if (q) await recordStaffSearch(db, user, q);
  const users = await adminUsers(db, q);
  const backQ = back + (q ? `&q=${encodeURIComponent(q)}` : "");
  return (
    <>
      <form method="get" className="inline-form toolbar">
        <input type="hidden" name="tab" value="users" />
        <input name="q" defaultValue={q} placeholder={a.search} aria-label={a.search} />
        <button className="btn btn-ghost btn-sm">{d.common.search}</button>
      </form>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{d.players.title}</th>
              <th>Email</th>
              <th>{a.roles}</th>
              <th>{d.match.status}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  <Link href={`${back}&user=${encodeURIComponent(u.username)}`}>{u.display_name}</Link>
                  <div className="small muted">
                    @{u.username} · <LocalTime iso={u.created_at} lang={lang} dateOnly />
                  </div>
                </td>
                <td className="small">{u.email}</td>
                <td>
                  <div className="row">
                    {STAFF_ROLES.map((role) => {
                      const has = u.roles.includes(role);
                      return admin ? (
                        <ActionForm key={role} action="admin.role" lang={lang} back={backQ} hidden={{ user: u.id, role, grant: has ? "0" : "1" }}>
                          <button className={has ? "btn btn-primary btn-xs" : "btn btn-ghost btn-xs"} title={has ? a.revokeRole : a.grant}>
                            {roleNames[lang][role]}
                          </button>
                        </ActionForm>
                      ) : has ? (
                        <span key={role} className="badge badge-info">
                          {roleNames[lang][role]}
                        </span>
                      ) : null;
                    })}
                  </div>
                </td>
                <td>
                  <Badge status={u.status === "active" ? "works" : u.status === "pending" ? "warn" : "rejected"}>{u.status}</Badge>
                  {admin && u.id !== user.id && u.status !== "pending" ? (
                    u.status === "active" ? (
                      <details className="disclosure">
                        <summary>{a.suspend}</summary>
                        <ActionForm action="admin.user_status" lang={lang} back={backQ} hidden={{ user: u.id, status: "suspended" }} className="inline-form">
                          <input name="reason" required minLength={5} maxLength={300} placeholder={a.reason} aria-label={a.reason} />
                          <button className="btn btn-danger btn-xs">{a.suspend}</button>
                        </ActionForm>
                      </details>
                    ) : (
                      <ActionForm action="admin.user_status" lang={lang} back={backQ} hidden={{ user: u.id, status: "active", reason: "reinstated" }}>
                        <button className="btn btn-ghost btn-xs">{a.unsuspend}</button>
                      </ActionForm>
                    )
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const NEXT_APPLICATION_STATES: Record<string, string[]> = {
  submitted: ["under_review", "awaiting_info", "approved", "declined"],
  under_review: ["awaiting_info", "approved", "declined"],
  awaiting_info: ["under_review", "approved", "declined"],
};

async function MembershipsTab({ db, lang, back, admin, T }: Ctx) {
  const { applications, memberships, invoices } = await adminBilling(db);
  const openInvoiceFor = new Set(
    (await db.query<{ application_id: string }>("select application_id from invoices where status = 'open' and application_id is not null")).map((r) => r.application_id),
  );
  const paidFor = new Set(
    (await db.query<{ application_id: string }>("select application_id from invoices where status <> 'open' and status <> 'void' and application_id is not null")).map(
      (r) => r.application_id,
    ),
  );
  return (
    <div className="stack">
      <section>
        <h2 className="h3">{T("Заявки на членство", "Membership applications")}</h2>
        <p className="small muted">
          {T(
            "Решение фиксируется с автором, временем и обоснованием. Одобрение не означает оплату, а оплата не означает одобрения.",
            "Each decision is recorded with who made it, when and why. Approval is not payment, and payment is not approval.",
          )}
        </p>
        {applications.length ? (
          <ul className="list">
            {applications.map((x) => (
              <li key={x.id} className="stack-sm">
                <div className="row-between">
                  <span>
                    <strong className="mono">{x.reference}</strong> · @{x.username} · <span className="small muted">{x.email}</span>
                  </span>
                  <Badge status={x.status}>{applicationStatus(x.status, lang)}</Badge>
                </div>
                <span className="small muted">
                  {x.code}@{x.version} · <LocalTime iso={x.created_at} lang={lang} />
                  {x.decision_note ? ` · ${x.decision_note}` : ""}
                </span>
                {x.objective ? <p className="small prewrap">{x.objective}</p> : null}
                {NEXT_APPLICATION_STATES[x.status] ? (
                  <ActionForm action="billing.decide" lang={lang} back={back} hidden={{ application: x.id }} className="inline-form">
                    <select name="status" aria-label={T("Новый статус", "New status")}>
                      {NEXT_APPLICATION_STATES[x.status].map((s) => (
                        <option key={s} value={s}>
                          {applicationStatus(s, lang)}
                        </option>
                      ))}
                    </select>
                    <input name="note" maxLength={1000} placeholder={T("Обоснование (обязательно для одобрения и отказа)", "Reasoning (required to approve or decline)")} aria-label={T("Обоснование", "Reasoning")} />
                    <button className="btn btn-primary btn-xs">{T("Сохранить решение", "Record decision")}</button>
                  </ActionForm>
                ) : null}
                {x.status === "approved" && admin && !openInvoiceFor.has(x.id) && !paidFor.has(x.id) ? (
                  <ActionForm action="billing.invoice" lang={lang} back={back} hidden={{ application: x.id }}>
                    <button className="btn btn-ghost btn-xs">{T("Выставить счёт", "Issue invoice")}</button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={T("Заявок нет.", "No applications.")} />
        )}
      </section>

      <section>
        <h2 className="h3">{T("Членства", "Memberships")}</h2>
        {memberships.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{T("Участник", "Member")}</th>
                  <th>{T("Статус", "Status")}</th>
                  <th>{T("Срок", "Term")}</th>
                  <th>{admin ? T("Изменить", "Change") : ""}</th>
                </tr>
              </thead>
              <tbody>
                {memberships.map((m) => (
                  <tr key={m.id}>
                    <td>@{m.username}</td>
                    <td>
                      <Badge status={m.status}>{membershipStatus(m.status, lang)}</Badge>
                      {m.status_reason ? <div className="small muted">{m.status_reason}</div> : null}
                    </td>
                    <td className="small">
                      {m.starts_at ? <LocalTime iso={m.starts_at} lang={lang} dateOnly /> : "—"} — {m.ends_at ? <LocalTime iso={m.ends_at} lang={lang} dateOnly /> : "—"}
                    </td>
                    <td>
                      {admin && m.status !== "pending" ? (
                        <details className="disclosure">
                          <summary>{T("Изменить", "Change")}</summary>
                          <ActionForm action="membership.set" lang={lang} back={back} hidden={{ membership: m.id }} className="stack-sm">
                            <select name="status" defaultValue={m.status} aria-label={T("Статус", "Status")}>
                              {["active", "suspended", "ended"].map((s) => (
                                <option key={s} value={s}>
                                  {membershipStatus(s, lang)}
                                </option>
                              ))}
                            </select>
                            <input type="date" name="endsAt" aria-label={T("Новая дата окончания", "New end date")} />
                            <input name="reason" required minLength={3} maxLength={300} placeholder={T("Причина", "Reason")} aria-label={T("Причина", "Reason")} />
                            <button className="btn btn-primary btn-xs">{T("Сохранить", "Save")}</button>
                          </ActionForm>
                        </details>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={T("Членств нет.", "No memberships.")} />
        )}
        <p className="small muted">
          {T("Счетов всего", "Invoices in total")}: {invoices.length}.{" "}
          <Link href={`/${lang}/admin?tab=payments`} className="text-link">
            {T("Оплаты", "Payments")}
          </Link>
        </p>
      </section>
    </div>
  );
}

async function OffersTab({ db, lang, back, admin, T }: Ctx) {
  const list = await allOffers(db);
  const latest = list.find((o) => o.code === "vegas-membership") ?? list[0];
  const text = (o: Offer | undefined, k: "terms_text" | "refund_text", l: Locale) => (o?.[k] ? o[k]![l] : "");
  return (
    <div className="stack">
      <p className="notice">
        {T(
          "Коммерческие условия вносит и утверждает администратор. Пустое поле — это «не предоставлено»: такое предложение нельзя утвердить, и счёт по нему не выставляется. Утверждение требует ссылки на основание (например, номер решения).",
          "Commercial terms are entered and approved by an administrator. An empty field means NOT PROVIDED: such an offer cannot be approved and no invoice can be issued on it. Approval requires a reference to its basis (for example, a decision number).",
        )}
      </p>
      {list.map((o) => {
        const missing = missingFields(o);
        return (
          <article key={o.id} className="card stack-sm">
            <div className="row-between">
              <strong>
                {o.title[lang]} <span className="mono small muted">{`${o.code}@${o.version}`}</span>
              </strong>
              <Badge status={o.status}>{offerStatus(o.status, lang)}</Badge>
            </div>
            <dl className="kv">
              <div>
                <dt>{T("Цена", "Price")}</dt>
                <dd>{o.price_minor !== null && o.currency ? formatMoney(o.price_minor, o.currency, lang) : "NOT PROVIDED"}</dd>
              </div>
              <div>
                <dt>{T("Срок", "Term")}</dt>
                <dd>{o.duration_days ? `${o.duration_days} ${T("дн.", "days")}` : "NOT PROVIDED"}</dd>
              </div>
              <div>
                <dt>{T("Налоговый режим", "Tax treatment")}</dt>
                <dd>{o.tax_treatment ?? "NOT PROVIDED"}</dd>
              </div>
              <div>
                <dt>{T("Получатель", "Recipient")}</dt>
                <dd>{o.legal_recipient}</dd>
              </div>
              <div>
                <dt>{T("Порядок", "Admission")}</dt>
                <dd>{o.admission === "self_service" ? T("Без рассмотрения", "Self-service") : T("С рассмотрением", "Reviewed")}</dd>
              </div>
              <div>
                <dt>{T("Основание", "Approval")}</dt>
                <dd>{o.approval_ref ?? "—"}</dd>
              </div>
            </dl>
            {missing.length ? (
              <p className="small warn-text">
                {T("Не предоставлено", "Not provided")}: {missing.map((m) => missingLabel(m, lang)).join(", ")}
              </p>
            ) : null}
            {admin && o.status === "proposed" ? (
              <ActionForm action="offer.approve" lang={lang} back={back} hidden={{ offer: o.id }} className="inline-form">
                <input name="approvalRef" required minLength={3} maxLength={200} placeholder={T("Основание утверждения", "Approval reference")} aria-label={T("Основание утверждения", "Approval reference")} />
                <button className="btn btn-primary btn-xs">{T("Утвердить", "Approve")}</button>
              </ActionForm>
            ) : null}
            {admin && o.status !== "retired" ? (
              <ActionForm action="offer.retire" lang={lang} back={back} hidden={{ offer: o.id }}>
                <button className="btn btn-ghost btn-xs">{T("Вывести из действия", "Retire")}</button>
              </ActionForm>
            ) : null}
          </article>
        );
      })}

      {admin ? (
        <details className="disclosure card">
          <summary>{T("Новая версия предложения", "New offer version")}</summary>
          <ActionForm action="offer.create" lang={lang} back={back} className="stack">
            <div className="form-grid">
              <Field label={T("Код", "Code")}>
                <input name="code" required pattern="(?:[a-z0-9]|-){3,40}" defaultValue={latest?.code ?? "vegas-membership"} />
              </Field>
              <Field label={T("Вид", "Kind")}>
                <select name="kind" defaultValue={latest?.kind ?? "membership"}>
                  <option value="membership">membership</option>
                  <option value="pass_premium">pass_premium</option>
                </select>
              </Field>
              <Field label={T("Порядок", "Admission")}>
                <select name="admission" defaultValue={latest?.admission ?? "review"}>
                  <option value="review">{T("С рассмотрением", "Reviewed")}</option>
                  <option value="self_service">{T("Без рассмотрения", "Self-service")}</option>
                </select>
              </Field>
            </div>
            <div className="form-grid">
              <Field label={T("Название (RU)", "Title (RU)")}>
                <input name="titleRu" required maxLength={120} defaultValue={latest?.title.ru} />
              </Field>
              <Field label={T("Название (EN)", "Title (EN)")}>
                <input name="titleEn" required maxLength={120} defaultValue={latest?.title.en} />
              </Field>
            </div>
            <div className="form-grid">
              <Field label={T("Что входит (RU), по строке", "Included (RU), one per line")}>
                <textarea name="benefitsRu" rows={3} defaultValue={latest?.benefits.ru.join("\n")} />
              </Field>
              <Field label={T("Что входит (EN), по строке", "Included (EN), one per line")}>
                <textarea name="benefitsEn" rows={3} defaultValue={latest?.benefits.en.join("\n")} />
              </Field>
              <Field label={T("Что не входит (RU)", "Excluded (RU)")}>
                <textarea name="exclusionsRu" rows={3} defaultValue={latest?.exclusions.ru.join("\n")} />
              </Field>
              <Field label={T("Что не входит (EN)", "Excluded (EN)")}>
                <textarea name="exclusionsEn" rows={3} defaultValue={latest?.exclusions.en.join("\n")} />
              </Field>
            </div>
            <div className="form-grid-4">
              <Field label={T("Цена", "Price")} hint={T("например 99.00", "e.g. 99.00")}>
                <input name="price" inputMode="decimal" maxLength={20} placeholder="NOT PROVIDED" />
              </Field>
              <Field label={T("Валюта", "Currency")}>
                <select name="currency" defaultValue={latest?.currency ?? ""}>
                  <option value="">NOT PROVIDED</option>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={T("Срок, дней", "Term, days")}>
                <input name="durationDays" type="number" min={1} max={1100} defaultValue={latest?.duration_days ?? undefined} placeholder="NOT PROVIDED" />
              </Field>
              <Field label={T("Налоговый режим", "Tax treatment")}>
                <input name="taxTreatment" maxLength={300} defaultValue={latest?.tax_treatment ?? ""} placeholder="NOT PROVIDED" />
              </Field>
            </div>
            <div className="form-grid">
              <Field label={T("Условия членства (RU)", "Membership terms (RU)")}>
                <textarea name="termsRu" rows={5} defaultValue={text(latest, "terms_text", "ru")} />
              </Field>
              <Field label={T("Условия членства (EN)", "Membership terms (EN)")}>
                <textarea name="termsEn" rows={5} defaultValue={text(latest, "terms_text", "en")} />
              </Field>
              <Field label={T("Отмена и возврат (RU)", "Cancellation and refunds (RU)")}>
                <textarea name="refundRu" rows={5} defaultValue={text(latest, "refund_text", "ru")} />
              </Field>
              <Field label={T("Отмена и возврат (EN)", "Cancellation and refunds (EN)")}>
                <textarea name="refundEn" rows={5} defaultValue={text(latest, "refund_text", "en")} />
              </Field>
            </div>
            <p className="small muted">
              {T("Получатель платежа фиксирован", "The payment recipient is fixed")}: MAXIMUS VEGAS L.L.C-FZ.{" "}
              {T("Новая версия создаётся как «предложено» и не влияет на выставленные счета.", "A new version starts as proposed and does not affect invoices already issued.")}
            </p>
            <button className="btn btn-primary">{T("Создать версию", "Create version")}</button>
          </ActionForm>
        </details>
      ) : null}
    </div>
  );
}

async function PaymentsTab({ db, lang, back, admin, T }: Ctx) {
  const offer = await publicOffer(db);
  const readiness = paymentReadiness(offer);
  const { invoices, events } = await adminBilling(db);
  const attempts = await db.query<{ id: string; number: string; status: string; mode: string; provider: string; amount_minor: string; currency: string; created_at: Date; updated_at: Date }>(
    `select a.id, i.number, a.status, a.mode, a.provider, a.amount_minor, a.currency, a.created_at, a.updated_at
       from payment_attempts a join invoices i on i.id = a.invoice_id order by a.created_at desc limit 50`,
  );
  const refunds = process.env.PAYMENTS_ALLOW_REFUNDS === "1";
  return (
    <div className="stack">
      <section className="card stack-sm">
        <div className="row-between">
          <h2 className="h4">{T("Готовность приёма оплат", "Payment readiness")}</h2>
          {readiness.ready ? <Badge status="ok">{T("Готово", "Ready")}</Badge> : <Badge status="warn">{T("Оплата выключена", "Payments off")}</Badge>}
        </div>
        <p className="small muted">
          {T("Провайдер", "Provider")}: {readiness.provider ?? "—"} · {T("режим ключа", "key mode")}: {readiness.mode ?? "—"} · {T("предложение", "offer")}:{" "}
          {offer ? `${offer.code}@${offer.version} — ${offerStatus(offer.status, lang).toLowerCase()}` : "—"}
        </p>
        {readiness.reasons.length ? (
          <ul className="bullets small">
            {readiness.reasons.map((r) => (
              <li key={r}>{readinessReason(r, lang)}</li>
            ))}
          </ul>
        ) : null}
        <p className="small muted">
          {T(
            "Оплата включается только когда все условия выполнены. Статус «оплачено» ставится только по подписанному webhook или прямой проверке у провайдера, никогда по возврату браузера.",
            "Collection turns on only when every condition is met. An invoice is marked paid only from a signed webhook or a direct check with the provider, never from a browser return.",
          )}
        </p>
      </section>

      <section>
        <h2 className="h3">{T("Счета", "Invoices")}</h2>
        {invoices.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{T("Номер", "Number")}</th>
                  <th>{T("Участник", "Member")}</th>
                  <th>{T("Сумма", "Amount")}</th>
                  <th>{T("Статус", "Status")}</th>
                  <th>{T("Действия", "Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <Link href={`/${lang}/billing/invoices/${i.number}`} className="text-link mono">
                        {i.number}
                      </Link>
                      <div className="small muted">
                        <LocalTime iso={i.created_at} lang={lang} dateOnly />
                      </div>
                    </td>
                    <td>@{i.username}</td>
                    <td>
                      {formatMoney(i.amount_minor, i.currency, lang)}
                      {Number(i.refunded_minor) > 0 ? (
                        <div className="small muted">
                          {T("возвращено", "refunded")} {formatMoney(i.refunded_minor, i.currency, lang)}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <Badge status={i.status}>{invoiceStatus(i.status, lang)}</Badge>
                    </td>
                    <td>
                      {admin && i.status === "open" ? (
                        <details className="disclosure">
                          <summary>{T("Аннулировать", "Void")}</summary>
                          <ActionForm action="billing.void" lang={lang} back={back} hidden={{ invoice: i.id }} className="inline-form">
                            <input name="reason" required minLength={3} maxLength={300} placeholder={T("Причина", "Reason")} aria-label={T("Причина", "Reason")} />
                            <button className="btn btn-danger btn-xs">{T("Аннулировать", "Void")}</button>
                          </ActionForm>
                        </details>
                      ) : null}
                      {admin && ["paid", "partially_refunded"].includes(i.status) ? (
                        refunds ? (
                          <details className="disclosure">
                            <summary>{T("Возврат", "Refund")}</summary>
                            <ActionForm action="billing.refund" lang={lang} back={back} hidden={{ invoice: i.id }} className="inline-form">
                              <input name="amount" inputMode="decimal" maxLength={20} placeholder={T("Сумма (пусто — остаток)", "Amount (empty = remaining)")} aria-label={T("Сумма", "Amount")} />
                              <button className="btn btn-danger btn-xs">{T("Запросить возврат", "Request refund")}</button>
                            </ActionForm>
                          </details>
                        ) : (
                          <span className="small muted">{T("Возвраты через портал выключены", "Portal refunds off")}</span>
                        )
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={T("Счетов нет.", "No invoices.")} />
        )}
      </section>

      <section>
        <h2 className="h3">{T("Попытки оплаты", "Payment attempts")}</h2>
        {attempts.length ? (
          <ul className="list">
            {attempts.map((x) => (
              <li key={x.id}>
                <span className="grow small">
                  <span className="mono">{x.number}</span> · {formatMoney(x.amount_minor, x.currency, lang)} · {x.provider} {x.mode} · <LocalTime iso={x.created_at} lang={lang} />
                </span>
                <Badge status={x.status}>{attemptStatus(x.status, lang)}</Badge>
                {["open", "processing"].includes(x.status) ? (
                  <ActionForm action="billing.reconcile" lang={lang} back={back} hidden={{ attempt: x.id }}>
                    <button className="btn btn-ghost btn-xs">{T("Сверить с провайдером", "Check with provider")}</button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">{T("Попыток оплаты не было.", "No payment attempts yet.")}</p>
        )}
      </section>

      <section>
        <h2 className="h3">{T("События провайдера", "Provider events")}</h2>
        {events.length ? (
          <div className="table-wrap">
            <table className="table small">
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{e.id.slice(0, 18)}…</td>
                    <td className="mono">{e.type}</td>
                    <td>
                      <Badge status={e.status === "processed" ? "ok" : e.status === "failed" ? "bad" : "muted"}>{e.status}</Badge>
                    </td>
                    <td>{e.livemode ? "live" : "test"}</td>
                    <td>
                      <LocalTime iso={e.received_at} lang={lang} />
                    </td>
                    <td className="muted">{e.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small">{T("Событий не было.", "No events yet.")}</p>
        )}
      </section>
    </div>
  );
}

async function OutboxTab({ db, lang, back, T }: Ctx) {
  const [summary, rows] = await Promise.all([
    outboxSummary(db),
    db.query<{ id: string; to_email: string; template: string; lang: string; status: string; attempts: number; last_error: string; created_at: Date; sent_at: Date | null }>(
      "select id, to_email, template, lang, status, attempts, last_error, created_at, sent_at from email_outbox order by created_at desc limit 60",
    ),
  ]);
  const transport = mailTransport();
  return (
    <div className="stack">
      <section className="card stack-sm">
        <div className="row-between">
          <h2 className="h4">{T("Доставка email", "Email delivery")}</h2>
          {transport ? <Badge status="ok">{transport.name}</Badge> : <Badge status="warn">{T("Не подключена", "Not connected")}</Badge>}
        </div>
        <p className="small muted">
          {T(
            "Письмо сначала сохраняется в очереди вместе с действием, затем отправляется с повторами. «Отправлено» значит, что сервис принял письмо — это не доказательство доставки во входящие.",
            "A message is first stored in the queue together with the action, then sent with retries. “Sent” means the service accepted it — not proof it reached the inbox.",
          )}
        </p>
        <dl className="stat-row">
          {["pending", "sending", "failed", "sent", "cancelled"].map((s) => (
            <div key={s}>
              <dt>{s}</dt>
              <dd>{summary[s] ?? 0}</dd>
            </div>
          ))}
        </dl>
        <ActionForm action="outbox.drain" lang={lang} back={back}>
          <button className="btn btn-ghost btn-sm">{T("Обработать очередь сейчас", "Process the queue now")}</button>
        </ActionForm>
      </section>
      {rows.length ? (
        <div className="table-wrap">
          <table className="table small">
            <thead>
              <tr>
                <th>{T("Создано", "Created")}</th>
                <th>{T("Кому", "To")}</th>
                <th>{T("Шаблон", "Template")}</th>
                <th>{T("Статус", "Status")}</th>
                <th>{T("Ошибка", "Error")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <LocalTime iso={r.created_at} lang={lang} />
                  </td>
                  <td>{r.to_email}</td>
                  <td className="mono">
                    {r.template} · {r.lang}
                  </td>
                  <td>
                    <Badge status={r.status === "sent" ? "ok" : r.status === "failed" ? "bad" : "muted"}>{r.status}</Badge> {r.attempts ? `×${r.attempts}` : ""}
                  </td>
                  <td className="muted">{r.last_error.slice(0, 120)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title={T("Писем в очереди нет.", "No emails queued.")} />
      )}
    </div>
  );
}

async function SecurityTab({ db, user, lang, back, admin, T }: Ctx) {
  const staff = await staffMfaOverview(db);
  const encryption = secretEncryption();
  return (
    <div className="stack">
      <section className="card stack-sm">
        <h2 className="h4">{T("Второй фактор сотрудников", "Staff second factor")}</h2>
        <p className="small muted">
          {T(
            "Вход в центр управления требует кода из приложения-аутентификатора (TOTP), подтверждённого в текущей сессии не ранее чем 12 часов назад.",
            "The control centre requires an authenticator app code (TOTP) verified in the current session within the last 12 hours.",
          )}
        </p>
        <p className="small">
          {T("Хранение секретов", "Secret storage")}:{" "}
          {encryption === "aes-256-gcm" ? (
            <Badge status="ok">AES-256-GCM</Badge>
          ) : (
            <Badge status="warn">{T("без шифрования — задайте MFA_SECRET_KEY", "unencrypted — set MFA_SECRET_KEY")}</Badge>
          )}
        </p>
      </section>
      <ul className="list">
        {staff.map((s) => (
          <li key={s.id}>
            <span className="grow">
              @{s.username} <span className="small muted">· {s.roles.join(", ")}</span>
            </span>
            <Badge status={s.enrolled ? "ok" : "warn"}>{s.enrolled ? T("Подключён", "Enrolled") : T("Не подключён", "Not enrolled")}</Badge>
            {admin && s.id !== user.id && s.enrolled ? (
              <details className="disclosure">
                <summary>{T("Сбросить", "Reset")}</summary>
                <p className="small muted">{T("Сотрудник заново подключит фактор при следующем входе в центр управления.", "The colleague re-enrols on their next visit to the control centre.")}</p>
                <ActionForm action="mfa.reset" lang={lang} back={back} hidden={{ user: s.id }}>
                  <button className="btn btn-danger btn-xs">{T("Сбросить второй фактор", "Reset second factor")}</button>
                </ActionForm>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
