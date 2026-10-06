# Runbook: развёртывание, проверка, откат

Title: Runbook · Status: PENDING MIPA REGISTRATION · Version: 6.0 · Date: 1 October 2026

## 1. Развёртывание

1. Ветка → проверки → `main`. Push в `main` репозитория `MAXIMUS-NPiO/maximus-vegas` → Vercel собирает production (`npm ci`, `npm run build`); GitHub Actions выполняет `npm run check`.
2. База — `DATABASE_URL` (PostgreSQL). Миграции применяются автоматически при первом обращении к данным: таблица `schema_migrations`, advisory-блокировка, каждая миграция в своей транзакции. Release 2 добавляет миграции 2–5, release 3 — миграцию 6 (круговая и швейцарская системы, серии и сезоны), release 4 — миграцию 7 (группы, лесенка, этапы и плей-офф), release 5 — миграцию 8 (подтверждение заявок, вопросы, составы, шаблоны, неявка, FFA), release 6 — миграцию 9 (серии и очки по уровням, площадки, допуск, оценки). Они только добавляют таблицы и столбцы и расширяют допустимые значения; код release 2 работает поверх миграции 6, код release 3 — поверх миграции 7, код release 4 — поверх миграции 8, код release 5 — поверх миграции 9.
3. **Preview-развёртывания должны использовать отдельную базу.** В Vercel → Settings → Environment Variables значение `DATABASE_URL` для Preview не должно совпадать с Production: иначе preview применит миграции к production-базе и будет писать в неё.

## 2. Переменные окружения release 2

| Переменная | Зачем | Без неё |
| --- | --- | --- |
| `MAIL_FROM` + `RESEND_API_KEY` или `SMTP_URL` | Доставка служебных писем | Письма копятся в очереди; подтверждение email и восстановление по почте недоступны; на странице восстановления — форма поддержки |
| `NEXT_PUBLIC_SITE_URL` | Адрес в ссылках писем и в адресах возврата оплаты | Доставка писем и оплата считаются не настроенными |
| `SIGNUP_EMAIL_CONFIRMATION=required` | Регистрация «сначала email» | Мгновенная регистрация; подтверждение email — отдельный шаг |
| `MFA_SECRET_KEY` (32+ символа) | Шифрование секретов TOTP | Секреты хранятся без шифрования; центр управления предупреждает об этом. Смена ключа делает существующие факторы нечитаемыми — потребуется сброс |
| `CRON_SECRET` (16+ символов) | Плановое обслуживание (`vercel.json`, 03:17 UTC) | Маршрут отвечает 404; письма всё равно уходят после действий, но повторы и сверка оплат не выполняются по расписанию |
| `PAYMENTS_ENABLED`, `PAYMENTS_MODE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `MERCHANT_VERIFIED`, `MERCHANT_LEGAL_NAME`, `PAYMENTS_LIVE_CONFIRMED`, `PAYMENTS_ALLOW_REFUNDS` | Приём оплат | Оплата выключена; заявки и счета работают, кнопка оплаты не показывается |
| `PAYMENT_PROVIDER=mpgs`, `MPGS_GATEWAY_URL`, `MPGS_MERCHANT_ID`, `MPGS_API_PASSWORD`, `MPGS_MERCHANT_NAME`, `MPGS_CURRENCY=AED` и `NEXT_PUBLIC_SITE_URL`; для утверждённого временного приёма — `MPGS_INTERCOMPANY_AUTHORIZED=1`, `MPGS_AGREEMENT_REF`, `MPGS_BENEFICIARY_LEGAL_NAME` | Приём оплат через Mastercard MPGS (`docs/MPGS_PAYMENTS.md`) | Без адреса сайта или без любой из переменных шлюза оплата выключена; без переменных временного приёма требуются `MERCHANT_VERIFIED` и `MERCHANT_LEGAL_NAME` |

Webhook провайдера: `https://www.maximus.vegas/api/payments/stripe/webhook`, события `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`.

## 3. Включение оплаты (порядок)

1. Подтвердить действующую лицензию MAXIMUS VEGAS L.L.C-FZ и допуск этой деятельности у провайдера; юридическое имя на аккаунте мерчанта должно быть ровно `MAXIMUS VEGAS L.L.C-FZ`. Действующий вариант до появления собственного мерчанта — утверждённый владельцем временный приём через эквайринг Maximus Sports по внутреннему соглашению (`docs/MPGS_PAYMENTS.md`): получателем в счёте остаётся MAXIMUS VEGAS L.L.C-FZ, фактический сборщик платежа раскрывается плательщику, а проверку мерчанта заменяют переменные временного приёма.
2. В центре управления → «Предложения» создать версию с ценой, валютой, налоговым режимом, сроком, текстами условий и возврата на RU и EN; утвердить с основанием (номер решения).
3. Задать переменные в режиме `test`, провести тестовые оплаты на отдельной (не production) базе, проверить квитанции, возврат, истечение.
4. Для `live` — отдельное решение владельца: `PAYMENTS_MODE=live`, live-ключи, `PAYMENTS_LIVE_CONFIRMED=1`. Возвраты — `PAYMENTS_ALLOW_REFUNDS=1` только по отдельному разрешению.

## 4. Проверка после выката (только чтение)

- `GET /api/health` → `{"status":"ok","database":"postgres",…,"email":…,"payments":…}`.
- `/ru/status`, `/en/status` — база, регистрация, письма, оплата; `/en/privacy#services` — фактически подключённые сервисы.
- Открыть без входа: `/ru`, `/ru/tournaments`, `/ru/circuits`, `/ru/membership`, `/ru/matchmaking`, `/ru/signup`, `/ru/help`.
- Миграция 6 применена, если `/ru/circuits` отвечает `200` и показывает раздел (а не страницу направления «в разработке»), а на `/ru/status` модуль «Круговая и швейцарская системы» указан как работающий.
- Release 4 выкачен, если на `/ru/status` модули «Многоэтапные турниры: группы, лиги и плей-офф» и «Лесенка (gauntlet)» указаны как работающие. Миграция 7 применена, если публичные страницы турниров, рейтинги и серии отвечают `200` (запросы читают `matches.stage` и `tournaments.stage`).
- Release 5 выкачен, если на `/ru/status` модули «FFA: лобби с очками за места» и «Регистрация с подтверждением, вопросы и составы» указаны как работающие. Миграция 8 применена, если несуществующее лобби `/ru/lobbies/<uuid>` отвечает `404`, а не ошибкой сервера (страница читает `ffa_lobbies`).
- Release 6 выкачен, если на `/ru/status` модуль «Серии Bo1–Bo7 и очки по уровням» указан как работающий. Миграция 9 применена, если несуществующий матч `/ru/matches/<uuid>` отвечает `404`, а не ошибкой сервера (страница читает `tournaments.series_rules`, `tournaments.match_minutes` и `tournament_venues`).
- `/ru/admin` у сотрудника: без второго фактора — переход на `/ru/admin/security`.
- **Не запускать `scripts/e2e.mjs` против production**: сценарий создаёт аккаунты, турниры и заявки. Он предназначен для локальной сборки или изолированного preview с отдельной базой. Сценарий поднимает локальный приёмник вебхуков, поэтому сервер для него запускается с `MV_WEBHOOK_ALLOW_LOCAL=1` (на production эта переменная игнорируется и не задаётся).
- Площадки: `/ru/venues` отвечает `200`; площадка на проверке по прямой ссылке — `404`; страница пропуска с несуществующим токеном — `404`.
- Цепочки этапов: на `/ru/status` модуль «Цепочки из трёх и более этапов» указан как работающий; миграция 24 применена, если в `schema_migrations` есть строка 24.
- Академия: `/ru/academy` и `/ru/coaches` отвечают `200`; профиль непроверенного тренера по прямой ссылке — `404`; `/ru/coach` и `/ru/training` без входа ведут на вход.
- Медиа: `/ru/media` отвечает `200`; оверлей и JSON несуществующего матча (`/embed/ru/matches/<id>/overlay`, `/api/overlay/matches/<id>`) — `404`.
- Роли и система: сотрудник с одной ролью видит в центре управления только вкладки своих разделов; чужая страница сообщения `/ru/messages/<id>` — `404`; при выключенном обслуживании баннера на страницах нет.
- Интеграции партнёров: `/api/v1/tournaments` без ключа отвечает `401`, виджет `/embed/ru/organizer/<пространство>/calendar` — `200` с заголовком `Content-Security-Policy: frame-ancestors *`, любая страница портала — `X-Frame-Options: DENY`.
- `scripts/browser-smoke.mjs` — те же основные пути в настоящем Chromium: формы отправляются кликом, как у человека, поэтому видны ошибки, которых не видит HTTP-сценарий (заголовки браузера, скрытые кнопки, ошибки клиента). Запуск: `BASE=http://127.0.0.1:3100 node scripts/browser-smoke.mjs`; браузер — из `PLAYWRIGHT_BROWSERS_PATH` или `CHROMIUM_PATH`. Против production не запускается: адрес `maximus.vegas` скрипт отвергает сам.

## 5. Откат

- Код: Vercel → Deployments → предыдущий production deployment → Promote to Production, или `git revert` и push в `main`.
- База: миграции аддитивны, код предыдущего релиза работает поверх них; откат кода не требует отката базы. Удалять таблицы release 2–6 нельзя: в них заявки, счета, журнал оплат, согласия, история монет, зафиксированные таблицы сезонов, история составов, шаблоны, результаты FFA, площадки и оценки.
- **Перед откатом на версию без цепочек этапов** (до миграции 24): код без цепочек работает поверх миграции 24 — она только расширяет проверки номера этапа, ключ слота матча прежний. Турнир с цепочкой (`format_settings.chain`) в статусах IN_PROGRESS и PAUSED продолжит принимать результаты текущего этапа, но следующий этап не создаётся, а публичная страница показывает этап цепочки как плей-офф. Если такие турниры идут — исправлять вперёд или предупредить организаторов; после возврата новой версии пауза и возобновление турнира переводят завершённый этап дальше (R74).
- **Перед откатом на release 5**: код release 5 работает поверх миграции 9, но не проверяет счёт серий и критерии допуска; площадки, распределение волнами, оценки и история недоступны, данные сохраняются. Если идут турниры с правилами серий или допуском — исправлять вперёд или предупредить судей о ручной сверке счёта серий (R36).
- **Перед откатом на release 4** убедиться, что нет турниров формата `ffa` в статусах DRAFT, PUBLISHED, REGISTRATION_OPEN, REGISTRATION_CLOSED, IN_PROGRESS и PAUSED и нет заявок со статусом `pending`: код release 4 не знает формата FFA и статусов рассмотрения. Если они есть — исправлять вперёд или сначала завершить FFA и решить заявки. После отката подтверждение заявок, вопросы, сроки, фиксация составов и льготное время не применяются; шаблоны недоступны, но их данные сохраняются. Для турниров форматов release 1–4 откат безопасен: код release 4 проверен на базе с миграцией 8.
- **Перед откатом на release 3** убедиться, что нет турниров в статусах IN_PROGRESS и PAUSED с форматом `groups` или `gauntlet` либо с плей-офф в настройках круговой и швейцарской: код release 3 не знает этих форматов и этапа плей-офф. Если такие турниры идут — исправлять вперёд, а не откатывать. Для турниров форматов release 1–3 откат на release 3 безопасен: код release 3 проверен на базе с миграцией 7.
- **Перед откатом на release 2** убедиться, что нет турниров `round_robin` и `swiss` в статусах IN_PROGRESS и PAUSED: код release 2 не знает этих форматов и завершит такой турнир после первого же результата. Если такие турниры идут — исправлять вперёд, а не откатывать.
- Если откат выполнен при включённой оплате: сначала выключить `PAYMENTS_ENABLED`, дождаться обработки webhooks текущих попыток; события, пришедшие во время отката, провайдер повторит — обработка идемпотентна.
- Резервные копии: point-in-time restore провайдера базы. Перед включением оплаты зафиксировать, что восстановление проверено.

## 6. Инциденты

| Симптом | Проверка | Действие |
| --- | --- | --- |
| Страницы показывают «Сервис данных не подключён» | `/api/health` → `not_configured` / `unreachable` | Проверить `DATABASE_URL`, выполнить Redeploy |
| Письма не уходят | Центр управления → «Письма»: статусы `failed`, текст ошибки | Проверить `MAIL_FROM`, ключ, подтверждение домена у провайдера; «Обработать очередь сейчас» |
| Участник оплатил, счёт открыт | «Оплаты» → попытка `processing` / `open` | «Сверить с провайдером»; проверить доставку webhook и `STRIPE_WEBHOOK_SECRET` |
| Webhook отвечает 400 | Журнал Vercel `[webhook]` | Неверный секрет или тело изменено прокси; секрет должен соответствовать endpoint |
| Сотрудник потерял телефон | Резервный код или сброс фактора другим администратором («Безопасность») | После сброса — повторное подключение |
| Нужно исправить результат после сыгранного следующего матча | Портал блокирует исправление | Решение по регламенту организатора; фиксируется в журнале |
| Основной этап сыгран, плей-офф не появился | Страница управления: предупреждение об открытых спорах по матчам основного этапа | Решить споры; решение последнего запускает плей-офф автоматически |
| Участник плей-офф дисквалифицирован до своего матча | Страница управления: «Пересоздать плей-офф» доступно до первого результата плей-офф | Пересоздать: место займёт следующий по таблице основного этапа; иначе матч засчитан сопернику |
| Заявки пропали при старте турнира | Страница управления: статус «Отклонена», отметка «не рассмотрена до старта» | Заявки без решения закрываются при старте по правилу (R30); вернуть участника в начавшийся турнир нельзя — решение по регламенту организатора, запись в журнале |
| Раунд FFA сыгран, следующий не появился | Страница лобби: открытые споры по играм раунда; на странице управления — лобби со статусом «Идёт» | Решить споры (оставить в силе или исправить результат); решение последнего запускает следующий раунд автоматически |
| Неверный результат игры FFA прежнего раунда | Портал отклоняет исправление (`stage_locked`) после старта следующего раунда | Решение по регламенту организатора; фиксируется в журнале |
| Судья не может записать счёт 16:10 в финале | Сообщение `invalid_series_score`; на странице матча — формат серии и его уровень | Счёт серии — число выигранных игр (Bo3: 2:0 или 2:1); счёт карты — в примечании или доказательстве; до первого результата судья может изменить формат матча |
| Перенос не сохраняется: «Пересечение в расписании» | Управление → «Площадки и расписание»: список пересечений | Выбрать другое время или площадку; если пересечение допустимо (например, шоу-матч), отметить «Сохранить даже с пересечениями» — решение попадёт в журнал |
| Никто не может зарегистрироваться | Регистрация показывает критерии допуска; почта портала не подключена | Снять критерий «подтверждённый email» до подключения почты (N5); критерии меняются только до первой заявки |
| Нарушена цепочка журнала | `/admin?tab=audit` | Сохранить выгрузку базы, выяснить источник прямого изменения |
| Функция работает с ошибкой или ею злоупотребляют | Центр управления → «Система» → «Функции» | «Выключить» с заметкой для коллег: новое не начинается, начатое завершается; включить после исправления (действует во всех экземплярах в течение секунды) |
| Нужны работы, при которых игроки не должны ничего менять | «Система» → «Режим обслуживания» (код второго фактора не старше 15 минут) | Включить с текстом для пользователей: на страницах баннер, действия игроков отклоняются, вход и выход работают; после работ выключить |
| Жалоба на тренера | Центр управления → «Тренеры» | Приостановить с ответом (от 10 символов): профиль скрыт, заявки без ответа отклонены; при необходимости открыть обучение (просмотр пишется в журнал) |
| Организатор просит убрать чужую или неуместную ссылку на трансляцию | Страница турнира → «Трансляции и записи» | Менеджер турнира или сотрудник раздела «Честная игра» удаляет ссылку на странице управления турниром; удаление в журнале |
| Маркетинговое сообщение получили не все в сегменте | «Сообщения» → отправленные: «без согласия», «лимит частоты» | Ожидаемо: без согласия на рассылки и сверх 2 маркетинговых за 7 дней сообщение не доставляется; операционные сообщения так не ограничены |

## 7. Администратор

Первый администратор — `/ru/admin/claim` с кодом владельца (действует, пока администраторов нет) или с `ADMIN_BOOTSTRAP_TOKEN`. Владелец, который не может войти в свой аккаунт (пароль не подходит, а восстановление по почте недоступно, пока почта не подключена — O-01), открывает ту же страницу без входа: логин аккаунта, код владельца и новый пароль задают пароль, завершают другие сеансы и выдают права администратора (C-34). Эта форма работает только пока администраторов нет. Затем — подключение второго фактора на `/ru/admin/security`. Дальнейшие роли — `/ru/admin?tab=users` (с повторной проверкой второго фактора): поддержка, модерация, судейство, финансы, комплаенс, аналитика, маркетинг, инфраструктура; разделы каждой роли — ARCHITECTURE §9.6. Новый сотрудник при первом входе подключает второй фактор.
# Database TLS (C-37)

Remote PostgreSQL uses certificate and hostname verification by default. `DATABASE_TLS_MODE=verify-full` is the supported remote setting. `DATABASE_TLS_CA` optionally contains the provider's approved PEM CA (literal or escaped newlines); absent this setting, the Node trust store is used. Do not paste credentials or CA private keys into tickets. URL SSL parameters are removed before creating the pool so they cannot override this policy. Insecure remote URL modes are rejected. `disable` is allowed only for actual loopback hosts in isolated development/CI, never a hostname merely containing “localhost”.

Before release, the database operator must confirm the actual provider CA/hostname and run an isolated connection acceptance: trusted endpoint connects, wrong hostname and untrusted certificate fail. This code change does not inspect or change production secrets or certify the deployed connection configuration. If verification fails, fix the trust configuration; do not restore an insecure bypass.

## C-37 runtime configuration and acceptance

Payment boundary: temporary **Maximus Sports MPGS** membership collection is approved under the documented internal arrangement; disclose the collector and MAXIMUS VEGAS L.L.C-FZ beneficiary. This is not permission for paid tournament entry or cash prizes. Skins remain simulated **TEST MODE**. Never bypass a 401 by relaxing merchant gates or inventing credentials. Follow `docs/MPGS_PAYMENTS.md`; retain secret values in the deployment secret manager.

Signup budgets persist in PostgreSQL. Defaults: 10/hour and 50/day per IP, 5/hour and 20/day per browser cookie. `SIGNUP_IP_HOURLY`, `SIGNUP_IP_DAILY` can be set to positive bounded integers. The opaque HttpOnly cookie is a supplementary abuse signal, not a device fingerprint or proof of identity. Resetting a cookie does not reset the IP budget. Vercel uses its protected forwarded address; custom proxies require `TRUST_SIGNUP_PROXY=1` only when they strip untrusted incoming forwarded headers. Missing addresses share a conservative unknown-address bucket. Loopback addresses are not exempt.

Evidence uploads: decode fully with Sharp, reject malformed/multiframe/excess-pixel images, strip metadata, orient and normalize to lossless WebP (maximum 4096px side, existing byte cap). Private original bytes, MIME type and SHA-256 are retained in the same media record; quota includes both versions. The evidence route serves only the normalized copy under the existing access controls. Set an owner-approved retention policy before launch; no cleanup of production evidence is performed by this change.

CSP: HTML responses use a per-request nonce with dynamic rendering; scripts require the nonce/strict-dynamic. Inline styles remain permitted for current components/Leaflet. Inspect reports and test new integrations before extending source lists. API/media/MPGS pages keep their stricter route-specific policies. Cache-control prevents serving another request's HTML nonce.

Errors: structured JSON logs omit raw exception messages, bodies, cookies, credentials and account identifiers. Optional `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` must be an HTTPS OTLP logs endpoint; `OTEL_EXPORTER_OTLP_HEADERS` holds percent-encoded key=value header pairs in the environment secret store. The exported service name is `maximus-vegas`. An exporter failure logs bounded metadata and does not replace the user-facing response. Configure collector retention and alert routing; confirm a controlled staging error arrives with its event/request ID. No collector account has been provisioned here.

`vercel.json` includes `/api/cron/community` and `/api/cron/broadcasts` every minute. Confirm that the hosting plan supports this frequency, or use one authenticated external scheduler at that cadence. Keep `CRON_SECRET` in the scheduler/deployment secret stores, never in a URL. Do not enable two independent schedulers. Require fresh `system_runs` heartbeats and successful cleanup after a terminated client; configuration alone is not heartbeat proof. Voice and native studio remain gated by their actual runtime prerequisites and live acceptance.

Run `npm run acceptance:tournaments` on the candidate commit, followed by the complete CI workflow. This is isolated domain acceptance; real devices, emails, game accounts and payment acceptance are listed in `docs/QA_REMEDIATION.md`.

`sponsor.toggle` is retained for compatibility. No current frontend caller was found (`rg 'sponsor.toggle' src` identifies the route only); mark for a separate removal proposal after checking external clients and deployment logs. C-37 explicitly supersedes C-36's deletion proposal and localhost signup exemption; no removal is authorized by this audit.

Database URLs must put the target hostname in the authority (`postgresql://…@host/database`), not `host` or `hostaddr` query overrides. The actual `pg` connection parser is tested to ensure `ssl=0`, `ssl=true` and libpq options cannot replace the explicit verified TLS/CA configuration. No secret values are required in an audit report.
