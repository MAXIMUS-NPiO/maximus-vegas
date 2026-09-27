# MAXIMUS VEGAS — игровой портал

Портал www.maximus.vegas: аккаунты, игровой паспорт, команды, пространства организаторов, турниры на выбывание, игровой день, проверка результатов, споры, итоги, рейтинги, центр управления и журнал решений с hash-цепочкой. Интерфейс RU / EN.

Оператор портала — MAXIMUS VEGAS L.L.C-FZ, Meydan Free Zone, Dubai, UAE. Портал не содержит ставок, азартных игр, игр на деньги и призовых фондов из взносов игроков.

## Стек

- Next.js 16 (App Router, Turbopack), React 19, TypeScript
- PostgreSQL (production) через `pg`; встроенный PostgreSQL (PGlite) для локального запуска и тестов
- Формы работают без JavaScript: `POST /api/a/<action>` → `303` обратно на страницу
- Без внешних UI-библиотек; шрифт Manrope из `@fontsource-variable/manrope`

## Запуск

Требуется Node.js 24.

```sh
npm ci
npm run dev                  # http://127.0.0.1:3000/ru — встроенная база в .data/pglite
npm run check                # TypeScript + тесты + production-сборка
npm run build && MV_LOCAL=1 npm start
BASE=http://127.0.0.1:3000 npm run e2e   # сквозной HTTP-сценарий на запущенном портале
```

Без `DATABASE_URL` локально используется встроенная база. На Vercel без `DATABASE_URL` портал работает, а страницы с данными честно показывают, что сервис данных не подключён; `/api/health` возвращает `503`.

## Переменные окружения

| Переменная | Назначение |
| --- | --- |
| `DATABASE_URL` (или `POSTGRES_URL`) | Подключение к PostgreSQL. Схема создаётся и обновляется автоматически при первом запросе |
| `NEXT_PUBLIC_SITE_URL` | Канонический адрес, например `https://www.maximus.vegas` |
| `NEXT_PUBLIC_CONTACT_EMAIL` | Публичный email (по умолчанию `info@maximus.ltd`) |
| `ADMIN_BOOTSTRAP_TOKEN` | Необязательно: секрет ≥ 24 символов для выдачи прав администратора на `/ru/admin/claim` |
| `LEAD_WEBHOOK_URL`, `LEAD_WEBHOOK_TOKEN` | Необязательно: копия заявок во внешнюю CRM (заявки всегда сохраняются в базе) |
| `DATABASE_POOL_MAX` | Необязательно: размер пула соединений (по умолчанию 5) |

## Первый администратор

Войдите в свой аккаунт и откройте `/ru/admin/claim`. Код владельца передан лично; в репозитории хранится только его SHA-256. Код работает, пока на платформе нет ни одного администратора. Дальнейшие роли выдаются в `/ru/admin?tab=users`.

## GitHub → Vercel

Репозиторий: https://github.com/MAXIMUS-NPiO/maximus-vegas. Проект Vercel `maximus-vegas-landing`; production собирается из `main`, остальные ветки — preview. GitHub Actions выполняет `npm run check` на каждый push и pull request.

## Документация

- `docs/ARCHITECTURE.md` — модули, данные, действия API, безопасность
- `docs/RUNBOOK.md` — развёртывание, миграции, проверка, откат
- `docs/MODULES.md` — реестр модулей со статусами
- `docs/RISK_LOG.md` — риски, пробелы и открытые вопросы
- `docs/IP_RECORD.md` — запись компонентов для внутреннего учёта IP (MIPA)
