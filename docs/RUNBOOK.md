# Runbook: развёртывание, проверка, откат

Title: Runbook · Status: FINAL · Version: 1.0 · Date: 27 September 2026

## Развёртывание

1. Push в `main` репозитория `MAXIMUS-NPiO/maximus-vegas` → Vercel собирает production (`npm ci`, `npm run build`).
2. База: переменная `DATABASE_URL` (Neon / Vercel Postgres). Схема создаётся автоматически при первом запросе к данным — таблица `schema_migrations`, advisory-блокировка исключает параллельный прогон.
3. Проверка после выката:
   - `GET https://www.maximus.vegas/api/health` → `{"status":"ok","database":"postgres"}`;
   - `/ru/status` — задержка базы и реестр модулей;
   - `BASE=https://www.maximus.vegas npm run e2e` — сквозной сценарий (создаёт тестовые записи с уникальным суффиксом).

## Миграции

Миграции — `src/server/schema.ts`, только добавлением новых записей. Применённую миграцию не изменять. Каждая выполняется в транзакции.

## Откат

- Код: Vercel → Deployments → предыдущий production deployment → Promote to Production, или `git revert` и push.
- Данные: миграции release 1 только создают таблицы. Откат кода не требует отката базы.
- Резервные копии: point-in-time restore провайдера базы (Neon — branch/restore).

## Инциденты

| Симптом | Проверка | Действие |
| --- | --- | --- |
| Страницы показывают «Сервис данных не подключён» | `/api/health` → `not_configured` или `unreachable` | Проверить `DATABASE_URL` в Vercel → Settings → Environment Variables, выполнить Redeploy |
| Формы возвращают `bad_origin` | Запрос отправлен не со страницы портала или через иной домен | Открыть портал на основном домене |
| Нужно исправить результат после сыгранного следующего матча | Портал блокирует исправление | Решение по регламенту организатора; изменение фиксируется новой версией и в журнале |
| Нарушена цепочка журнала | `/admin?tab=audit` показывает номер записи | Сохранить выгрузку базы, выяснить источник прямого изменения записи |

## Администратор

Первый администратор — `/ru/admin/claim` с кодом владельца (действует, пока администраторов нет) или с `ADMIN_BOOTSTRAP_TOKEN`.
