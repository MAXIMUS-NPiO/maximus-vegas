# MAXIMUS VEGAS

Двуязычный лендинг для инвесторов и B2B-партнёров. Next.js App Router, React, TypeScript. Отдельные секции, серверная генерация страниц, локальные шрифты, адаптивное меню, FAQ и подготовленный API обращений.

## Запуск

Требуется Node.js 24.

```sh
npm ci
npm run dev
```

Откройте `http://127.0.0.1:3000/ru` или `/en`.

```sh
npm run check
```

Команда проверяет TypeScript, тесты валидации и production-сборку. `npm start` запускает собранную версию.

## Структура

```text
src/app/[lang]/page.tsx       # Композиция главной страницы
src/app/[lang]/layout.tsx     # Язык, шрифты, SEO и шапка
src/app/[lang]/styles.css     # Тема и адаптивная вёрстка
src/app/[lang]/privacy/       # Уведомление об обработке обращений
src/components/sections/     # Hero, Metrics, Ecosystem, Partners,
                             # Business, About, FAQ, Contact, Footer
src/components/header.tsx    # Переключатель языка и мобильное меню
src/components/inquiry-form.tsx
src/lib/content.ts           # Все русские и английские тексты
src/lib/inquiries.ts         # Серверная валидация
src/app/api/inquiries/       # POST → настроенный HTTPS webhook
public/lion-logo.png         # Плоское изображение льва
.github/workflows/ci.yml     # Проверки при push и pull request
```

## GitHub → Vercel

Репозиторий: https://github.com/MAXIMUS-NPiO/maximus-vegas

```sh
git clone https://github.com/MAXIMUS-NPiO/maximus-vegas.git
cd maximus-vegas
npm ci
npm run dev
```

Проект Vercel: `maximus-vegas-landing`, команда `maximus-fdc6`. Root Directory — корень репозитория; production-ветка — `main`. Настройки Next.js заданы в `vercel.json`.

Vercel Git integration создаёт production deployments из `main` и previews из остальных веток после подключения репозитория в Settings → Git. GitHub Actions отдельно проверяет код; при необходимости настройте защиту `main` с обязательным check.

Не используйте GitHub Pages: серверный API этого проекта требует Next.js-хостинг, например Vercel.

## Контакты и обработка обращений

Скопируйте `.env.example` в `.env.local` для локальной работы. На Vercel задайте переменные в Settings → Environment Variables и выполните новый deployment.

| Переменная | Назначение |
| --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Канонический адрес сайта. Если не задан, на Vercel используется адрес production-проекта |
| `NEXT_PUBLIC_CONTACT_EMAIL` | Рабочий email для контактного блока и mailto |
| `LEAD_WEBHOOK_URL` | HTTPS-адрес сервиса, который принимает и сохраняет обращения |
| `LEAD_WEBHOOK_TOKEN` | Серверный Bearer-токен сервиса, если требуется |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Необязательное распределённое ограничение частоты обращений |

Без webhook форма **не принимает данные**. Если email настроен, посетителю доступен прямой контакт. Без обоих каналов выводится честный статус недоступности; перед коммерческим запуском подключите хотя бы email. После изменения этих переменных нужен новый deployment, поскольку страницы генерируются при сборке.

API принимает `name`, `email`, `company`, `interest` (`partnership`, `investment`, `demo`), `message`, `lang` (`ru`, `en`), `consent: true`, пустой `website` (honeypot). Webhook получает эти поля плюс `source` и `receivedAt`. HTTP 2xx от webhook считается подтверждением приёма: endpoint должен сохранять данные до ответа, дедуплицировать повторные обращения и экранировать сообщения при выводе.

Ограничения: только same-origin JSON, тело до 16 KiB, проверка согласия и полей, таймаут доставки, запрет перенаправлений webhook. При настроенном Redis — до 5 обращений на email за 10 минут. До включения публичной формы добавьте ограничение запросов в Vercel Firewall или в приёмнике; email-лимит сам по себе не предотвращает распределённый спам. Автоматические маркетинговые рассылки не подключены. Проверьте текст privacy notice с учётом выбранного сервиса и процессов компании.

## Контент и границы проекта

Лендинг описывает Tournament Suite на основе предоставленных продуктовых материалов. Он не подключён к игровой платформе и не регистрирует игроков на турниры. Прогнозы выручки, оценки компании, неподтверждённые логотипы партнёров и конфиденциальные документы не опубликованы. Файлы исходного проекта `sources/` не входят в этот репозиторий.

Бизнес-показатели, контакты и условия партнёрства перед публичным использованием подтверждает компания. Исходный сайт по предоставленной ссылке был недоступен для чтения из-за ограничения браузера; эта версия — самостоятельная реализация.

## Изображение льва

`public/lion-logo.png` создано встроенным imagegen по запросу пользователя. Prompt: “Symmetrical geometric lion head in bold ivory, transparent background, flat vector-like styling, no text, container, gold, gradients, shadows, or 3D.” Изображение используется в шапке, подвале и favicon. 3D-иллюстрация в проект не включена.
