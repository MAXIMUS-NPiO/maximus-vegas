# MAXIMUS VEGAS — игровой портал

Портал www.maximus.vegas: аккаунты и игровой паспорт, команды, пространства организаторов, турниры восьми форматов (олимпийская система, double elimination с перезапуском финала, круговая и швейцарская системы с тай-брейками Бухгольца, медианного Бухгольца и Зоннеборна-Бергера, группы с плей-офф, лесенка, FFA-лобби с очками за места, leaderboard) и многоэтапные турниры (группы, круговая или швейцарская → плей-офф) с датами туров, формат серий Bo1–Bo7 и очки по уровням, регистрация с подтверждением, сроком, вопросами и критериями допуска, составы с фиксацией и заменами, площадки и проверка пересечений расписания, оценки участников и история турнира, серии и сезоны с накопительными очками, квалификацией и дивизионами, шаблоны и копирование турниров, безопасное пересоздание сетки, перенос расписания, игровой день, проверка результатов и споры, рейтинги, прогрессия без денежной стоимости (XP, ранги, цели, сезонный пропуск, косметика), вызовы 1v1 и быстрый матч без ставок, необязательное членство со счетами и hosted-оплатой, центр управления со вторым фактором и журналом решений с hash-цепочкой. Интерфейс RU / EN.

Оператор портала — MAXIMUS VEGAS L.L.C-FZ, Meydan Free Zone, Dubai, UAE. На портале нет ставок, азартных игр, игр на деньги, платного входа в турниры, покупки монет и призовых фондов из взносов игроков.

## Стек

- Next.js 16 (App Router), React 19, TypeScript
- PostgreSQL (production) через `pg`; встроенный PostgreSQL (PGlite) для локального запуска и тестов
- Формы работают без JavaScript: `POST /api/a/<action>` → `303` обратно на страницу
- Stripe SDK (hosted Checkout, проверка подписи webhook), Resend или SMTP (Nodemailer) для писем, `uqr` для QR-кода TOTP
- Без внешних UI-библиотек; шрифт Manrope из `@fontsource-variable/manrope`

## Запуск

Требуется Node.js 24.

```sh
npm ci
npm run dev                  # http://127.0.0.1:3000/ru — встроенная база в .data/pglite
npm run check                # TypeScript + тесты + production-сборка
PG_TEST_URL=postgres://… npm test   # плюс тесты параллельности на настоящем PostgreSQL
npm run build && MV_LOCAL=1 npm start
BASE=http://127.0.0.1:3000 npm run e2e   # сквозной HTTP-сценарий — только локально или на изолированном preview
```

Без `DATABASE_URL` локально используется встроенная база. На Vercel без `DATABASE_URL` портал работает, а страницы с данными честно показывают, что сервис данных не подключён; `/api/health` возвращает `503`.

## Переменные окружения

Полный список с пояснениями — `.env.example`. Кратко:

| Переменная | Назначение |
| --- | --- |
| `DATABASE_URL` (или `POSTGRES_URL`) | PostgreSQL. Схема создаётся и обновляется автоматически. Для Preview — отдельная база |
| `NEXT_PUBLIC_SITE_URL` | Канонический адрес `https://www.maximus.vegas`; нужен для ссылок в письмах и возврата после оплаты |
| `NEXT_PUBLIC_CONTACT_EMAIL` | Публичный email (по умолчанию `info@maximus.ltd`) |
| `MAIL_FROM` + `RESEND_API_KEY` или `SMTP_URL` | Доставка служебных писем; без них письма ждут в очереди |
| `SIGNUP_EMAIL_CONFIRMATION` | `required` — регистрация «сначала email» (при подключённой доставке) |
| `MFA_SECRET_KEY` | Шифрование секретов второго фактора сотрудников (AES-256-GCM) |
| `CRON_SECRET` | Защита планового обслуживания (`vercel.json`, ежедневно 03:17 UTC) |
| `PAYMENTS_ENABLED`, `PAYMENTS_MODE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `MERCHANT_VERIFIED`, `MERCHANT_LEGAL_NAME`, `PAYMENTS_LIVE_CONFIRMED`, `PAYMENTS_ALLOW_REFUNDS` | Приём оплат; включается, только когда выполнены все условия и есть утверждённое полное предложение |
| `ADMIN_BOOTSTRAP_TOKEN` | Необязательно: секрет ≥ 24 символов для выдачи прав администратора; удалить после назначения |
| `LEAD_WEBHOOK_URL`, `LEAD_WEBHOOK_TOKEN` | Необязательно: копия заявок во внешнюю CRM (заявки всегда сохраняются в базе) |
| `DATABASE_POOL_MAX` | Необязательно: размер пула соединений (по умолчанию 5) |

## Первый администратор и второй фактор

Войдите в свой аккаунт и откройте `/ru/admin/claim`. Код владельца передан лично; в репозитории хранится только его SHA-256. Код работает, пока на платформе нет ни одного администратора. Затем подключите приложение-аутентификатор на `/ru/admin/security` и сохраните резервные коды: без второго фактора центр управления не открывается.

## Оплата

Платёжный контур реализован, но приём оплат выключен, пока нет утверждённых коммерческих условий членства и подтверждённого мерчанта MAXIMUS VEGAS L.L.C-FZ. Порядок включения — `docs/RUNBOOK.md`, раздел 3.

## GitHub → Vercel

Репозиторий: https://github.com/MAXIMUS-NPiO/maximus-vegas. Проект Vercel `maximus-vegas-landing`; production собирается из `main`, остальные ветки — preview. GitHub Actions выполняет `npm run check` на push в `main` и на pull request.

## Документация

- `docs/ARCHITECTURE.md` — контуры, данные, движок, прогрессия, аккаунты, MFA, оплаты, API, безопасность, тесты
- `docs/RUNBOOK.md` — развёртывание, переменные, включение оплаты, проверка, откат, инциденты
- `docs/MODULES.md` — реестр модулей со статусами
- `docs/HANDOFF_COVERAGE.md` — покрытие технического handoff и исключения
- `docs/IMPLEMENTATION_CHECKLIST.md` — разделение юрлиц, взносы, условия, данные
- `docs/RISK_LOG.md` — пробелы (NOT PROVIDED), риски с владельцем и статусом, решения
- `docs/IP_RECORD.md` — запись компонентов для внутреннего учёта IP (MIPA)
- `docs/RELEASE_2.md` — отчёт о выпуске release 2
- `docs/RELEASE_3.md` — отчёт о выпуске release 3: круговая и швейцарская системы, серии и сезоны
- `docs/RELEASE_4.md` — отчёт о выпуске release 4: группы и плей-офф, лиги, лесенка, даты туров
- `docs/RELEASE_5.md` — отчёт о выпуске release 5: FFA, подтверждение заявок, вопросы, составы, шаблоны, перенос расписания, неявка
- `docs/RELEASE_6.md` — отчёт о выпуске release 6: серии и очки по уровням, площадки и пересечения, допуск, оценки, история

## QA remediation and release boundary (C-37)

Audited source: `ccd71006ba85ff5ed7ef38db2eac431d0515ebb7`. The implementation and owner acceptance checklist are in [docs/QA_REMEDIATION.md](docs/QA_REMEDIATION.md). Passing repository tests is not live provider acceptance.

- Tournament entry remains free; cash prizes remain excluded. The skins marketplace stays visibly simulated **TEST MODE**.
- Approved temporary membership collection uses **Maximus Sports MPGS** under the internal arrangement, with MAXIMUS VEGAS L.L.C-FZ as beneficiary and the collector disclosed. Credentials, approved offer terms and live checkout/refund acceptance remain operator tasks. No production payment settings were changed.
- Text chat has persistent backend support. Voice and native studio have separate provider, scheduler, storage/payment gates; `/en/status` and `/ru/status` now report component readiness separately.
- Player scores require a nonempty canonical match reference and HTTPS evidence and enter pending review. An exact retry is idempotent; a rejected score can be corrected in place using its revision and a reason. Rejected matches still consume a game slot. Approved results require rejection before correction.
- Each leaderboard accepts 10–20 games per participant (default 20); best N must fit that cap. Points, KDA and kills use the same selected results. Equal sporting metrics share rank; participant ID supplies stable display order. The owner must approve the precise contract before publishing an event.
- PUBG adapter and Steam/CS2 result interface are **NOT live-verified**. Account lookup is not ownership proof; no test fixtures are served to players. See [docs/GAME_VERIFICATION.md](docs/GAME_VERIFICATION.md).

```bash
npm run check                    # TypeScript, complete test suite, production build
npm run acceptance:tournaments  # Isolated bracket + twenty-game best-five journey
```

The acceptance script always creates an in-memory database and never publishes a public event. Full HTTP/browser and real PostgreSQL concurrency checks also run in CI. External email, provider, device and load acceptance remain separate.
