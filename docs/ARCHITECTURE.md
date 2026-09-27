# Архитектура портала MAXIMUS VEGAS

Title: Architecture · Status: FINAL · Version: 1.0 · Date: 27 September 2026

## 1. Контуры

| Контур | Где | Назначение |
| --- | --- | --- |
| Публичный портал | `src/app/[lang]/*` | Главная, игры, турниры, матчи, игроки, команды, рейтинги, направления, доверие, помощь, документы |
| Личное пространство | `hub`, `notifications`, `calendar`, `settings`, `players/<username>` | Игровой паспорт, матчи, приглашения, уведомления, приватность |
| Организатор | `organizer`, `organizer/<space>`, `organizer/t/<tournament>` | Сотрудники, турниры, жизненный цикл, посев, check-in, операции матчей, отчёт |
| Администрирование | `admin`, `admin/claim` | Пользователи и роли, блокировки, споры, заявки, турниры, журнал с проверкой цепочки |
| Действия | `src/app/api/a/[action]/route.ts` | Единая точка всех изменений данных |
| Домен | `src/server/*` | Бизнес-правила без зависимостей от Next.js; покрыты тестами |

## 2. Доменная модель (PostgreSQL)

`users`, `user_roles`, `sessions`, `auth_attempts`, `linked_game_accounts`, `organizations`, `org_members`, `teams`, `team_members`, `team_invites`, `tournaments`, `registrations`, `roster_entries`, `matches`, `match_results`, `disputes`, `applications`, `notifications`, `audit_log`, `schema_migrations`.

Ключевые ограничения, которые обеспечивает сама база:

- одна активная заявка пользователя или команды на турнир — частичные уникальные индексы `registrations_user`, `registrations_team`;
- игрок не может быть в двух заявках одного турнира — `roster_entries unique (tournament_id, user_id)`;
- состав на момент участия хранится в `roster_entries` отдельно от текущего состава команды;
- позиция матча уникальна — `unique (tournament_id, round, position)`;
- версии результата уникальны — `unique (match_id, version)`.

Время хранится в UTC (`timestamptz`) и показывается в часовом поясе посетителя; ввод времени переводится из зоны браузера на сервере.

## 3. Турнирный движок

- Формат release 1: олимпийская система (single elimination) для любого числа участников от 2 до 512. Размер сетки — ближайшая степень двойки; проходы без игры достаются верхним посевам; стандартный порядок посева разводит 1-й и 2-й посевы до финала (`src/server/bracket.ts`).
- Состояния: `DRAFT → PUBLISHED → REGISTRATION_OPEN → REGISTRATION_CLOSED → IN_PROGRESS → COMPLETED → ARCHIVED`; `PAUSED`, `CANCELLED`. Разрешённые переходы — таблица `TRANSITIONS`; `COMPLETED` наступает только после подтверждения финала.
- Регистрация: соло или команда; лист ожидания с автоматическим подъёмом; check-in открывает организатор; при запуске участники без check-in получают статус `not_checked_in`, посев фиксируется.
- Матч: `pending → ready → in_progress → result_submitted → completed`; `disputed`, `cancelled`. Исходы: `played`, `bye`, `no_show`, `disqualification`.
- Результат: отчёт стороны → подтверждение соперника; совпадающие отчёты подтверждаются автоматически; расходящиеся открывают спор. Решение судьи закрывает споры.
- Продвижение по сетке идёт в той же транзакции под блокировкой строк (`select … for update`). Повторное подтверждение отклоняется (`already_completed`), повторная постановка того же победителя — пустая операция.
- Исправление создаёт новую версию. Если следующий матч уже получил отчёт или завершён, исправление блокируется (`dependent_match_played`).
- Итоговые места: победитель — 1; проигравший в раунде `r` из `R` — `2^(R−r)+1`.

## 4. Действия API (`POST /api/a/<action>`)

Формат `application/x-www-form-urlencoded`, поля `lang`, `back` + поля действия. Ответ — `303` на `back` с `?ok=<code>` или `?e=<code>`.

| Группа | Действия |
| --- | --- |
| Аккаунт | `auth.signup`, `auth.signin`, `auth.signout`, `account.profile`, `account.game`, `account.password`, `account.session`, `account.delete`, `account.claim_admin`, `notifications.read` |
| Команды | `team.create`, `team.invite`, `team.respond`, `team.revoke`, `team.leave`, `team.remove`, `team.role` |
| Организатор | `org.create`, `org.member`, `org.remove`, `tournament.create`, `tournament.update`, `tournament.transition`, `tournament.checkin_window`, `tournament.checkin_override`, `tournament.seeds`, `tournament.disqualify` |
| Участник | `tournament.register`, `tournament.withdraw`, `tournament.checkin` |
| Матч | `match.submit`, `match.confirm`, `match.dispute`, `match.official`, `match.noshow`, `match.correct`, `match.details` |
| Заявки | `application.create` |
| Админ | `admin.role`, `admin.user_status`, `admin.application` |

Прочие маршруты: `GET /api/health` (состояние базы), `GET /api/account/export` (выгрузка своих данных, JSON).

Коды ошибок — `src/server/errors.ts`, тексты — `src/lib/i18n.ts`.

## 5. Безопасность

- Пароли — scrypt (N=16384, r=8, p=1), сравнение за постоянное время; при отсутствии пользователя проверяется фиктивный хеш.
- Сессии — случайный 256-битный токен в cookie `HttpOnly; SameSite=Lax; Secure`; в базе хранится только SHA-256 токена; смена пароля завершает другие сессии; блокировка аккаунта завершает все.
- Ограничение попыток входа: 8 неудачных попыток за 15 минут на логин и на адрес клиента.
- Каждое изменение данных проверяет `Origin` против реального хоста; права проверяются на сервере в каждом действии.
- Права: платформенные роли `admin`, `referee`, `support`; роли пространства `owner`, `admin`, `referee` изолированы между пространствами.
- Журнал `audit_log` — hash-цепочка SHA-256 с каноническим JSON; запись под advisory-блокировкой; проверка цепочки — в `/admin?tab=audit`.
- Заголовки: `X-Frame-Options: DENY`, `nosniff`, строгий `Referrer-Policy`, `Permissions-Policy`, HSTS.
- Секреты в репозиторий не попадают; `.env*` в `.gitignore`.

## 6. Тесты

- `tests/bracket.test.ts` — размеры сеток 2–130, проходы без игры, порядок посева, места, перевод часовых поясов.
- `tests/portal.test.ts` — на встроенном PostgreSQL: аккаунты и ограничение попыток, полный соло-турнир с проходами без игры, спором, исправлением и итогами, лист ожидания, неявка, дисквалификация, команды и конфликт составов, роли пространства, заявки, целостность журнала.
- `scripts/e2e.mjs` — сквозной HTTP-сценарий на запущенном портале.
