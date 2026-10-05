import Link from "next/link";
import { dict, type Locale } from "@/lib/i18n.ts";
import { trustText } from "@/lib/conduct-text.ts";
import {
  gameModeLabel,
  gameRosterLabel,
  gameFormatsLabel,
  formatLabels,
} from "@/lib/catalog-labels.ts";
import type { Database } from "@/server/db.ts";
import type { SessionUser } from "@/server/auth.ts";
import { canStaff } from "@/server/access.ts";
import {
  listGames,
  GAME_MODES,
  CATALOG_FORMATS,
  type CatalogGame,
} from "@/server/catalog.ts";
import {
  searchEvents,
  staffProfile,
  searchApplications,
  searchDecisions,
  trustDashboard,
} from "@/server/admin-operations.ts";
import { verifyAuditChain } from "@/server/audit.ts";
import { publicCount } from "@/server/conduct.ts";
import { trustStats, getTournament } from "@/server/queries.ts";
import {
  STATUSES,
  FORMATS,
  allowedTransitions,
  type TournamentStatus,
} from "@/server/tournaments.ts";
import { listCircuits } from "@/server/circuits.ts";
import { SPONSOR_TIERS, type SponsorRow } from "@/server/sponsors.ts";
import { ActionForm, Badge, Check as UiCheck, Empty, Field, one } from "./ui";
import { LocalTime } from "./time";
import { TournamentForm } from "./tournament-form";

function Check({
  children,
  ...props
}: {
  children: React.ReactNode;
  name: string;
  value?: string;
  defaultChecked?: boolean;
}) {
  return <UiCheck {...props} label={children} />;
}
export type OperationsContext = {
  db: Database;
  user: SessionUser;
  lang: Locale;
  back: string;
  admin: boolean;
  sp: Record<string, string | string[] | undefined>;
};
const textOf = (lang: Locale) => (ru: string, en: string) =>
  lang === "ru" ? ru : en;
const inputOf = (sp: OperationsContext["sp"]) =>
  Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, one(v)]));
function PageLinks({
  ctx,
  page,
  total,
}: {
  ctx: OperationsContext;
  page: number;
  total: number;
}) {
  const T = textOf(ctx.lang),
    url = (p: number) => {
      const q = new URLSearchParams(inputOf(ctx.sp));
      q.set("page", String(p));
      return `/${ctx.lang}/admin?${q}`;
    };
  return (
    <nav className="row" aria-label={T("Страницы результатов", "Result pages")}>
      <span className="small muted">
        {T("Найдено", "Found")}: {total} · {T("Страница", "Page")} {page}
      </span>
      {page > 1 ? (
        <Link className="btn btn-ghost btn-sm" href={url(page - 1)}>
          {T("Назад", "Previous")}
        </Link>
      ) : null}
      {page * 40 < total ? (
        <Link className="btn btn-ghost btn-sm" href={url(page + 1)}>
          {T("Далее", "Next")}
        </Link>
      ) : null}
    </nav>
  );
}
export async function OperationsDashboard(ctx: OperationsContext) {
  const { db, user, lang } = ctx,
    T = textOf(lang),
    d = dict(lang),
    t = trustText[lang];
  const [stats, { report, ops }] = await Promise.all([
    trustStats(db),
    trustDashboard(db, user),
  ]);
  const internal = canStaff(user, "conduct") || canStaff(user, "audit");
  return (
    <section className="section-tight stack">
      <div className="row-between">
        <h2 className="h3">
          {T("Прозрачность и безопасность", "Transparency and safety")}
        </h2>
        <Link className="text-link small" href={`/${lang}/trust`}>
          {T("Публичная страница", "Public page")}
        </Link>
      </div>
      <dl className="stat-grid">
        {Object.entries(stats).map(([k, v]) => (
          <div key={k}>
            <dt>{d.trust.stats[k] ?? k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {internal ? (
        <div className="card stack-sm">
          <h3>{T("Требует внимания сейчас", "Needs attention now")}</h3>
          <p>
            {T("Открытые жалобы", "Open reports")}: {ops.open_reports} ·{" "}
            {T("На проверке", "In review")}: {ops.reviewing_reports} ·{" "}
            {T("Апелляции", "Appeals")}: {ops.open_appeals} ·{" "}
            {T("Без рецензента", "Unassigned")}: {ops.unassigned_appeals}
          </p>
          {ops.oldest_report ? (
            <p className="small">
              {T("Самая старая жалоба", "Oldest report")}:{" "}
              <LocalTime lang={lang} iso={ops.oldest_report} />
            </p>
          ) : null}
          {canStaff(user, "conduct") ? (
            <Link
              className="btn btn-ghost btn-sm"
              href={`/${lang}/admin?tab=conduct`}
            >
              {T("Открыть очередь", "Open queue")}
            </Link>
          ) : null}
        </div>
      ) : null}
      <h3>{t.report}</h3>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{T("Показатель за 90 дней", "90-day metric")}</th>
              <th>{T("Публично", "Public")}</th>
              {internal ? (
                <th>{T("Точное число · сотрудники", "Exact count · staff")}</th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {Object.entries(report.counts).map(([k, v]) => (
              <tr key={k}>
                <td>{t.counts[k] ?? k}</td>
                <td>{publicCount(v) ?? t.fewer}</td>
                {internal ? <td>{v}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">
        {T(
          "Медианное время рассмотрения, дней",
          "Median resolution time, days",
        )}
        : {report.medianDays ?? "—"}.{" "}
        {T(
          "Тот же источник данных, что на странице доверия. Малые публичные значения скрыты.",
          "Uses the same data as the trust page. Small public counts are suppressed.",
        )}
      </p>
    </section>
  );
}

export async function OperationsTournaments(ctx: OperationsContext) {
  const { db, user, lang, back, sp, admin } = ctx,
    T = textOf(lang),
    d = dict(lang);
  const games = await listGames(db, true);
  if (one(sp.event)) {
    const t = await getTournament(db, one(sp.event));
    if (!t)
      return <Empty title={T("Турнир не найден", "Tournament not found")} />;
    if (one(sp.match)) {
      const [match] = await db.query<{ id: string }>(
        "select id from matches where id::text=$1 and tournament_id=$2",
        [one(sp.match), t.id],
      );
      if (!match)
        return (
          <Empty
            title={T(
              "Матч не найден в этом турнире",
              "Match does not belong to this tournament",
            )}
          />
        );
      const MatchPage = (await import("@/app/[lang]/matches/[id]/page"))
        .default;
      return (
        <div className="stack admin-event">
          <Link
            className="text-link"
            href={`${back}&event=${encodeURIComponent(t.slug)}`}
          >
            {T("К управлению турниром", "Back to tournament operations")}
          </Link>
          <MatchPage
            params={Promise.resolve({ lang, id: match.id })}
            searchParams={Promise.resolve({ ...sp, control: "1" })}
          />
        </div>
      );
    }
    const Manage = (await import("@/app/[lang]/organizer/t/[slug]/page"))
      .default;
    const targets = allowedTransitions(t.format, t.status as TournamentStatus);
    return (
      <div className="stack admin-event">
        <Link className="text-link" href={back}>
          {T("Все турниры", "All tournaments")}
        </Link>
        {admin && targets.length ? (
          <details className="disclosure">
            <summary>
              {T(
                "Административное изменение статуса",
                "Administrative status change",
              )}
            </summary>
            <p className="small muted">
              {T(
                "Действуют проверки регистрации, сетки и результатов. Обход проверки завершения турнира не разрешён.",
                "Registration, bracket and result checks apply. Completion checks cannot be bypassed.",
              )}
            </p>
            <ActionForm
              action="admin.transition"
              lang={lang}
              back={`${back}&event=${encodeURIComponent(t.slug)}`}
              hidden={{ tournament: t.id }}
              className="stack-sm"
            >
              <Field label={T("Новый статус", "New status")}>
                <select name="to">
                  {targets.map((s) => (
                    <option key={s} value={s}>
                      {d.statuses.tournament[s] ?? s}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label={T("Причина для журнала", "Reason for the decision log")}
              >
                <textarea
                  name="reason"
                  required
                  minLength={10}
                  maxLength={500}
                />
              </Field>
              <button className="btn btn-danger btn-sm">
                {T("Изменить статус", "Change status")}
              </button>
            </ActionForm>
          </details>
        ) : null}
        {admin && !["COMPLETED", "CANCELLED", "ARCHIVED"].includes(t.status) ? (
          <details className="disclosure">
            <summary>
              {T("Награда победителю", "Winner award")}: {t.prize_coins}
            </summary>
            <ActionForm
              action="tournament.prize"
              lang={lang}
              back={`${back}&event=${encodeURIComponent(t.slug)}`}
              hidden={{ tournament: t.id }}
              className="inline-form"
            >
              <Field label={T("Монеты победителю", "Winner coins")}>
                <input
                  name="coins"
                  type="number"
                  min={0}
                  max={100000}
                  defaultValue={t.prize_coins}
                />
              </Field>
              <button className="btn btn-ghost btn-sm">
                {T("Сохранить", "Save")}
              </button>
            </ActionForm>
            <p className="small muted">
              {T(
                "Монеты не имеют денежной стоимости. Взносы участников не финансируют призы.",
                "Coins have no cash value. Participant fees do not fund prizes.",
              )}
            </p>
          </details>
        ) : null}
        <Manage
          params={Promise.resolve({ lang, slug: t.slug })}
          searchParams={Promise.resolve({ ...sp, control: "1" })}
        />
      </div>
    );
  }
  const result = await searchEvents(db, user, inputOf(sp));
  const orgs = admin
    ? await db.query<{ id: string; name: string }>(
        "select id,name from organizations order by name",
      )
    : [];
  const selected = orgs.find((o) => o.id === one(sp.org));
  return (
    <div className="stack">
      <div className="row-between">
        <h2 className="h3">
          {T("Операции с турнирами", "Tournament operations")}
        </h2>
        {admin ? (
          <Link className="btn btn-primary btn-sm" href={`${back}&new=1`}>
            {T("Создать турнир", "Create tournament")}
          </Link>
        ) : null}
      </div>
      {admin && one(sp.new) === "1" ? (
        <section className="card stack">
          <h3>{T("Новый турнир", "New tournament")}</h3>
          <form method="get" className="inline-form">
            <input type="hidden" name="tab" value="tournaments" />
            <input type="hidden" name="new" value="1" />
            <Field
              label={T("Организационное пространство", "Organizing space")}
            >
              <select name="org" required defaultValue={selected?.id ?? ""}>
                <option value="">—</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </Field>
            <button className="btn btn-ghost btn-sm">
              {T("Выбрать", "Select")}
            </button>
          </form>
          {selected ? (
            <TournamentForm
              lang={lang}
              back={`${back}&new=1&org=${selected.id}`}
              orgId={selected.id}
              circuits={await listCircuits(db, { orgId: selected.id })}
            />
          ) : (
            <p className="small muted">
              {T(
                "Выберите существующее пространство организатора.",
                "Select an existing organizer space.",
              )}{" "}
              <Link className="text-link" href={`/${lang}/organizer`}>
                {T("Управление пространствами", "Manage spaces")}
              </Link>
            </p>
          )}
        </section>
      ) : null}
      <form method="get" className="admin-filter">
        <input type="hidden" name="tab" value="tournaments" />
        <Field
          label={T("Название, код или организатор", "Name, slug or organizer")}
        >
          <input name="q" defaultValue={one(sp.q)} maxLength={100} />
        </Field>
        <Field label={T("Игра", "Game")}>
          <select name="game" defaultValue={one(sp.game)}>
            <option value="">{T("Все игры", "All games")}</option>
            {games.map((g) => (
              <option key={g.slug} value={g.slug}>
                {g.name}
                {g.retired ? " · retired" : ""}
              </option>
            ))}
          </select>
        </Field>
        <Field label={T("Формат", "Format")}>
          <select name="format" defaultValue={one(sp.format)}>
            <option value="">{T("Все форматы", "All formats")}</option>
            {FORMATS.map((f) => (
              <option key={f} value={f}>
                {formatLabels[f][lang === "ru" ? 0 : 1]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={T("Статус", "Status")}>
          <select name="status" defaultValue={one(sp.status)}>
            <option value="">{T("Все статусы", "All states")}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {d.statuses.tournament[s] ?? s}
              </option>
            ))}
          </select>
        </Field>
        <button className="btn btn-ghost btn-sm">{T("Найти", "Search")}</button>
      </form>
      {result.rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{T("Турнир", "Tournament")}</th>
                <th>{T("Игра / формат", "Game / format")}</th>
                <th>{T("Статус", "Status")}</th>
                <th>{T("Регистрация", "Registration")}</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link
                      className="text-link"
                      href={`${back}&event=${encodeURIComponent(t.slug)}`}
                    >
                      {t.name}
                    </Link>
                    <div className="small muted">
                      {t.org_name} · <LocalTime lang={lang} iso={t.starts_at} />
                    </div>
                  </td>
                  <td>
                    {games.find((g) => g.slug === t.game)?.name ?? t.game}
                    <div className="small muted">
                      {formatLabels[t.format]?.[lang === "ru" ? 0 : 1] ??
                        t.format}
                    </div>
                  </td>
                  <td>
                    <Badge status={t.status}>
                      {d.statuses.tournament[t.status] ?? t.status}
                    </Badge>
                  </td>
                  <td>
                    {t.registered}/{t.max_participants}
                    <div className="small muted">
                      {T("Ожидают решения", "Pending")}: {t.pending} ·{" "}
                      {T("Резерв", "Waitlist")}: {t.waiting}
                      <br />
                      {T("Подтвердили участие", "Checked in")}: {t.checked_in}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title={T(
            "По этим условиям турниров нет",
            "No tournaments match these filters",
          )}
        />
      )}
      <PageLinks ctx={ctx} {...result} />
    </div>
  );
}

export async function OperationsUser(ctx: OperationsContext) {
  const { db, user, lang, sp, admin, back } = ctx,
    T = textOf(lang),
    p = await staffProfile(db, user, one(sp.user));
  if (!p)
    return <Empty title={T("Профиль недоступен", "Profile unavailable")} />;
  const orgs = admin
    ? await db.query<{ id: string; name: string }>(
        "select id,name from organizations order by name",
      )
    : [];
  return (
    <div className="stack">
      <Link className="text-link" href={back}>
        {T("Все пользователи", "All users")}
      </Link>
      <h2 className="h3">
        {p.user.display_name} · @{p.user.username}
      </h2>
      <p>
        {p.user.status} · {p.user.country} ·{" "}
        <LocalTime lang={lang} iso={p.user.created_at} />
      </p>
      <p className="prewrap small">{p.user.bio}</p>
      <p className="notice">
        {T(
          "Игрок — базовые права аккаунта. Организатор — администратор конкретного пространства. Судья пространства и судья всей платформы — разные полномочия.",
          "Player is the base account capability. An organizer administers a specific space. Space referee and platform referee are separate permissions.",
        )}
      </p>
      <div className="row">
        <Link
          className="btn btn-ghost btn-sm"
          href={`${back}&q=${encodeURIComponent(p.user.username)}`}
        >
          {T("Роли и статус аккаунта", "Account roles and status")}
        </Link>
        {canStaff(user, "conduct") ? (
          <Link
            className="btn btn-ghost btn-sm"
            href={`/${lang}/admin?tab=conduct&subject=${encodeURIComponent(p.user.username)}#sanction-form`}
          >
            {T("Ограничение по правилу", "Rule-based restriction")}
          </Link>
        ) : null}
      </div>
      <section className="card stack-sm">
        <h3>{T("Привязанные игровые аккаунты", "Linked game accounts")}</h3>
        {p.accounts.length ? (
          p.accounts.map((a) => (
            <p key={`${a.game}:${a.handle}`}>
              {a.game} · {a.handle} ·{" "}
              {a.verified
                ? T("Подтверждён", "Verified")
                : T(
                    "Заявлен игроком, не подтверждён издателем",
                    "Player-entered; not publisher-verified",
                  )}
            </p>
          ))
        ) : (
          <p>{T("Привязок нет", "No linked accounts")}</p>
        )}
      </section>
      <section className="card stack-sm">
        <h3>{T("Доступ к пространствам", "Space access")}</h3>
        {p.spaces.length ? (
          p.spaces.map((o) => (
            <p key={o.id}>
              {o.name} · {o.role}
            </p>
          ))
        ) : (
          <p>{T("Нет назначений", "No assignments")}</p>
        )}
        {admin ? (
          <ActionForm
            action="admin.organizer_access"
            lang={lang}
            back={`${back}&user=${p.user.username}`}
            hidden={{ user: p.user.id }}
            className="stack-sm"
          >
            <Field label={T("Пространство", "Space")}>
              <select name="org" required>
                <option value="">—</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={T("Полномочия", "Access")}>
              <select name="role">
                <option value="admin">{T("Организатор", "Organizer")}</option>
                <option value="referee">
                  {T("Судья пространства", "Space referee")}
                </option>
                <option value="remove">
                  {T("Снять назначение", "Remove access")}
                </option>
              </select>
            </Field>
            <Field label={T("Обоснование", "Reason")}>
              <input name="reason" required minLength={10} maxLength={500} />
            </Field>
            <button className="btn btn-primary btn-sm">
              {T("Сохранить доступ", "Save access")}
            </button>
            <p className="small muted">
              {T(
                "Владельца пространства через эту форму изменить нельзя.",
                "Space ownership cannot be changed through this form.",
              )}
            </p>
          </ActionForm>
        ) : null}
      </section>
      <section>
        <h3>{T("Команды", "Teams")}</h3>
        {p.teams.map((t) => (
          <p key={t.slug}>
            <Link href={`/${lang}/teams/${t.slug}`}>{t.name}</Link> · {t.game}
          </p>
        ))}
      </section>
      <section>
        <h3>
          {T(
            "История турниров · последние 50",
            "Tournament history · latest 50",
          )}
        </h3>
        {p.tournaments.length ? (
          <ul className="list">
            {p.tournaments.map((t) => (
              <li key={t.slug}>
                <Link
                  href={`/${lang}/admin?tab=tournaments&event=${encodeURIComponent(t.slug)}`}
                >
                  {t.name}
                </Link>{" "}
                · {t.status} · {T("Место", "Place")}: {t.placement ?? "—"}
              </li>
            ))}
          </ul>
        ) : (
          <Empty
            title={T(
              "Участий в начатых турнирах пока нет",
              "No participation in started tournaments",
            )}
          />
        )}
      </section>
      <section>
        <h3>
          {T("История матчей · последние 50", "Match history · latest 50")}
        </h3>
        {p.history.length ? (
          <ul className="list">
            {p.history.map((m) => (
              <li key={m.id}>
                <Link href={`/${lang}/matches/${m.id}`}>{m.t_name}</Link> ·{" "}
                {m.opponent ?? "—"} · {m.my_score ?? "—"}:{m.their_score ?? "—"}{" "}
                · {m.outcome} · <LocalTime iso={m.completed_at} lang={lang} />
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={T("Завершённых матчей нет", "No completed matches")} />
        )}
      </section>
    </div>
  );
}

function GameEditor({ ctx, g }: { ctx: OperationsContext; g?: CatalogGame }) {
  const { lang, back } = ctx,
    T = textOf(lang);
  return (
    <ActionForm
      action="admin.game"
      lang={lang}
      back={back}
      hidden={{ version: String(g?.version ?? 0) }}
      className="stack-sm"
    >
      <div className="form-grid">
        <Field label={T("Код игры (не меняется)", "Game slug (immutable)")}>
          <input
            name="slug"
            required
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            maxLength={48}
            defaultValue={g?.slug}
            readOnly={!!g}
          />
        </Field>
        <Field label={T("Название", "Name")}>
          <input
            name="name"
            required
            minLength={2}
            maxLength={80}
            defaultValue={g?.name}
          />
        </Field>
        <Field label={T("Игроков в составе", "Players per roster")}>
          <input
            name="teamSize"
            type="number"
            required
            min={1}
            max={10}
            defaultValue={g?.teamSize ?? 1}
          />
        </Field>
        <Field label={T("Игровой режим", "Game mode")}>
          <select name="mode" defaultValue={g?.mode ?? "head_to_head"}>
            {GAME_MODES.map((m) => (
              <option key={m} value={m}>
                {gameModeLabel(m, lang)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Жанр (RU)">
          <input
            name="genreRu"
            required
            minLength={2}
            maxLength={80}
            defaultValue={g?.genre.ru}
          />
        </Field>
        <Field label="Genre (EN)">
          <input
            name="genreEn"
            required
            minLength={2}
            maxLength={80}
            defaultValue={g?.genre.en}
          />
        </Field>
      </div>
      <fieldset>
        <legend>{T("Платформы", "Platforms")}</legend>
        <div className="row">
          {["pc", "console", "mobile"].map((p) => (
            <Check
              key={p}
              name="platforms"
              value={p}
              defaultChecked={g?.platforms.includes(p as never) ?? p === "pc"}
            >
              {dict(lang).games.platforms[p]}
            </Check>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>
          {T("Доступные форматы турниров", "Available tournament formats")}
        </legend>
        <div className="form-grid">
          {CATALOG_FORMATS.map((f) => (
            <Check
              key={f}
              name="formats"
              value={f}
              defaultChecked={
                g?.formats.includes(f) ?? f === "single_elimination"
              }
            >
              {formatLabels[f][lang === "ru" ? 0 : 1]}
            </Check>
          ))}
        </div>
      </fieldset>
      {g ? (
        <Check name="retired" value="1" defaultChecked={g.retired}>
          {T(
            "Вывести из каталога: сохранить историю, запретить новые турниры и команды",
            "Retire: preserve history, prevent new tournaments and teams",
          )}
        </Check>
      ) : null}
      <Field label={T("Причина изменения", "Reason for change")}>
        <textarea name="reason" required minLength={10} maxLength={500} />
      </Field>
      <button className="btn btn-primary btn-sm">
        {g
          ? T("Сохранить изменения", "Save changes")
          : T("Добавить игру", "Add game")}
      </button>
    </ActionForm>
  );
}
export async function OperationsGames(ctx: OperationsContext) {
  const games = await listGames(ctx.db, true),
    T = textOf(ctx.lang);
  return (
    <div className="stack">
      <h2 className="h3">{T("Каталог игр", "Games catalog")}</h2>
      <p className="notice">
        {T(
          "Размер состава, игровой режим и турнирные форматы задаются независимо. Добавление игры включает каталог, турниры, команды и рейтинги. Оно не подключает API издателя, игровой сервер, автоматическое получение результатов или специальные режимы остальных сервисов.",
          "Roster size, game mode and tournament formats are independent. Adding a game enables catalog, tournaments, teams and rankings. It does not connect publisher APIs, game servers, automatic results or game-specific modes in other services.",
        )}
      </p>
      <details className="card disclosure">
        <summary>{T("Добавить игру", "Add game")}</summary>
        <GameEditor ctx={ctx} />
      </details>
      {games.map((g) => (
        <details key={g.slug} className="card disclosure">
          <summary>
            {g.name} · {gameRosterLabel(g, ctx.lang)} ·{" "}
            {gameModeLabel(g.mode, ctx.lang)}
            {g.retired ? T(" · выведена", " · retired") : ""}
          </summary>
          <p className="small muted">
            {gameFormatsLabel(g.formats, ctx.lang)} · v{g.version}
          </p>
          <GameEditor ctx={ctx} g={g} />
        </details>
      ))}
    </div>
  );
}

const appStates = [
  "new",
  "in_review",
  "approved",
  "rejected",
  "closed",
] as const;
const appLabel = (s: string, lang: Locale) =>
  ({
    new: ["Новая", "New"],
    in_review: ["На рассмотрении", "In review"],
    approved: ["Одобрена", "Approved"],
    rejected: ["Отклонена", "Rejected"],
    closed: ["Закрыта", "Closed"],
  })[s]?.[lang === "ru" ? 0 : 1] ?? s;
export async function OperationsApplications(ctx: OperationsContext) {
  const { db, user, lang, back, sp } = ctx,
    T = textOf(lang),
    r = await searchApplications(db, user, inputOf(sp));
  const kinds = await db.query<{ kind: string }>(
    "select distinct kind from applications order by kind",
  );
  return (
    <div className="stack">
      <h2 className="h3">
        {T("Обращения и заявки", "Inquiries and applications")}
      </h2>
      <div className="row">
        {canStaff(user, "academy") ? (
          <Link
            className="btn btn-ghost btn-sm"
            href={`/${lang}/admin?tab=academy`}
          >
            {T("Проверка тренеров", "Coach review")}
          </Link>
        ) : null}
        {canStaff(user, "venues") ? (
          <Link
            className="btn btn-ghost btn-sm"
            href={`/${lang}/admin?tab=venues`}
          >
            {T("Проверка площадок", "Venue review")}
          </Link>
        ) : null}
      </div>
      <p className="notice">
        {T(
          "Решение по обращению сохраняет результат рассмотрения. Одобрение не создаёт сервис и не подключает инфраструктуру. Публикация профиля тренера или площадки проходит отдельную проверку в соответствующей очереди.",
          "An inquiry decision records its disposition. Approval does not create a service or connect infrastructure. Coach and venue publication uses the separate review queues.",
        )}
      </p>
      <form method="get" className="admin-filter">
        <input type="hidden" name="tab" value="applications" />
        <Field label={T("Имя, компания или email", "Name, company or email")}>
          <input name="q" defaultValue={one(sp.q)} />
        </Field>
        <Field label={T("Направление", "Category")}>
          <select name="kind" defaultValue={one(sp.kind)}>
            <option value="">{T("Все", "All")}</option>
            {kinds.map((k) => (
              <option key={k.kind}>{k.kind}</option>
            ))}
          </select>
        </Field>
        <Field label={T("Статус", "Status")}>
          <select name="status" defaultValue={one(sp.status)}>
            <option value="">{T("Все", "All")}</option>
            {appStates.map((s) => (
              <option key={s} value={s}>
                {appLabel(s, lang)}
              </option>
            ))}
          </select>
        </Field>
        <button className="btn btn-ghost btn-sm">{T("Найти", "Search")}</button>
      </form>
      {r.rows.length ? (
        r.rows.map((a) => (
          <article key={a.id} className="card stack-sm">
            <div className="row-between">
              <h3>
                {a.name} · {a.kind}
              </h3>
              <Badge status={a.status}>{appLabel(a.status, lang)}</Badge>
            </div>
            <p className="small">
              {a.company} · {a.email} ·{" "}
              <LocalTime iso={a.created_at} lang={lang} />
            </p>
            <p className="prewrap">{a.message}</p>
            {a.decision ? (
              <p className="notice prewrap">
                @{a.decider} · {a.decision}{" "}
                {a.decided_at ? (
                  <LocalTime iso={a.decided_at} lang={lang} />
                ) : null}
              </p>
            ) : null}
            <ActionForm
              action="admin.application_decide"
              lang={lang}
              back={back}
              hidden={{ application: a.id, version: String(a.version) }}
              className="stack-sm"
            >
              <Field label={T("Решение", "Decision")}>
                <select name="status" defaultValue={a.status}>
                  {appStates.map((s) => (
                    <option key={s} value={s}>
                      {appLabel(s, lang)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={T("Обоснование", "Reason")}>
                <textarea
                  name="reason"
                  required
                  minLength={10}
                  maxLength={2000}
                />
              </Field>
              <button className="btn btn-primary btn-sm">
                {T("Сохранить решение", "Save decision")}
              </button>
            </ActionForm>
          </article>
        ))
      ) : (
        <Empty
          title={T("Заявок по этим условиям нет", "No matching applications")}
        />
      )}
      <PageLinks ctx={ctx} {...r} />
    </div>
  );
}

export async function OperationsAudit(ctx: OperationsContext) {
  const { db, user, lang, back, sp } = ctx,
    T = textOf(lang),
    r = await searchDecisions(db, user, inputOf(sp));
  // One transaction holds the append lock so the verified head and count describe the same stored chain.
  const report =
    one(sp.verify) === "1"
      ? await db.tx(async (q) => {
          await q.query("select pg_advisory_xact_lock($1)", [7461002]);
          const chain = await verifyAuditChain(q);
          const [head] = await q.query<{ id: string; hash: string }>(
            "select id::text,hash from audit_log order by id desc limit 1",
          );
          return { ...chain, head, at: new Date().toISOString() };
        })
      : null;
  const next = new URLSearchParams(inputOf(sp));
  next.delete("verify");
  if (r.next) next.set("before", r.next);
  return (
    <div className="stack">
      <div className="row-between">
        <h2 className="h3">{T("Журнал решений", "Decision log")}</h2>
        <Link className="btn btn-primary btn-sm" href={`${back}&verify=1`}>
          {T("Проверить всю цепочку SHA-256", "Verify full SHA-256 chain")}
        </Link>
      </div>
      <p className="small muted">
        {T(
          "Проверка заново вычисляет хеш каждой сохранённой записи и связь с предыдущей, независимо от фильтров. Без внешней доверенной контрольной точки она не доказывает отсутствие удаления конца журнала или полной перезаписи цепочки.",
          "Verification recomputes every stored record and predecessor link, independently of filters. Without an external trusted checkpoint, it cannot prove that the tail was not deleted or the entire chain rewritten.",
        )}
      </p>
      {report ? (
        <div
          className={`notice ${report.valid ? "notice-ok" : "notice-warn"}`}
          role="status"
        >
          <strong>
            {report.valid
              ? T("Цепочка целостна", "Chain is intact")
              : T("Нарушение целостности", "Integrity failure")}
          </strong>
          <p>
            {T("Проверено записей", "Records checked")}: {report.records} ·{" "}
            {report.at}
            {report.brokenAt !== null
              ? ` · ${T("Ошибка в записи", "Broken record")} #${report.brokenAt}`
              : ""}
          </p>
          <p className="mono admin-hash">
            {T("Проверенная вершина", "Verified head")}: #
            {report.head?.id ?? "0"} · {report.head?.hash ?? "—"}
          </p>
        </div>
      ) : null}
      <form method="get" className="admin-filter">
        <input type="hidden" name="tab" value="audit" />
        {[
          ["action", T("Точное действие", "Exact action")],
          ["entity", T("Тип объекта", "Entity type")],
          ["id", T("ID объекта", "Entity ID")],
          ["actor", T("Сотрудник", "Actor")],
          ["from", T("С даты", "From date")],
          ["to", T("По дату", "Through date")],
        ].map(([key, label]) => (
          <Field key={key} label={label}>
            <input
              name={key}
              type={key === "from" || key === "to" ? "date" : "text"}
              defaultValue={one(sp[key])}
            />
          </Field>
        ))}
        <button className="btn btn-ghost btn-sm">{T("Найти", "Search")}</button>
      </form>
      {r.rows.length ? (
        r.rows.map((e) => (
          <details key={e.id} className="card disclosure">
            <summary>
              #{e.id} · {e.action} · {e.actor ? `@${e.actor}` : "system"}
            </summary>
            <p className="small">
              <LocalTime iso={e.at} lang={lang} /> · {e.entity} · {e.entity_id}
            </p>
            <p className="mono admin-hash">SHA-256: {e.hash}</p>
            <p className="mono admin-hash">
              {T("Предыдущий", "Previous")}: {e.prev_hash}
            </p>
            <pre className="admin-json">{JSON.stringify(e.data, null, 2)}</pre>
          </details>
        ))
      ) : (
        <Empty
          title={T("Записей по этим условиям нет", "No matching records")}
        />
      )}
      {r.next ? (
        <Link className="btn btn-ghost btn-sm" href={`/${lang}/admin?${next}`}>
          {T("Следующие 50 записей", "Next 50 records")}
        </Link>
      ) : null}
    </div>
  );
}

export async function OperationsSponsors(ctx: OperationsContext) {
  const { db, lang, back, sp } = ctx,
    T = textOf(lang);
  const rows = await db.query<SponsorRow & { version: number }>(
    "select * from sponsors where name ilike $1 order by created_at desc",
    [`%${one(sp.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`],
  );
  const events = await db.query<{ id: string; slug: string; name: string }>(
    "select id,slug,name from tournaments where name ilike $1 or slug ilike $1 order by created_at desc limit 500",
    [`%${one(sp.eventq).replace(/[\\%_]/g, (c) => `\\${c}`)}%`],
  );
  const links = await db.query<{
    sponsor_id: string;
    tournament_id: string;
    name: string;
    slug: string;
  }>(
    "select ts.*,t.name,t.slug from tournament_sponsors ts join tournaments t on t.id=ts.tournament_id order by t.created_at desc",
  );
  return (
    <div className="stack">
      <h2 className="h3">
        {T("Спонсоры и партнёры", "Sponsors and partners")}
      </h2>
      <form method="get" className="inline-form">
        <input type="hidden" name="tab" value="sponsors" />
        <input
          name="q"
          defaultValue={one(sp.q)}
          aria-label={T("Поиск спонсора", "Search sponsors")}
        />
        <input
          name="eventq"
          defaultValue={one(sp.eventq)}
          placeholder={T(
            "Поиск турнира для привязки",
            "Find tournament to attach",
          )}
          aria-label={T(
            "Поиск турнира для привязки",
            "Find tournament to attach",
          )}
        />
        <button className="btn btn-ghost btn-sm">{T("Найти", "Search")}</button>
      </form>
      <details className="card disclosure">
        <summary>{T("Добавить спонсора", "Add sponsor")}</summary>
        <ActionForm
          action="sponsor.create"
          lang={lang}
          back={back}
          multipart
          className="stack-sm"
        >
          <SponsorFields lang={lang} />
          <button className="btn btn-primary btn-sm">
            {T("Создать запись", "Create record")}
          </button>
        </ActionForm>
      </details>
      {rows.length ? (
        rows.map((s) => (
          <article key={s.id} className="card stack">
            <div className="row-between">
              <h3>{s.name}</h3>
              <Badge status={s.active ? "ok" : "muted"}>
                {s.active ? T("Активен", "Active") : T("Скрыт", "Hidden")}
              </Badge>
            </div>
            <details className="disclosure">
              <summary>{T("Редактировать запись", "Edit record")}</summary>
              <ActionForm
                action="sponsor.update"
                lang={lang}
                back={back}
                hidden={{ sponsor: s.id, version: String(s.version) }}
                multipart
                className="stack-sm"
              >
                <SponsorFields lang={lang} s={s} />
                <Check name="active" value="1" defaultChecked={s.active}>
                  {T("Показывать публично", "Show publicly")}
                </Check>
                <Check name="removeLogo" value="1">
                  {T("Удалить логотип", "Remove logo")}
                </Check>
                <Field label={T("Причина изменения", "Reason")}>
                  <input
                    name="reason"
                    required
                    minLength={10}
                    maxLength={500}
                  />
                </Field>
                <button className="btn btn-primary btn-sm">
                  {T("Сохранить", "Save")}
                </button>
              </ActionForm>
            </details>
            <h4>{T("Связанные турниры", "Attached tournaments")}</h4>
            {links
              .filter((l) => l.sponsor_id === s.id)
              .map((l) => (
                <div className="row-between" key={l.tournament_id}>
                  <Link
                    className="text-link"
                    href={`/${lang}/tournaments/${l.slug}`}
                  >
                    {l.name}
                  </Link>
                  <ActionForm
                    action="sponsor.attach"
                    lang={lang}
                    back={back}
                    hidden={{
                      sponsor: s.id,
                      tournament: l.tournament_id,
                      attach: "0",
                    }}
                  >
                    <button className="btn btn-ghost btn-xs">
                      {T("Отвязать", "Detach")}
                    </button>
                  </ActionForm>
                </div>
              ))}
            <ActionForm
              action="sponsor.attach"
              lang={lang}
              back={back}
              hidden={{ sponsor: s.id, attach: "1" }}
              className="inline-form"
            >
              <Field
                label={T(
                  "Прикрепить к турниру (последние 500)",
                  "Attach to tournament (latest 500)",
                )}
              >
                <select name="tournament" required>
                  <option value="">—</option>
                  {events
                    .filter(
                      (t) =>
                        !links.some(
                          (l) =>
                            l.sponsor_id === s.id && l.tournament_id === t.id,
                        ),
                    )
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </select>
              </Field>
              <button className="btn btn-ghost btn-sm">
                {T("Прикрепить", "Attach")}
              </button>
            </ActionForm>
          </article>
        ))
      ) : (
        <Empty
          title={T("Спонсоров по этим условиям нет", "No matching sponsors")}
        />
      )}
    </div>
  );
}
function SponsorFields({ lang, s }: { lang: Locale; s?: SponsorRow }) {
  const T = textOf(lang);
  return (
    <>
      <Field label={T("Название", "Name")}>
        <input
          name="name"
          required
          minLength={2}
          maxLength={80}
          defaultValue={s?.name}
        />
      </Field>
      <Field label={T("Уровень", "Tier")}>
        <select name="tier" defaultValue={s?.tier ?? "partner"}>
          {SPONSOR_TIERS.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </Field>
      <Field label={T("Сайт", "Website")}>
        <input name="website" type="url" defaultValue={s?.website_url} />
      </Field>
      <Field label={T("Логотип", "Logo")}>
        <input
          name="logo"
          type="file"
          accept="image/png,image/jpeg,image/webp"
        />
      </Field>
    </>
  );
}
