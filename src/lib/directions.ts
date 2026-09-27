import type { Locale } from "./i18n.ts";

export type ModuleState = "works" | "connect" | "dev" | "research";
type T = { ru: string; en: string };

export type Direction = {
  slug: string;
  kind: string;
  state: ModuleState;
  title: T;
  lead: T;
  scope: { ru: string[]; en: string[] };
  now: T;
  boundary?: T;
};

/** Sections that are part of the target architecture but not yet live. Each page is honest about it. */
export const DIRECTIONS: Direction[] = [
  {
    slug: "matchmaking",
    kind: "community",
    state: "dev",
    title: { ru: "Подбор игры", en: "Matchmaking" },
    lead: { ru: "Поиск соперников и напарников по игре, региону, уровню, ролям, языку и расписанию.", en: "Find opponents and teammates by game, region, level, roles, language and schedule." },
    scope: {
      ru: ["Party и атомарное включение группы в поиск", "Ready check, отмена поиска и dodge", "LFG и LFT: поиск группы и команды", "Объяснение причин подбора без раскрытия чужих данных"],
      en: ["Parties with atomic group queueing", "Ready check, queue cancel and dodge", "LFG and LFT: find a group or a team", "Explained matches without exposing other players' data"],
    },
    now: { ru: "Сейчас соперников дают турнирные сетки, а напарников — команды с приглашениями по имени пользователя.", en: "Today opponents come from tournament brackets, and teammates from teams with username invitations." },
    boundary: { ru: "Подписка не даёт скрытого соревновательного преимущества. Используются только разрешённые издателем данные.", en: "A subscription never gives a hidden competitive advantage. Only publisher-permitted data is used." },
  },
  {
    slug: "circuits",
    kind: "organizer",
    state: "dev",
    title: { ru: "Серии и сезоны", en: "Circuits and seasons" },
    lead: { ru: "Накопительные результаты нескольких турниров, квалификации и переходы между дивизионами.", en: "Cumulative results across tournaments, qualifiers and division moves." },
    scope: {
      ru: ["Версионируемые формулы очков и tie-breakers", "Buchholz, Median Buchholz и Sonneborn-Berger для подходящих форматов", "Квалификация в следующий этап", "История сезонов"],
      en: ["Versioned points formulas and tie-breakers", "Buchholz, Median Buchholz and Sonneborn-Berger for suitable formats", "Qualification to the next stage", "Season history"],
    },
    now: { ru: "Итоговые места каждого турнира уже фиксируются и видны в игровом паспорте участников.", en: "Final placements of every tournament are already recorded and shown in participants' gaming passports." },
  },
  {
    slug: "academy",
    kind: "academy",
    state: "dev",
    title: { ru: "Академия MAXIMUS", en: "MAXIMUS Academy" },
    lead: { ru: "Курсы и программы по играм и уровням, занятия, разборы и измеримый прогресс.", en: "Courses and programmes by game and level, sessions, reviews and measurable progress." },
    scope: {
      ru: ["Программы по играм и уровням", "Бронирование занятий и календарь", "Разбор по видео, replay или разрешённой телеметрии с тайм-кодами", "Командное обучение и школьные программы"],
      en: ["Programmes by game and level", "Session booking and calendar", "Reviews from video, replays or permitted telemetry with timestamps", "Team training and school programmes"],
    },
    now: { ru: "Принимаем заявки от игроков, команд и учебных заведений. Физические академии и адреса не публикуются до подтверждения.", en: "We accept applications from players, teams and schools. Physical academies and addresses are not published until confirmed." },
    boundary: { ru: "Без гарантий роста рейтинга, контракта или стипендии. Работа с несовершеннолетними — только после запуска модуля согласий опекунов.", en: "No guaranteed rank gains, contracts or scholarships. Work with minors only after the guardian-consent module launches." },
  },
  {
    slug: "coaches",
    kind: "coach",
    state: "dev",
    title: { ru: "Тренеры", en: "Coaches" },
    lead: { ru: "Каталог тренеров, запрос на обучение и бронирование занятий.", en: "A coach directory, training requests and session booking." },
    scope: {
      ru: ["Профили тренеров с подтверждённым опытом", "Запрос на обучение и расписание", "Разделение факта, интерпретации модели и рекомендации тренера"],
      en: ["Coach profiles with verified experience", "Training requests and scheduling", "Separation of fact, model interpretation and coach recommendation"],
    },
    now: { ru: "Тренеры могут подать заявку на включение в каталог. Каталог публикуется после проверки.", en: "Coaches can apply to join the directory. It is published after verification." },
  },
  {
    slug: "media",
    kind: "media",
    state: "dev",
    title: { ru: "Медиа", en: "Media" },
    lead: { ru: "Live-центр, расписание трансляций, записи матчей, клипы и совместный разбор.", en: "Live centre, broadcast schedule, match VODs, clips and co-watch reviews." },
    scope: {
      ru: ["Назначение потоков матчам и broadcast center", "Оверлеи с реальными данными турнира", "VOD, клипы и highlights с учётом прав", "Профили авторов"],
      en: ["Assigning streams to matches and a broadcast centre", "Overlays with real tournament data", "VODs, clips and highlights with rights clearance", "Creator profiles"],
    },
    now: { ru: "Результаты и сетки идущих турниров уже доступны в реальном времени на страницах турниров. Авторы могут подать заявку.", en: "Live tournament results and brackets are already on tournament pages. Creators can apply." },
    boundary: { ru: "Никаких вымышленных счётчиков зрителей и логотипов несуществующих спонсоров. Прогнозы зрителей — без ставок.", en: "No invented viewer counts or logos of non-existent sponsors. Viewer predictions carry no stakes." },
  },
  {
    slug: "community",
    kind: "community",
    state: "dev",
    title: { ru: "Сообщества", en: "Communities" },
    lead: { ru: "Сообщества по играм, друзьям, командам и клубам с модерацией.", en: "Communities by game, friends, teams and clubs, with moderation." },
    scope: {
      ru: ["Модерируемые обсуждения и личные сообщения", "Жалобы, блокировки и приватность", "Ограничения общения для несовершеннолетних"],
      en: ["Moderated discussions and direct messages", "Reports, blocks and privacy", "Communication limits for minors"],
    },
    now: { ru: "Команды, публичные профили и уведомления уже работают. Организаторы сообществ могут подать заявку.", en: "Teams, public profiles and notifications already work. Community organisers can apply." },
  },
  {
    slug: "venues",
    kind: "venue",
    state: "dev",
    title: { ru: "Клубы и площадки", en: "Clubs and venues" },
    lead: { ru: "MAXIMUS Games House, киберспортивные клубы и Clubhouse: каталог, карта, события и бронирование.", en: "MAXIMUS Games House, esports clubs and Clubhouse: directory, map, events and booking." },
    scope: {
      ru: ["Каталог и карта площадок", "События, RSVP и бронирование станций", "QR check-in со сроком действия и защитой от повторного прохода"],
      en: ["Venue directory and map", "Events, RSVPs and station booking", "Time-limited QR check-in protected against reuse"],
    },
    now: { ru: "Владельцы площадок могут подать заявку. Адрес, фото и статус площадки публикуются только после подтверждения.", en: "Venue owners can apply. A venue's address, photos and status are published only after confirmation." },
  },
  {
    slug: "clubhouses",
    kind: "clubhouse",
    state: "dev",
    title: { ru: "Clubhouse", en: "Clubhouse" },
    lead: { ru: "Клубные пространства для офлайн-встреч сообщества и событий портала.", en: "Club spaces for community meet-ups and portal events." },
    scope: {
      ru: ["Зоны, станции и оборудование", "Бейджи и QR-пропуска", "Связь офлайн-событий с турнирами портала"],
      en: ["Zones, stations and equipment", "Badges and QR passes", "Linking on-site events to portal tournaments"],
    },
    now: { ru: "Приём заявок от операторов пространств. Мобильное приложение Clubhouse не опубликовано в магазинах приложений.", en: "Accepting applications from space operators. The Clubhouse mobile app is not published in app stores." },
  },
  {
    slug: "cloud-gaming",
    kind: "cloud_gaming",
    state: "dev",
    title: { ru: "Облачный гейминг", en: "Cloud gaming" },
    lead: { ru: "P2P Cloud Gaming: игрок получает удалённую игровую сессию, GPU-хост предоставляет ресурс.", en: "P2P Cloud Gaming: a player gets a remote game session; a GPU host provides the hardware." },
    scope: {
      ru: ["Реестр узлов и безопасное подключение агента", "WebRTC, STUN/TURN и изоляция сессий", "Учёт времени и прозрачная стоимость", "Проверка лицензий, коммерческого streaming и совместимости античита"],
      en: ["Node registry and secure agent enrolment", "WebRTC, STUN/TURN and session isolation", "Time metering and transparent pricing", "Checks for licences, commercial streaming rights and anti-cheat compatibility"],
    },
    now: { ru: "Инфраструктура сессий не запущена. Принимаем заявки игроков и GPU-хостов. Симуляция сессии не выдаётся за облачную игру.", en: "Session infrastructure is not running. We accept applications from players and GPU hosts. A simulated session is never presented as cloud gaming." },
    boundary: { ru: "Без обещаний нулевого ping, гарантированного дохода хоста или запуска любой игры. Хост не получает пароли и токены игрока.", en: "No promises of zero ping, guaranteed host income or running any game. Hosts never receive player passwords or tokens." },
  },
  {
    slug: "server-rentals",
    kind: "server_rental",
    state: "dev",
    title: { ru: "Аренда серверов", en: "Server rentals" },
    lead: { ru: "Выделенные игровые серверы: игра, регион, ресурсы, расписание, резервные копии и логи.", en: "Dedicated game servers: game, region, resources, schedule, backups and logs." },
    scope: {
      ru: ["Запуск и остановка по расписанию", "Резервные копии и журналы", "Доступ по ролям команды"],
      en: ["Scheduled start and stop", "Backups and logs", "Role-based team access"],
    },
    now: { ru: "Серверная инфраструктура не подключена. Оставьте заявку с игрой, регионом и требованиями.", en: "Server infrastructure is not connected. Submit a request with the game, region and requirements." },
  },
  {
    slug: "shop",
    kind: "shop",
    state: "dev",
    title: { ru: "Магазин", en: "Shop" },
    lead: { ru: "Игровые устройства, аксессуары, мерч и разрешённые цифровые товары от оператора.", en: "Gaming devices, accessories, merchandise and permitted digital goods from the operator." },
    scope: {
      ru: ["Каталог с продавцом, условиями доставки и возврата", "Статус заказа, связанный с реальным заказом", "Поддержка покупателей"],
      en: ["A catalogue with seller, delivery and return terms", "Order status tied to a real order", "Customer support"],
    },
    now: { ru: "Продажи не запущены: товары не показываются, пока нет подтверждённых остатков, продавца и условий. Поставщики могут подать заявку.", en: "Sales are not live: products are not shown until stock, seller and terms are confirmed. Suppliers can apply." },
  },
  {
    slug: "marketplace",
    kind: "marketplace",
    state: "dev",
    title: { ru: "Маркетплейс", en: "Marketplace" },
    lead: { ru: "Объявления пользователей: оборудование, услуги и обучение с отзывами и разрешением споров.", en: "User listings: equipment, services and coaching with reviews and dispute resolution." },
    scope: {
      ru: ["Листинги, поиск, фильтры и избранное", "Отзывы, обращения и споры", "Аукционы только для разрешённых товаров, без оплаты за шанс"],
      en: ["Listings, search, filters and favourites", "Reviews, tickets and disputes", "Auctions only for permitted goods, never paying for a chance"],
    },
    now: { ru: "Маркетплейс не запущен. Торговля аккаунтами и чужими игровыми предметами запрещена.", en: "The marketplace is not live. Trading accounts or other people's in-game items is prohibited." },
  },
  {
    slug: "sponsors",
    kind: "sponsor",
    state: "dev",
    title: { ru: "Спонсорам", en: "For sponsors" },
    lead: { ru: "Кабинет спонсора: программы, согласование размещений, материалы и отчёт с методикой атрибуции.", en: "Sponsor workspace: programmes, placement approvals, assets and reporting with an attribution methodology." },
    scope: {
      ru: ["Проверка доступа и договорные статусы", "Кампании и согласованные выплаты", "Показы, переходы и регистрации по согласованной методике"],
      en: ["Access verification and contract statuses", "Campaigns and agreed payouts", "Impressions, clicks and sign-ups under an agreed methodology"],
    },
    now: { ru: "Кабинет в разработке. Заявка на спонсорство сохраняется и рассматривается командой портала.", en: "The workspace is in development. Sponsorship applications are stored and reviewed by the portal team." },
    boundary: { ru: "Без обещаний доходности и гарантированного количества клиентов. Спонсорские призы — только при бесплатном участии и подтверждённых условиях.", en: "No promised returns or guaranteed customer numbers. Sponsored prizes only with free entry and confirmed terms." },
  },
  {
    slug: "inventory",
    kind: "support",
    state: "dev",
    title: { ru: "Инвентарь и прогрессия", en: "Inventory and progression" },
    lead: { ru: "XP, уровни, достижения, сезонные задания и история наград.", en: "XP, levels, achievements, seasonal quests and reward history." },
    scope: {
      ru: ["Раздельный учёт мастерства, участия и лояльности", "Прозрачные условия начисления без двойных начислений", "Баллы без денежной стоимости и без обмена на деньги"],
      en: ["Separate tracking of skill, participation and loyalty", "Transparent earning rules with no double credits", "Points with no cash value and no cash-out"],
    },
    now: { ru: "Инвентарь пуст: наград без реального заказа или подтверждённого результата не бывает. Ваши подтверждённые результаты — в игровом паспорте.", en: "The inventory is empty: there are no rewards without a real order or a confirmed result. Your confirmed results are in your gaming passport." },
    boundary: { ru: "Никаких платных случайных наград, торговли шансом и давления на покупку.", en: "No paid random rewards, trading in chance or purchase pressure." },
  },
  {
    slug: "billing",
    kind: "support",
    state: "connect",
    title: { ru: "Платежи и подписки", en: "Billing and subscriptions" },
    lead: { ru: "Счета, подписки на программные услуги, возвраты и история операций.", en: "Invoices, software subscriptions, refunds and transaction history." },
    scope: {
      ru: ["Учёт в целых минимальных единицах валюты с двойной записью", "Сверка с платёжным провайдером и защита от повторной оплаты", "Возвраты с историей корректировок"],
      en: ["Accounting in integer minor units with double entry", "Provider reconciliation and duplicate-payment protection", "Refunds with an adjustment history"],
    },
    now: { ru: "Платёжный провайдер не подключён: на портале нет платных операций, всё участие бесплатно.", en: "No payment provider is connected: there are no paid operations on the portal and all participation is free." },
    boundary: { ru: "Кошелёк с выводом денег, хранение средств клиентов и денежные призы из взносов игроков не применяются.", en: "No cash-out wallets, custody of client funds or prize money from player fees." },
  },
];

export const directionBySlug = (slug: string) => DIRECTIONS.find((d) => d.slug === slug);

export type ModuleEntry = { state: ModuleState; name: T; note: T };

export const MODULES: ModuleEntry[] = [
  { state: "works", name: { ru: "Аккаунты и сессии", en: "Accounts and sessions" }, note: { ru: "Регистрация 18+, вход, выход, смена пароля, управление сессиями, ограничение попыток входа.", en: "18+ sign-up, sign-in, sign-out, password change, session management, sign-in rate limiting." } },
  { state: "works", name: { ru: "Игровой паспорт", en: "Gaming passport" }, note: { ru: "Профиль с историей матчей и турниров; у каждого результата — событие, дата и способ проверки.", en: "Profile with match and tournament history; each result shows the event, date and verification method." } },
  { state: "works", name: { ru: "Команды", en: "Teams" }, note: { ru: "Владелец, капитан, приглашения с принятием и отказом, передача полномочий.", en: "Owner, captain, invitations with accept/decline, role transfer." } },
  { state: "works", name: { ru: "Пространства организаторов", en: "Organiser spaces" }, note: { ru: "Сотрудники с ролями владельца, администратора и судьи; изоляция прав между пространствами.", en: "Staff with owner, administrator and referee roles; permissions isolated between spaces." } },
  { state: "works", name: { ru: "Турнирный движок: олимпийская система", en: "Tournament engine: single elimination" }, note: { ru: "Любое число участников, проходы без игры для верхних посевов, посев, лист ожидания, check-in, состояния с разрешёнными переходами.", en: "Any participant count, byes for top seeds, seeding, waitlist, check-in, states with allowed transitions." } },
  { state: "works", name: { ru: "Игровой день и результаты", en: "Game Day and results" }, note: { ru: "Отчёт участника, подтверждение соперника, споры, решение судьи, неявка, дисквалификация, исправление с версиями.", en: "Participant report, opponent confirmation, disputes, referee decision, no-show, disqualification, versioned correction." } },
  { state: "works", name: { ru: "Итоги и рейтинги", en: "Standings and rankings" }, note: { ru: "Итоговые места и таблицы по играм только из подтверждённых матчей.", en: "Final placements and per-game tables from confirmed matches only." } },
  { state: "works", name: { ru: "Центр управления", en: "Control centre" }, note: { ru: "Пользователи, роли, блокировки с причиной, очередь споров, очередь заявок, журнал с проверкой hash-цепочки.", en: "Users, roles, reasoned suspensions, dispute queue, application queue, log with hash-chain verification." } },
  { state: "works", name: { ru: "Заявки партнёров и направлений", en: "Partner and direction applications" }, note: { ru: "Сохраняются в базе и попадают в рабочую очередь администрации.", en: "Stored in the database and routed to the administration work queue." } },
  { state: "works", name: { ru: "Уведомления на портале", en: "In-portal notifications" }, note: { ru: "Приглашения, готовность матча, результаты, споры, изменения турнира.", en: "Invitations, match readiness, results, disputes, tournament changes." } },
  { state: "works", name: { ru: "Приватность данных", en: "Data privacy" }, note: { ru: "Публичность профиля, выгрузка своих данных, удаление аккаунта с обезличиванием.", en: "Profile visibility, personal data export, account deletion with anonymisation." } },
  { state: "works", name: { ru: "Интерфейс RU / EN", en: "RU / EN interface" }, note: { ru: "Локализованные маршруты и переключение языка на той же странице.", en: "Localised routes and switching language on the same page." } },
  { state: "connect", name: { ru: "Восстановление доступа по email", en: "Email account recovery" }, note: { ru: "Требуется почтовый сервис. Сейчас восстановление — через поддержку.", en: "Requires an email service. Recovery currently goes through support." } },
  { state: "connect", name: { ru: "Интеграции с издателями игр", en: "Game publisher integrations" }, note: { ru: "Требуются одобренный доступ и ключи (Riot RSO, Steam, PUBG API и др.). До подключения — ручная проверка с доказательствами.", en: "Requires approved access and keys (Riot RSO, Steam, PUBG API, etc.). Until then, manual verification with evidence." } },
  { state: "connect", name: { ru: "Серверный контур CS2", en: "CS2 server contour" }, note: { ru: "Provisioning, RCON, demo и восстановление матчей — на отдельной инфраструктуре.", en: "Provisioning, RCON, demos and match recovery run on separate infrastructure." } },
  { state: "connect", name: { ru: "Загрузка файлов-доказательств", en: "Evidence file uploads" }, note: { ru: "Требуется файловое хранилище. Сейчас доказательства — ссылками.", en: "Requires object storage. Evidence is currently provided as links." } },
  { state: "connect", name: { ru: "Платежи и подписки", en: "Payments and subscriptions" }, note: { ru: "Провайдер под допустимый сценарий не подключён; платных операций нет.", en: "No provider for a permitted scenario is connected; there are no paid operations." } },
  { state: "connect", name: { ru: "White-label домены", en: "White-label domains" }, note: { ru: "Собственный домен и оформление партнёра.", en: "Partner's own domain and branding." } },
  { state: "dev", name: { ru: "Форматы: double elimination, round robin, Swiss, группы, лиги, FFA", en: "Formats: double elimination, round robin, Swiss, groups, leagues, FFA" }, note: { ru: "Включая Buchholz, Median Buchholz и Sonneborn-Berger.", en: "Including Buchholz, Median Buchholz and Sonneborn-Berger." } },
  { state: "dev", name: { ru: "Серии и сезоны", en: "Circuits and seasons" }, note: { ru: "Накопительные результаты, квалификации, дивизионы.", en: "Cumulative results, qualifiers, divisions." } },
  { state: "dev", name: { ru: "Подбор игры, LFG, LFT, рекрутинг", en: "Matchmaking, LFG, LFT, recruiting" }, note: { ru: "Party, ready check, история рейтинга.", en: "Parties, ready check, rating history." } },
  { state: "dev", name: { ru: "Академия и тренеры", en: "Academy and coaches" }, note: { ru: "Программы, бронирование, разборы.", en: "Programmes, booking, reviews." } },
  { state: "dev", name: { ru: "Медиа и трансляции", en: "Media and broadcasts" }, note: { ru: "Live-центр, VOD, клипы, оверлеи.", en: "Live centre, VODs, clips, overlays." } },
  { state: "dev", name: { ru: "Сообщества, сообщения, голос", en: "Communities, messages, voice" }, note: { ru: "С модерацией и ограничениями для несовершеннолетних.", en: "With moderation and limits for minors." } },
  { state: "dev", name: { ru: "Площадки, Clubhouse, QR check-in", en: "Venues, Clubhouse, QR check-in" }, note: { ru: "Только подтверждённые адреса и статусы.", en: "Confirmed addresses and statuses only." } },
  { state: "dev", name: { ru: "Прогрессия: XP, уровни, достижения", en: "Progression: XP, levels, achievements" }, note: { ru: "Без денежной стоимости баллов.", en: "Points have no cash value." } },
  { state: "dev", name: { ru: "Магазин и маркетплейс", en: "Shop and marketplace" }, note: { ru: "Только реальные заказы и подтверждённые товары.", en: "Real orders and confirmed goods only." } },
  { state: "dev", name: { ru: "Кабинет спонсора, API, webhooks, виджеты", en: "Sponsor workspace, API, webhooks, widgets" }, note: { ru: "Подписанные webhooks и тестовая среда.", en: "Signed webhooks and a sandbox." } },
  { state: "dev", name: { ru: "ИИ-помощники игрока, организатора, тренера", en: "AI assistants for players, organisers, coaches" }, note: { ru: "Действуют в пределах серверных прав; критичные действия подтверждает человек.", en: "Act within server-side permissions; critical actions are confirmed by a human." } },
  { state: "dev", name: { ru: "Опекуны, школы и благополучие", en: "Guardians, schools and wellbeing" }, note: { ru: "Согласия с версиями, лимиты времени и расходов, ограничения контактов.", en: "Versioned consents, time and spending limits, contact restrictions." } },
  { state: "dev", name: { ru: "MFA для сотрудников", en: "Staff MFA" }, note: { ru: "Повторная проверка для чувствительных операций.", en: "Step-up verification for sensitive operations." } },
  { state: "dev", name: { ru: "Облачный гейминг и аренда серверов", en: "Cloud gaming and server rentals" }, note: { ru: "Отдельная инфраструктура; сейчас принимаются заявки.", en: "Separate infrastructure; applications are accepted now." } },
  { state: "dev", name: { ru: "Gamer dating 18+", en: "Gamer dating 18+" }, note: { ru: "Отдельный добровольный продукт со своим согласием; не смешивается со школьными и детскими пространствами.", en: "A separate opt-in product with its own consent; never mixed with school or youth spaces." } },
  { state: "research", name: { ru: "Собственный античит и ML-сигналы", en: "Own anti-cheat and ML signals" }, note: { ru: "Kernel-компонент не включается автоматически; сигналы модели — повод для проверки, не доказательство.", en: "No kernel component by default; model signals trigger review, they are not proof." } },
  { state: "research", name: { ru: "Анализ CCTV для безопасности площадок", en: "CCTV analytics for venue security" }, note: { ru: "Только при отдельном обосновании и допустимости.", en: "Only with separate justification and permissibility." } },
  { state: "research", name: { ru: "Анализ реакции зрачка", en: "Pupil-reaction analysis" }, note: { ru: "Не применяется к игрокам: никаких выводов о здоровье, личности или честности.", en: "Not applied to players: no conclusions about health, personality or honesty." } },
  { state: "research", name: { ru: "Идентичность ACEXIS", en: "ACEXIS identity" }, note: { ru: "Направление цифровых решений из учёта IP; не является игровым продуктом.", en: "A digital-solutions direction from the IP register; not a gaming product." } },
  { state: "research", name: { ru: "ИИ-аналитика продаж, персонализированные новости и лояльность", en: "AI sales analytics, personalised news and loyalty" }, note: { ru: "Для партнёрских программ и разрешённых рекомендаций.", en: "For partner programmes and permitted recommendations." } },
];

export const IP_DIRECTIONS: T[] = [
  { ru: "Аналитика продаж товаров и услуг на базе ИИ", en: "AI-based analytics of sales of goods and services" },
  { ru: "Персонализированные новости, лояльность и бонусные программы", en: "Personalised news, loyalty and bonus programmes" },
  { ru: "Анализ CCTV-видеопотоков для безопасности", en: "CCTV video stream analysis for security" },
  { ru: "Анализ реакции зрачка для идентификации и функционального состояния", en: "Pupil-reaction analysis for identification and functional state" },
  { ru: "Цифровые решения и идентичность ACEXIS", en: "Digital solutions and the ACEXIS identity" },
];

export const t = (value: T, lang: Locale) => value[lang];
