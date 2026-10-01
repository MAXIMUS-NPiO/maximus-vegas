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
    now: { ru: "Заявка на спонсорство сохраняется и рассматривается командой портала. Спонсоры показываются на портале и в турнирах только после того, как администратор внесёт подтверждённую запись.", en: "Sponsorship applications are stored and reviewed by the portal team. Sponsors appear on the portal and in tournaments only after an administrator enters a confirmed record." },
    boundary: { ru: "Без обещаний доходности и гарантированного количества клиентов. Спонсорские призы — только при бесплатном участии и подтверждённых условиях.", en: "No promised returns or guaranteed customer numbers. Sponsored prizes only with free entry and confirmed terms." },
  },
];

export const directionBySlug = (slug: string) => DIRECTIONS.find((d) => d.slug === slug);

export type ModuleEntry = { state: ModuleState; name: T; note: T };

export const MODULES: ModuleEntry[] = [
  { state: "works", name: { ru: "Аккаунты и сессии", en: "Accounts and sessions" }, note: { ru: "Регистрация 18+ с фиксацией принятых версий условий, вход, выход, смена пароля, управление сессиями, ограничение попыток входа.", en: "18+ sign-up recording the accepted terms versions, sign-in, sign-out, password change, session management, sign-in rate limiting." } },
  { state: "works", name: { ru: "Игровой паспорт и репутация", en: "Gaming passport and reputation" }, note: { ru: "Профиль с историей матчей и турниров, рангом и репутацией по итогам оспариваний.", en: "Profile with match and tournament history, rank and a reputation score from dispute outcomes." } },
  { state: "works", name: { ru: "Команды", en: "Teams" }, note: { ru: "Владелец, капитан, приглашения, передача полномочий, логотип и баннер.", en: "Owner, captain, invitations, role transfer, logo and banner." } },
  { state: "works", name: { ru: "Пространства организаторов и со-организаторы", en: "Organiser spaces and co-organisers" }, note: { ru: "Роли владельца, администратора и судьи; со-организаторы отдельного турнира; ограничение по странам.", en: "Owner, administrator and referee roles; per-tournament co-organisers; country restrictions." } },
  { state: "works", name: { ru: "Олимпийская система и double elimination", en: "Single and double elimination" }, note: { ru: "Проходы без игры для верхних посевов, нижняя сетка, гранд-финал и перезапуск финала; посев по ручным номерам, затем по XP, затем по порядку регистрации.", en: "Byes for top seeds, losers bracket, grand final and bracket reset; seeding by manual seeds, then XP, then registration order." } },
  { state: "works", name: { ru: "Круговая и швейцарская системы", en: "Round robin and Swiss" }, note: { ru: "Один или два круга; швейцарские пары по очкам без повторных встреч и bye по правилам; ничьи по выбору организатора. Tie-breakers Buchholz, Median Buchholz и Sonneborn-Berger (MV-STANDINGS-1, MV-SWISS-1), настройки фиксируются при старте.", en: "One or two legs; Swiss pairings by points without rematches and rule-based byes; draws at the organiser's choice. Buchholz, Median Buchholz and Sonneborn-Berger tie-breaks (MV-STANDINGS-1, MV-SWISS-1), settings frozen at the start." } },
  { state: "works", name: { ru: "Многоэтапные турниры: группы, лиги и плей-офф", en: "Multi-stage events: groups, leagues and playoffs" }, note: { ru: "Группы змейкой по посеву → плей-офф (олимпийская, двойное выбывание или лесенка); круговая или швейцарская → плей-офф лучших N. Посев плей-офф по местам в группах без встреч одногруппников в первом раунде, даты туров по интервалу, фиксация основного этапа после старта плей-офф (MV-STAGES-1).", en: "Snake-seeded groups → a playoff (single or double elimination, or a gauntlet); round robin or Swiss → a playoff of the top N. Playoff seeding by group place keeping group-mates apart in round one, round dates by interval, the main stage locked once the playoff starts (MV-STAGES-1)." } },
  { state: "works", name: { ru: "Лесенка (gauntlet)", en: "Gauntlet (stepladder)" }, note: { ru: "До 16 участников: нижние посевы играют первыми, победитель поднимается к следующему посеву, первый посев играет только финал; места уникальны.", en: "Up to 16 entrants: the lowest seeds play first, each winner climbs to the next seed, the top seed plays only the final; places are unique." } },
  { state: "works", name: { ru: "Серии и сезоны", en: "Circuits and seasons" }, note: { ru: "Накопительные очки с весом турниров, квалификация в финалы, дивизионы с повышением и понижением, зафиксированная история сезонов в игровом паспорте (MV-CIRCUIT-1).", en: "Cumulative weighted points, qualification to finals, divisions with promotion and relegation, frozen season history in the gaming passport (MV-CIRCUIT-1)." } },
  { state: "works", name: { ru: "Копирование и безопасное пересоздание", en: "Cloning and safe regeneration" }, note: { ru: "Копия турнира в черновик с настройками; пересоздание сетки или тура только до первого результата; предпросмотр структуры до старта.", en: "Copy a tournament into a draft with its settings; regenerate a bracket or round only before the first result; structure preview before the start." } },
  { state: "works", name: { ru: "Leaderboard-турниры", en: "Leaderboard tournaments" }, note: { ru: "Веса статистики, лучшие N результатов, окно отправки, tie-break по KDA и убийствам, проверка неправдоподобных строк (не античит).", en: "Stat weights, best-of-N, submission window, KDA and kills tie-breaks, review of implausible lines (not anti-cheat)." } },
  { state: "works", name: { ru: "Игровой день, результаты и споры", en: "Game Day, results and disputes" }, note: { ru: "Отчёт, подтверждение, check-in к матчу, решение судьи, неявка, дисквалификация, исправление с версиями, оспаривание решённого матча.", en: "Report, confirmation, match check-in, referee decision, no-show, disqualification, versioned correction, disputes of decided matches." } },
  { state: "works", name: { ru: "Итоги, рейтинги и награды", en: "Standings, rankings and awards" }, note: { ru: "Итоговые места из подтверждённых матчей; титулы в рейтинге — первые места завершённых турниров; награда победителю в монетах назначается оператором и выплачивается один раз каждому чемпиону.", en: "Final placements from confirmed matches; ranking titles are first places of completed events; a winner's award in coins is set by the operator and paid once per champion." } },
  { state: "works", name: { ru: "Прогрессия: XP, ранги, цели, сезонный пропуск", en: "Progression: XP, ranks, objectives, season pass" }, note: { ru: "Начисления только за подтверждённую активность, без двойных начислений.", en: "Credits only for confirmed activity, never twice." } },
  { state: "works", name: { ru: "Монеты и косметика", en: "Coins and cosmetics" }, note: { ru: "Монеты без денежной стоимости: не покупаются, не выводятся, не передаются и не ставятся на исход.", en: "Coins with no cash value: never bought, withdrawn, transferred or staked." } },
  { state: "works", name: { ru: "Вызовы 1v1 и быстрый матч", en: "1v1 challenges and quick match" }, note: { ru: "Без ставок; быстрый матч соединяет только с реальными игроками из очереди.", en: "No stakes; quick match pairs only with real players from the queue." } },
  { state: "works", name: { ru: "Реферальная программа", en: "Referral programme" }, note: { ru: "Один код на аккаунт; награда пригласившему — после первого подтверждённого матча приглашённого.", en: "One code per account; the referrer is rewarded after the referee's first confirmed match." } },
  { state: "works", name: { ru: "Изображения: логотипы, баннеры, доказательства", en: "Images: logos, banners, evidence" }, note: { ru: "PNG, JPEG, WebP с проверкой сигнатуры и лимитами; доказательства видят только участники матча и судьи.", en: "PNG, JPEG, WebP with signature checks and limits; evidence is visible only to the match's participants and referees." } },
  { state: "works", name: { ru: "Центр управления и MFA", en: "Control centre and MFA" }, note: { ru: "Вход сотрудников со вторым фактором, повторная проверка для чувствительных решений, журнал с hash-цепочкой.", en: "Staff access with a second factor, step-up for sensitive decisions, hash-chained log." } },
  { state: "works", name: { ru: "Заявки на членство и счета", en: "Membership applications and invoices" }, note: { ru: "Отдельные состояния заявки, счёта, оплаты и членства; условия фиксируются версией.", en: "Separate states for application, invoice, payment and membership; accepted terms are versioned." } },
  { state: "works", name: { ru: "Заявки партнёров и направлений", en: "Partner and direction applications" }, note: { ru: "Сохраняются в базе и попадают в рабочую очередь администрации.", en: "Stored in the database and routed to the administration work queue." } },
  { state: "works", name: { ru: "Уведомления на портале", en: "In-portal notifications" }, note: { ru: "Приглашения, матчи, результаты, споры, вызовы, награды, счета.", en: "Invitations, matches, results, disputes, challenges, awards, invoices." } },
  { state: "works", name: { ru: "Приватность данных", en: "Data privacy" }, note: { ru: "Публичность профиля, выгрузка своих данных, согласие на рассылки отдельно, удаление аккаунта с обезличиванием.", en: "Profile visibility, personal data export, separate marketing consent, account deletion with anonymisation." } },
  { state: "works", name: { ru: "Интерфейс RU / EN", en: "RU / EN interface" }, note: { ru: "Локализованные маршруты и переключение языка на той же странице.", en: "Localised routes and switching language on the same page." } },
  { state: "connect", name: { ru: "Подтверждение email и восстановление доступа", en: "Email confirmation and account recovery" }, note: { ru: "Код готов: одноразовые ссылки со сроком действия и очередь писем с повторами. Нужен почтовый сервис (Resend или SMTP).", en: "Code is ready: single-use expiring links and a retried email queue. Requires an email service (Resend or SMTP)." } },
  { state: "connect", name: { ru: "Онлайн-оплата членства", en: "Online membership payments" }, note: { ru: "Код готов: hosted checkout, проверка подписи webhook, возвраты и споры. Нужны утверждённые условия предложения и подтверждённый мерчант MAXIMUS VEGAS L.L.C-FZ.", en: "Code is ready: hosted checkout, webhook signature checks, refunds and disputes. Requires approved offer terms and a verified MAXIMUS VEGAS L.L.C-FZ merchant." } },
  { state: "connect", name: { ru: "Интеграции с издателями игр", en: "Game publisher integrations" }, note: { ru: "Требуются одобренный доступ и ключи (Riot RSO, Steam, PUBG API и др.). До подключения — ручная проверка с доказательствами.", en: "Requires approved access and keys (Riot RSO, Steam, PUBG API, etc.). Until then, manual verification with evidence." } },
  { state: "connect", name: { ru: "Вход через Google, Steam, Epic", en: "Sign-in with Google, Steam, Epic" }, note: { ru: "Нужны зарегистрированные приложения у провайдеров. Кнопки не показываются, пока вход не настоящий.", en: "Requires registered apps with each provider. The buttons are not shown until sign-in is real." } },
  { state: "connect", name: { ru: "Серверный контур CS2", en: "CS2 server contour" }, note: { ru: "Provisioning, RCON, demo и восстановление матчей — на отдельной инфраструктуре.", en: "Provisioning, RCON, demos and match recovery run on separate infrastructure." } },
  { state: "connect", name: { ru: "White-label домены", en: "White-label domains" }, note: { ru: "Собственный домен и оформление партнёра.", en: "Partner's own domain and branding." } },
  { state: "dev", name: { ru: "Форматы FFA и более двух этапов", en: "FFA formats and more than two stages" }, note: { ru: "Матчи «все против всех» с очками за места и цепочки из трёх и более этапов.", en: "Free-for-all matches with placement points and chains of three or more stages." } },
  { state: "dev", name: { ru: "Party, ready check, LFG, LFT, рекрутинг", en: "Parties, ready check, LFG, LFT, recruiting" }, note: { ru: "Групповой поиск и история рейтинга.", en: "Group queueing and rating history." } },
  { state: "dev", name: { ru: "Академия и тренеры", en: "Academy and coaches" }, note: { ru: "Программы, бронирование, разборы.", en: "Programmes, booking, reviews." } },
  { state: "dev", name: { ru: "Медиа и трансляции", en: "Media and broadcasts" }, note: { ru: "Live-центр, VOD, клипы, оверлеи.", en: "Live centre, VODs, clips, overlays." } },
  { state: "dev", name: { ru: "Сообщества, сообщения, голос", en: "Communities, messages, voice" }, note: { ru: "С модерацией и ограничениями для несовершеннолетних.", en: "With moderation and limits for minors." } },
  { state: "dev", name: { ru: "Площадки, Clubhouse, QR check-in", en: "Venues, Clubhouse, QR check-in" }, note: { ru: "Только подтверждённые адреса и статусы.", en: "Confirmed addresses and statuses only." } },
  { state: "dev", name: { ru: "Магазин и маркетплейс", en: "Shop and marketplace" }, note: { ru: "Только реальные заказы и подтверждённые товары.", en: "Real orders and confirmed goods only." } },
  { state: "dev", name: { ru: "Кабинет спонсора, API, webhooks, виджеты", en: "Sponsor workspace, API, webhooks, widgets" }, note: { ru: "Подписанные webhooks и тестовая среда.", en: "Signed webhooks and a sandbox." } },
  { state: "dev", name: { ru: "ИИ-помощники игрока, организатора, тренера", en: "AI assistants for players, organisers, coaches" }, note: { ru: "Действуют в пределах серверных прав; критичные действия подтверждает человек.", en: "Act within server-side permissions; critical actions are confirmed by a human." } },
  { state: "dev", name: { ru: "Опекуны, школы и благополучие", en: "Guardians, schools and wellbeing" }, note: { ru: "Согласия с версиями, лимиты времени и расходов, ограничения контактов.", en: "Versioned consents, time and spending limits, contact restrictions." } },
  { state: "dev", name: { ru: "Облачный гейминг и аренда серверов", en: "Cloud gaming and server rentals" }, note: { ru: "Отдельная инфраструктура; сейчас принимаются заявки.", en: "Separate infrastructure; applications are accepted now." } },
  { state: "dev", name: { ru: "Gamer dating 18+", en: "Gamer dating 18+" }, note: { ru: "Отдельный добровольный продукт со своим согласием; не смешивается со школьными и детскими пространствами.", en: "A separate opt-in product with its own consent; never mixed with school or youth spaces." } },
  { state: "research", name: { ru: "Проверка статистики через API издателей", en: "Stat verification through publisher APIs" }, note: { ru: "PUBG: телеметрия матча с фильтрацией убийств ботов; CS2: разбор demo по коду матча. Отдельная работа для каждой игры, ключи хранятся только на сервере.", en: "PUBG: match telemetry with bot kills filtered out; CS2: demo parsing from match share codes. Separate work per game; keys live on the server only." } },
  { state: "research", name: { ru: "Собственный античит и ML-сигналы", en: "Own anti-cheat and ML signals" }, note: { ru: "Античит в реальном времени требует компонента на стороне игры и не создаётся сайтом. Сигналы модели — повод для проверки, не доказательство.", en: "Real-time anti-cheat needs a game-side component and cannot be built by a website. Model signals trigger review, they are not proof." } },
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
