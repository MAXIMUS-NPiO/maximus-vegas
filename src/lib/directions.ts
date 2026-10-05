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
const DIRECTION_DEFINITIONS: Direction[] = [
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
    now: { ru: "Работают программы проверенных тренеров по играм и уровням, заявки на обучение, занятия в календаре и записи прогресса (наблюдение, рекомендация, замер). ИИ-разбор, командное обучение и школьные программы — в разработке. Физические академии и адреса не публикуются до подтверждения.", en: "Programmes of verified coaches by game and level, training requests, sessions in the calendar and progress records (observation, recommendation, measurement) work. AI reviews, team training and school programmes are in development. Physical academies and addresses are not published until confirmed." },
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
    now: { ru: "Каталог тренеров с опытом, проверенным командой портала, и заявки на обучение работают; тренер ведёт профиль, программы, очередь заявок и занятия в кабинете.", en: "The directory of coaches whose experience the portal team verified, and training requests, work; a coach keeps the profile, programmes, request queue and sessions in the workspace." },
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
    now: { ru: "Организаторы назначают трансляции и записи событию и матчам; раздел «Медиа» показывает идущие события, расписание эфиров и записи; оверлей для OBS берёт имена и счёт из записи матча. Клипы, highlights, совместный разбор и профили авторов — в разработке. Авторы могут подать заявку.", en: "Organisers assign streams and recordings to the event and its matches; Media shows events under way, the broadcast schedule and recordings; an OBS overlay takes names and score from the match record. Clips, highlights, co-watch reviews and creator profiles are in development. Creators can apply." },
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
    now: { ru: "Работают каталог подтверждённых площадок, события с RSVP и листом ожидания, бронирование станций, QR-пропуска и синхронизация офлайн-отметок. Для посещения нужна действующая подтверждённая площадка. Работают поиск по названию, игре, типу, стране и городу и карта подтверждённых координат.", en: "Confirmed venue listings, events with RSVPs and waiting lists, station reservations, QR passes and offline scan reconciliation work. Visits require an operating verified venue. Name, game, type, country and city filters and a map of confirmed coordinates work." },
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
    now: { ru: "Доступны регистрация и проверка хоста, выделение свободного узла, WebRTC-видео, удалённое управление Arena и учёт связи. Для установленных игр подготовлен Linux-агент. Реальные машины, GPU, лицензии игр и публичный сетевой ретранслятор требуют подключения и приёмки.", en: "Host registration and review, allocation, WebRTC video, remote Arena input and connection metering are available. A Linux agent supports installed games. Actual machines, GPUs, game licences and a public relay require connection and acceptance testing." },
    boundary: { ru: "Без обещаний нулевого ping, гарантированного дохода хоста или запуска любой игры. Хост не получает пароли и токены игрока.", en: "No promises of zero ping, guaranteed host income or running any game. Hosts never receive player passwords or tokens." },
  },
  {
    slug: "server-rentals",
    kind: "server_rental",
    state: "connect",
    title: { ru: "Аренда серверов", en: "Server rentals" },
    lead: { ru: "Выделенные игровые серверы: игра, регион, ресурсы, расписание, резервные копии и логи.", en: "Dedicated game servers: game, region, resources, schedule, backups and logs." },
    scope: {
      ru: ["Запуск и остановка по расписанию", "Резервные копии и журналы", "Доступ по ролям команды"],
      en: ["Scheduled start and stop", "Backups and logs", "Role-based team access"],
    },
    now: { ru: "Доступны регистрация и проверка узлов, расписание запуска, резервирование ресурсов, команды, роли команды и локальные копии. Для доступных конфигураций нужен подключённый и проверенный сервер оператора. Платная аренда не включена.", en: "Node review, scheduling, resource reservation, controls, team roles and local backups are available. Configurations require a connected and reviewed operator server. Paid rentals are disabled." },
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

export type ModuleEntry = { id?: string; partner?: boolean; state: ModuleState; name: T; note: T };

export const MODULES: ModuleEntry[] = [
  { state: "works", name: { ru: "Аккаунты и сессии", en: "Accounts and sessions" }, note: { ru: "Регистрация 18+ с фиксацией принятых версий условий, вход, выход, смена пароля, управление сессиями, ограничение попыток входа.", en: "18+ sign-up recording the accepted terms versions, sign-in, sign-out, password change, session management, sign-in rate limiting." } },
  { state: "works", name: { ru: "Игровой паспорт и репутация", en: "Gaming passport and reputation" }, note: { ru: "Профиль с историей матчей и турниров, рангом и репутацией по итогам оспариваний.", en: "Profile with match and tournament history, rank and a reputation score from dispute outcomes." } },
  { state: "works", name: { ru: "Команды", en: "Teams" }, note: { ru: "Владелец, капитан, приглашения, передача полномочий, логотип и баннер; переходы игроков из других команд той же игры с согласием игрока и его команды, спор о переходе в течение 14 дней и публичная история состава.", en: "Owner, captain, invitations, role transfer, logo and banner; player transfers from other teams of the same game with the consent of the player and their team, a 14-day dispute window and a public roster history." } },
  { state: "works", name: { ru: "Поиск команды и игроков", en: "Team finder" }, note: { ru: "Объявления «ищу команду» и «ищу группу» по игре, региону, ролям и языкам; до трёх вакансий у команды, принятый отклик добавляет игрока в состав; объявление живёт 30 дней. Без ставок и платных преимуществ.", en: "Looking-for-team and looking-for-group posts by game, region, roles and languages; up to three vacancies per team, an accepted application adds the player to the roster; a post lives 30 days. No stakes, no paid advantage." } },
  { state: "works", name: { ru: "Скаутинг", en: "Scouting" }, note: { ru: "Поиск по открытым профилям: игра, страна, рейтинг быстрого матча, объявление «ищу команду», активность; сохранённые фильтры и личный список наблюдения. Игрок не узнаёт, кто за ним наблюдает; закрытый профиль исчезает из поиска и списков.", en: "Search over public profiles: game, country, quick match rating, a looking-for-team post, activity; saved filters and a private watchlist. A player is not told who watches them; a private profile leaves search and every list." } },
  { state: "works", name: { ru: "Кланы, клановые войны и сезонные рейтинги", en: "Clans, clan wars and seasonal ladders" }, note: { ru: "Клан объединяет игроков разных игр: владелец, офицеры, приглашения. Клановая война — серия Bo1/Bo3/Bo5 с составами 1–6 игроков: вызов, ответ, счёт одной стороны и подтверждение другой, спор решает команда портала. Сезонный рейтинг кланов по игре (Эло, сезон — квартал) и сезонная таблица игроков по рейтингу быстрого матча.", en: "A clan brings together players of different games: owner, officers, invitations. A clan war is a Bo1/Bo3/Bo5 series with lineups of 1–6 players: challenge, answer, one side's score confirmed by the other, disputes decided by the portal team. A seasonal clan ladder per game (Elo, a season is a quarter) and a seasonal players' table from quick match rating." } },
  { id: "partner-api", partner: true, state: "works", name: { ru: "API, вебхуки и виджеты для партнёров", en: "Partner API, webhooks and widgets" }, note: { ru: "Ключи API пространства организатора (хранится только отпечаток, 120 запросов в минуту), чтение турниров, участников, матчей и таблиц; вебхуки о статусе турнира, заявках и матчах с подписью HMAC, защитой от повтора и повторной доставкой; виджеты сетки, регистрации, таблицы и календаря для iframe; документация на странице «Разработчикам».", en: "API keys of an organising space (only a fingerprint is stored, 120 requests a minute), reading tournaments, participants, matches and standings; webhooks on tournament status, registrations and matches with HMAC signatures, replay protection and retries; bracket, registration, standings and calendar widgets for an iframe; documentation on the Developers page." } },
  { id: "venues", partner: true, state: "works", name: { ru: "Площадки и QR-пропуска", en: "Venues and QR passes" }, note: { ru: "Площадки пространства организатора публикуются после подтверждения адреса и статуса командой портала; смена адреса отправляет на повторную проверку. Турнир на площадке даёт участникам QR-пропуск (с 3 часов до начала и сутки после), площадка выдаёт гостевые пропуска до 7 дней; пропуск проходит один раз, повторный, просроченный, отозванный и пропуск по отозванной заявке не проходят; доступны онлайн-проверка и предварительные офлайн-отметки с последующей серверной сверкой; каждый проход записан.", en: "Venues of an organising space are published once the portal team confirms their address and status; a new address sends them back for review. A tournament at a venue gives participants a QR pass (from 3 hours before the start to a day after), a venue issues guest passes for up to 7 days; a pass admits once, and reused, expired, revoked passes and passes of withdrawn entries are refused; online verification and provisional offline scans with server reconciliation are available; every entry is logged." } },
  { id: "organisers", partner: true, state: "works", name: { ru: "Пространства организаторов и со-организаторы", en: "Organiser spaces and co-organisers" }, note: { ru: "Роли владельца, администратора и судьи; со-организаторы отдельного турнира; ограничение по странам.", en: "Owner, administrator and referee roles; per-tournament co-organisers; country restrictions." } },
  { id: "elimination", partner: true, state: "works", name: { ru: "Олимпийская система и double elimination", en: "Single and double elimination" }, note: { ru: "Проходы без игры для верхних посевов, нижняя сетка, гранд-финал и перезапуск финала; посев по ручным номерам, затем по XP, затем по порядку регистрации.", en: "Byes for top seeds, losers bracket, grand final and bracket reset; seeding by manual seeds, then XP, then registration order." } },
  { id: "rounds", partner: true, state: "works", name: { ru: "Круговая и швейцарская системы", en: "Round robin and Swiss" }, note: { ru: "Один или два круга; швейцарские пары по очкам без повторных встреч и bye по правилам; ничьи по выбору организатора. Tie-breakers Buchholz, Median Buchholz и Sonneborn-Berger (MV-STANDINGS-1, MV-SWISS-1), настройки фиксируются при старте.", en: "One or two legs; Swiss pairings by points without rematches and rule-based byes; draws at the organiser's choice. Buchholz, Median Buchholz and Sonneborn-Berger tie-breaks (MV-STANDINGS-1, MV-SWISS-1), settings frozen at the start." } },
  { id: "stages", partner: true, state: "works", name: { ru: "Многоэтапные турниры: группы, лиги и плей-офф", en: "Multi-stage events: groups, leagues and playoffs" }, note: { ru: "Группы змейкой по посеву → плей-офф (олимпийская, двойное выбывание или лесенка); круговая или швейцарская → плей-офф лучших N. Посев плей-офф по местам в группах без встреч одногруппников в первом раунде, даты туров по интервалу, фиксация основного этапа после старта плей-офф (MV-STAGES-1).", en: "Snake-seeded groups → a playoff (single or double elimination, or a gauntlet); round robin or Swiss → a playoff of the top N. Playoff seeding by group place keeping group-mates apart in round one, round dates by interval, the main stage locked once the playoff starts (MV-STAGES-1)." } },
  { id: "gauntlet", partner: true, state: "works", name: { ru: "Лесенка (gauntlet)", en: "Gauntlet (stepladder)" }, note: { ru: "До 16 участников: нижние посевы играют первыми, победитель поднимается к следующему посеву, первый посев играет только финал; места уникальны.", en: "Up to 16 entrants: the lowest seeds play first, each winner climbs to the next seed, the top seed plays only the final; places are unique." } },
  { state: "works", name: { ru: "Серии Bo1–Bo7 и очки по уровням", en: "Bo1–Bo7 series and points by level" }, note: { ru: "Формат серий и очки наследуются: турнир → плей-офф → нижняя сетка → группа → тур или стадия → матч; счёт серии проверяется по числу побед, судья может изменить отдельный матч до результата (MV-SERIES-1).", en: "Series length and points are inherited: tournament → playoff → lower bracket → group → round or stage → match; series scores are checked against the wins needed, and a referee may change one match before its result (MV-SERIES-1)." } },
  { id: "ffa", partner: true, state: "works", name: { ru: "FFA: лобби с очками за места", en: "FFA: lobbies with placement points" }, note: { ru: "Лобби змейкой по посеву, несколько игр в раунде, очки за место и убийства, выход лучших из каждого лобби до финального лобби; результаты вносит судья с версиями, споры по игре, следующий раунд ждёт решения споров (MV-FFA-1).", en: "Snake-seeded lobbies, several games per round, placement and kill points, the best of each lobby advance to a final lobby; referees enter versioned results, games can be disputed, the next round waits for decisions (MV-FFA-1)." } },
  { state: "works", name: { ru: "Регистрация с подтверждением, допуском, вопросами и составами", en: "Registration review, admission, questions and rosters" }, note: { ru: "Подтверждение или отказ с причиной, срок регистрации, критерии допуска (подтверждённый email, возраст аккаунта, опыт и матчи в игре — у каждого игрока состава), до пяти вопросов (ответы видят только организаторы и судьи), фиксация составов и замены через организатора с историей.", en: "Approval or rejection with a reason, a registration deadline, admission criteria (confirmed email, account age, XP and matches in the game — for every roster player), up to five questions (answers visible to organisers and referees only), roster lock and organiser substitutions with history." } },
  { id: "circuits", partner: true, state: "works", name: { ru: "Серии и сезоны", en: "Circuits and seasons" }, note: { ru: "Накопительные очки с весом турниров, квалификация в финалы, дивизионы с повышением и понижением, зафиксированная история сезонов в игровом паспорте (MV-CIRCUIT-1).", en: "Cumulative weighted points, qualification to finals, divisions with promotion and relegation, frozen season history in the gaming passport (MV-CIRCUIT-1)." } },
  { state: "works", name: { ru: "Шаблоны, оценки, копирование и безопасное пересоздание", en: "Templates, ratings, cloning and safe regeneration" }, note: { ru: "Шаблоны турниров с категориями, статистикой и оценками участников по реальным турнирам; оценка турнира участниками в течение 30 дней; копия турнира в черновик; пересоздание сетки, тура, групп, плей-офф или лобби только до первого результата; предпросмотр структуры до старта; история турнира из журнала.", en: "Tournament templates with categories, statistics and participants' ratings from real events; participants rate an event within 30 days; copies into drafts; regeneration of a bracket, round, groups, playoff or lobbies only before the first result; structure preview before the start; the tournament's history from the log." } },
  { state: "works", name: { ru: "Leaderboard-турниры", en: "Leaderboard tournaments" }, note: { ru: "Веса статистики, лучшие N результатов, окно отправки, tie-break по KDA и убийствам, проверка неправдоподобных строк (не античит).", en: "Stat weights, best-of-N, submission window, KDA and kills tie-breaks, review of implausible lines (not anti-cheat)." } },
  { id: "match-operations", partner: true, state: "works", name: { ru: "Игровой день, расписание, результаты и споры", en: "Game Day, schedule, results and disputes" }, note: { ru: "Экран игрового дня: все текущие турниры игрока, соперник, время, готовность, лобби, формат, доказательства и дальнейший путь, объяснение текущего состояния и одно доступное действие; вызов судьи к матчу с ответом (один открытый вызов на сторону, повтор без ответа эскалирует); очередь инцидентов события с приоритетом, ответственным и эскалацией владельцам пространства; пауза матча; обоснование решения судьи против отправленного счёта; исправление решённого матча после сыгранных следующих с предпросмотром последствий и переигровкой затронутых матчей; вето карт по пулу события и длине серии (MV-VETO-1). Отчёт, подтверждение, check-in к матчу, решение судьи, неявка после льготного времени, дисквалификация, исправление с версиями, оспаривание решённого матча; площадки, распределение тура по площадкам волнами, перенос тура и сдвиг расписания с уведомлениями, проверка пересечений площадок и участников, в том числе между турнирами (MV-SCHEDULE-1).", en: "Game Day screen: the player's current events, opponent, time, readiness, lobby, format, evidence and the way forward, with the current state explained and the one action available; calling the referee to a match with a reply (one open call per side; an unanswered repeat escalates); the event's incident queue with priority, assignee and escalation to the space's owners; match pause; a documented reason for decisions against a reported score; correcting a decided match after later matches were played, with the consequences previewed and the affected matches replayed; map veto by the event's pool and the series length (MV-VETO-1). Report, confirmation, match check-in, referee decision, no-show after a grace period, disqualification, versioned correction, disputes of decided matches; venues, placing a round on venues in waves, moving a round and shifting the schedule with notifications, overlap checks for venues and entrants, across tournaments too (MV-SCHEDULE-1)." } },
  { state: "works", name: { ru: "Итоги, рейтинги и награды", en: "Standings, rankings and awards" }, note: { ru: "Итоговые места из подтверждённых матчей; титулы в рейтинге — первые места завершённых турниров; награда победителю в монетах назначается оператором и выплачивается один раз каждому чемпиону.", en: "Final placements from confirmed matches; ranking titles are first places of completed events; a winner's award in coins is set by the operator and paid once per champion." } },
  { state: "works", name: { ru: "Прогрессия: XP, ранги, цели, сезонный пропуск", en: "Progression: XP, ranks, objectives, season pass" }, note: { ru: "Начисления только за подтверждённую активность, без двойных начислений.", en: "Credits only for confirmed activity, never twice." } },
  { state: "works", name: { ru: "Монеты и косметика", en: "Coins and cosmetics" }, note: { ru: "Монеты без денежной стоимости: не покупаются, не выводятся, не передаются и не ставятся на исход.", en: "Coins with no cash value: never bought, withdrawn, transferred or staked." } },
  { state: "works", name: { ru: "Вызовы 1v1 и быстрый матч с группами", en: "1v1 challenges and quick match with parties" }, note: { ru: "Без ставок; быстрый матч соединяет только с реальными игроками из очереди — один на один или группами до пяти одного размера (MV-MATCH-1). Матч создаётся после проверки готовности всех игроков за 90 секунд; отказ или молчание закрывают очередь на время, подтвердившие возвращаются на прежнее место. Рейтинг по играм с историей (MV-RATING-1) меняют только быстрые матчи.", en: "No stakes; quick match pairs only real players from the queue — one on one or parties of the same size up to five (MV-MATCH-1). The match exists after every player confirms a 90-second ready check; declining or not answering closes the queue for a while, players who confirmed keep their place. A rating per game with history (MV-RATING-1) changes only through quick matches." } },
  { state: "works", name: { ru: "Реферальная программа", en: "Referral programme" }, note: { ru: "Один код на аккаунт; награда пригласившему — после первого подтверждённого матча приглашённого.", en: "One code per account; the referrer is rewarded after the referee's first confirmed match." } },
  { state: "works", name: { ru: "Изображения: логотипы, баннеры, доказательства", en: "Images: logos, banners, evidence" }, note: { ru: "PNG, JPEG, WebP с проверкой сигнатуры и лимитами; доказательства видят только участники матча и судьи.", en: "PNG, JPEG, WebP with signature checks and limits; evidence is visible only to the match's participants and referees." } },
  { state: "works", name: { ru: "Честная игра: обращения, санкции, апелляции", en: "Fair play: reports, sanctions, appeals" }, note: { ru: "Обращение о нарушении → проверка → мера с правилом и его редакцией, доказательствами (хеш в журнале решений), уровнем уверенности и обоснованием; защитная блокировка до 72 часов только на время проверки; апелляция один раз за 14 дней, её решает другой сотрудник (MV-CONDUCT-1). Публичная страница доверия показывает правила и только обезличенные количества.", en: "Report → review → a measure with the rule and its version, evidence (digest in the decision log), a confidence level and reasoning; a protective hold of up to 72 hours only during a review; one appeal within 14 days, decided by another staff member (MV-CONDUCT-1). The public trust page shows the rules and anonymised counts only." } },
  { state: "works", name: { ru: "Центр управления и MFA", en: "Control centre and MFA" }, note: { ru: "Вход сотрудников со вторым фактором; девять ролей по обязанностям, каждая видит только свои разделы, и раздел проверяется на сервере; повторная проверка для чувствительных решений; журнал с hash-цепочкой; просмотр закрытого профиля сотрудником помечен и записан.", en: "Staff access with a second factor; nine roles by duty, each sees only its sections, checked on the server; step-up for sensitive decisions; hash-chained log; a staff view of a private profile is marked and logged." } },
  { id: "media", partner: true, state: "works", name: { ru: "Трансляции, записи и оверлеи", en: "Streams, recordings and overlays" }, note: { ru: "Организатор назначает эфир или запись событию или матчу, подтвердив права на показ; игроки матча получают уведомление. Twitch и YouTube играют на портале только после нажатия. Раздел «Медиа»: идущие события, расписание, записи; счётчиков зрителей нет. Оверлей для OBS и JSON — счёт из записи матча, официальный или заявленный.", en: "The organiser assigns a stream or recording to the event or a match after confirming the rights to show it; the match's players are notified. Twitch and YouTube play on the portal only after a click. Media: events under way, schedule, recordings; no viewer counts. OBS overlay and JSON: score from the match record, official or reported." } },
  { state: "works", name: { ru: "Сообщения команды портала", en: "Messages from the portal team" }, note: { ru: "Операционные и маркетинговые сообщения сегменту аккаунтов (аудитория, игра, страна, активность) с уведомлением и страницей в портале. Маркетинговые — только при согласии и не больше 2 за 7 дней; у каждого получателя статус доставки, открытия считаются. По email не отправляются.", en: "Operational and marketing messages to a segment of accounts (audience, game, country, activity) with a notification and a page in the portal. Marketing only with consent and at most 2 in 7 days; every recipient has a delivery status and openings are counted. Not sent by email." } },
  { state: "works", name: { ru: "Переключатели функций, обслуживание и состояние", en: "Feature switches, maintenance and status" }, note: { ru: "Роль инфраструктуры выключает новые действия по отдельным функциям без выпуска версии и включает режим обслуживания с баннером; изменения в журнале. Панель состояния: база, очереди, ошибки доставки, инциденты, регламентная задача, наличие настроек без значений.", en: "The infrastructure role switches off new starts by feature without a release and turns on maintenance with a banner; changes are logged. Status panel: database, queues, delivery errors, incidents, the scheduled job, presence of settings without values." } },
  { state: "works", name: { ru: "Заявки на членство и счета", en: "Membership applications and invoices" }, note: { ru: "Отдельные состояния заявки, счёта, оплаты и членства; условия фиксируются версией.", en: "Separate states for application, invoice, payment and membership; accepted terms are versioned." } },
  { state: "works", name: { ru: "Заявки партнёров и направлений", en: "Partner and direction applications" }, note: { ru: "Сохраняются в базе и попадают в рабочую очередь администрации.", en: "Stored in the database and routed to the administration work queue." } },
  { state: "works", name: { ru: "Уведомления на портале", en: "In-portal notifications" }, note: { ru: "Приглашения, матчи, результаты, споры, вызовы, награды, счета.", en: "Invitations, matches, results, disputes, challenges, awards, invoices." } },
  { state: "works", name: { ru: "Приватность данных", en: "Data privacy" }, note: { ru: "Публичность профиля, выгрузка своих данных, согласие на рассылки отдельно, удаление аккаунта с обезличиванием.", en: "Profile visibility, personal data export, separate marketing consent, account deletion with anonymisation." } },
  { state: "works", name: { ru: "Интерфейс RU / EN", en: "RU / EN interface" }, note: { ru: "Локализованные маршруты и переключение языка на той же странице.", en: "Localised routes and switching language on the same page." } },
  { state: "connect", name: { ru: "Подтверждение email и восстановление доступа", en: "Email confirmation and account recovery" }, note: { ru: "Код готов: одноразовые ссылки со сроком действия и очередь писем с повторами. Нужен почтовый сервис (Resend или SMTP).", en: "Code is ready: single-use expiring links and a retried email queue. Requires an email service (Resend or SMTP)." } },
  { state: "connect", name: { ru: "Онлайн-оплата членства", en: "Online membership payments" }, note: { ru: "Оплата картой подготовлена через Maximus Sports по внутреннему соглашению с MAXIMUS VEGAS L.L.C-FZ. Для включения нужны проверенное подключение и утверждённые условия предложения.", en: "Card payments are prepared through Maximus Sports under an internal agreement with MAXIMUS VEGAS L.L.C-FZ. Activation requires a verified connection and approved offer terms." } },
  { state: "connect", name: { ru: "Интеграции с издателями игр", en: "Game publisher integrations" }, note: { ru: "Требуются одобренный доступ и ключи (Riot RSO, Steam, PUBG API и др.). До подключения — ручная проверка с доказательствами.", en: "Requires approved access and keys (Riot RSO, Steam, PUBG API, etc.). Until then, manual verification with evidence." } },
  { state: "connect", name: { ru: "Вход через Google, Steam, Epic", en: "Sign-in with Google, Steam, Epic" }, note: { ru: "Нужны зарегистрированные приложения у провайдеров. Кнопки не показываются, пока вход не настоящий.", en: "Requires registered apps with each provider. The buttons are not shown until sign-in is real." } },
  { state: "connect", name: { ru: "Серверный контур CS2", en: "CS2 server contour" }, note: { ru: "Provisioning, RCON, demo и восстановление матчей — на отдельной инфраструктуре.", en: "Provisioning, RCON, demos and match recovery run on separate infrastructure." } },
  { id: "white-label", partner: true, state: "connect", name: { ru: "White-label домены", en: "White-label domains" }, note: { ru: "Собственный домен и оформление партнёра.", en: "Partner's own domain and branding." } },
  { id: "stage-chains", partner: true, state: "works", name: { ru: "Цепочки из трёх и более этапов", en: "Chains of three or more stages" }, note: { ru: "Например швейцарская → группы → плей-офф: до трёх этапов в турах между основным этапом и плей-офф, состав каждого — по итоговой таблице предыдущего, этап фиксируется после старта следующего, места — по этапу, на котором участник остановился (MV-STAGES-2).", en: "For example Swiss → groups → playoff: up to three stages in rounds between the main stage and the playoff, each filled from the final table of the stage before, a stage locked once the next starts, places by the stage an entrant reached (MV-STAGES-2)." } },
  { id: "academy", partner: true, state: "works", name: { ru: "Академия и тренеры", en: "Academy and coaches" }, note: { ru: "Тренер публикуется после проверки опыта командой портала; программы по играм и уровням; заявка на обучение попадает в очередь тренера; занятия без пересечений и в календаре; записи прогресса разделяют наблюдение, рекомендацию и замер. Оплату занятий портал не принимает; ИИ-разбор и школьные программы — в разработке.", en: "A coach is published after the portal team verifies the experience; programmes by game and level; a training request reaches the coach's queue; sessions without overlaps and in the calendar; progress records keep observation, recommendation and measurement apart. The portal takes no payment for sessions; AI reviews and school programmes are in development." } },
  { state: "dev", name: { ru: "Клипы, highlights, совместный разбор и профили авторов", en: "Clips, highlights, co-watch reviews and creator profiles" }, note: { ru: "Дополнительные медиафункции; трансляции, записи и оверлеи учтены отдельно как работающие.", en: "Additional media features; streams, recordings and overlays are listed separately as working." } },
  { state: "dev", name: { ru: "Групповые сообщества, обсуждения и голос", en: "Group communities, discussions and voice" }, note: { ru: "С модерацией и ограничениями для несовершеннолетних.", en: "With moderation and limits for minors." } },
  { state: "works", name: { ru: "Карта площадок", en: "Venue map" }, note: { ru: "Карта и список используют общий поиск по названию, игре, типу, стране и городу. Координаты входа и игры указывает организатор; изменения требуют проверки. Карта загружается по кнопке, местоположение посетителя не запрашивается. Площадки без координат остаются в списке.", en: "The map and list share name, game, type, country and city filters. Organizers supply entrance coordinates and games; changes require review. The map loads on request without asking for the visitor’s location. Venues without coordinates remain in the list." } },
  { state: "works", name: { ru: "Clubhouse: события, станции и вход", en: "Clubhouse: events, stations and entry" }, note: { ru: "Часы работы, бронирование без пересечений, бесплатные события, RSVP и лист ожидания. Офлайн-отметки предварительные: сервер проверяет отзыв и повторное использование после синхронизации. Нужна подтверждённая площадка; карта показывает проверенные координаты.", en: "Opening hours, conflict-checked bookings, free events, RSVPs and waiting lists. Offline scans are provisional: the server checks revocation and reuse on sync. A verified venue is required; the map shows reviewed coordinates." } },
  { state: "dev", name: { ru: "Магазин и маркетплейс", en: "Shop and marketplace" }, note: { ru: "Только реальные заказы и подтверждённые товары.", en: "Real orders and confirmed goods only." } },
  { id: "sponsor-workspace", partner: true, state: "dev", name: { ru: "Кабинет спонсора и тестовая среда партнёра", en: "Sponsor workspace and partner sandbox" }, note: { ru: "Кампании и атрибуция спонсора, выделенная тестовая среда. API, подписанные webhooks и виджеты учтены отдельно.", en: "Sponsor campaigns and attribution, a dedicated sandbox. API, signed webhooks and widgets are listed separately." } },
  { state: "dev", name: { ru: "ИИ-помощники игрока, организатора, тренера", en: "AI assistants for players, organisers, coaches" }, note: { ru: "Действуют в пределах серверных прав; критичные действия подтверждает человек.", en: "Act within server-side permissions; critical actions are confirmed by a human." } },
  { state: "dev", name: { ru: "Опекуны, школы и благополучие", en: "Guardians, schools and wellbeing" }, note: { ru: "Согласия с версиями, лимиты времени и расходов, ограничения контактов.", en: "Versioned consents, time and spending limits, contact restrictions." } },
  { id: "cloud-gaming", state: "connect", name: { ru: "P2P Cloud Gaming", en: "P2P Cloud Gaming" }, note: { ru: "Реестр проверяемых хостов, выделение сеансов, WebRTC, управление Arena, учёт связи, отзыв ключей и Linux-агент подготовлены. Нужны действующие машины, сетевой ретранслятор и проверка совместимости GPU и каждой игры. Управление выделенными серверами учтено отдельно.", en: "Reviewed hosts, session allocation, WebRTC, Arena input, connection metering, key revocation and a Linux agent are implemented. Operating machines, a relay and GPU/game compatibility acceptance are required. Dedicated server management is listed separately." } },
  { id: "server-rentals", state: "connect", name: { ru: "Выделенные игровые серверы", en: "Dedicated game servers" }, note: { ru: "Проверка узлов и шаблонов, резервирование ресурсов и портов, расписание, управление, командные роли, приватные журналы и резервные копии реализованы. Для работы нужны проверенный Linux-узел, разрешённый игровой образ и проверка сети. Платная аренда не включена.", en: "Node and template review, resource and port reservations, schedules, controls, team roles, private logs and backups are implemented. Operation requires a verified Linux node, an authorised game image and network acceptance. Paid rental is disabled." } },
  { state: "works", name: { ru: "Gamer dating 18+", en: "Gamer dating 18+" }, note: { ru: "Отдельное согласие, предпочтения, поиск и взаимные совпадения, приватная переписка, блокировки и модерация. Подбор по подтверждённым игровым результатам включается отдельно обоими участниками. Поиск поблизости работает по отдельному согласию с округлённым местоположением на семь дней и радиусом 25–250 км. Голос и видео подготовлены; для публичных звонков нужен настроенный сетевой ретранслятор.", en: "Separate consent, preferences, discovery and mutual matches, private messages, blocks and moderation. Ranking by confirmed gaming results requires both members to opt in. Optional nearby discovery uses a rounded location for seven days and a 25–250 km radius. Voice and video are implemented; public calls require a configured relay." } },
  { state: "works", name: { ru: "Pass: задания и подарки", en: "Pass: missions and gifts" }, note: { ru: "Ежедневные, недельные и сезонные задания, выбор игры, история и защита от повторной награды. Подарки предоставляются только из заявленного остатка подтверждённых площадок с резервом и кодом выдачи.", en: "Daily, weekly and seasonal missions, game preferences, history and replay-safe rewards. Gifts require declared inventory at verified venues, reservations and collection codes." } },
  { state: "connect", name: { ru: "Проверяемая статистика и Web3", en: "Verifiable statistics and Web3" }, note: { ru: "Подписанный приём данных после согласия игрока и проверки источника, подтверждение записей, приватный экспорт и проверка целостности работают. Фиксация в блокчейне требует развёрнутого контракта и RPC; платные монеты, вывод средств и платные игровые входы выключены.", en: "Signed intake with player consent and source review, record confirmation, private exports and integrity checks work. On-chain anchoring requires a deployed contract and RPC; bought coins, withdrawals and paid game entries are disabled." } },
  { state: "research", name: { ru: "Проверка статистики через API издателей", en: "Stat verification through publisher APIs" }, note: { ru: "PUBG: телеметрия матча с фильтрацией убийств ботов; CS2: разбор demo по коду матча. Отдельная работа для каждой игры, ключи хранятся только на сервере.", en: "PUBG: match telemetry with bot kills filtered out; CS2: demo parsing from match share codes. Separate work per game; keys live on the server only." } },
  { state: "research", name: { ru: "Собственный античит и ML-сигналы", en: "Own anti-cheat and ML signals" }, note: { ru: "Античит в реальном времени требует компонента на стороне игры и не создаётся сайтом. Сигналы модели — повод для проверки, не доказательство.", en: "Real-time anti-cheat needs a game-side component and cannot be built by a website. Model signals trigger review, they are not proof." } },
  { state: "research", name: { ru: "Анализ CCTV для безопасности площадок", en: "CCTV analytics for venue security" }, note: { ru: "Только при отдельном обосновании и допустимости.", en: "Only with separate justification and permissibility." } },
  { state: "research", name: { ru: "Анализ реакции зрачка", en: "Pupil-reaction analysis" }, note: { ru: "Не применяется к игрокам: никаких выводов о здоровье, личности или честности.", en: "Not applied to players: no conclusions about health, personality or honesty." } },
  { state: "research", name: { ru: "Идентичность ACEXIS", en: "ACEXIS identity" }, note: { ru: "Направление цифровых решений из учёта IP; не является игровым продуктом.", en: "A digital-solutions direction from the IP register; not a gaming product." } },
  { state: "research", name: { ru: "ИИ-аналитика продаж, персонализированные новости и лояльность", en: "AI sales analytics, personalised news and loyalty" }, note: { ru: "Для партнёрских программ и разрешённых рекомендаций.", en: "For partner programmes and permitted recommendations." } },
];

/** Public summaries reuse the same component states as the status registry. */
const directionModule: Record<string, string> = { academy: "academy", coaches: "academy", media: "media", venues: "venues", "cloud-gaming": "cloud-gaming", "server-rentals": "server-rentals" };
export const DIRECTIONS: Direction[] = DIRECTION_DEFINITIONS.map((direction) => {
  const id = directionModule[direction.slug];
  const module = id ? MODULES.find((entry) => entry.id === id) : undefined;
  return module ? { ...direction, state: module.state } : direction;
});
export const partnerModules = (working: boolean) => MODULES.filter((entry) => entry.partner && (entry.state === "works") === working);

export const IP_DIRECTIONS: T[] = [
  { ru: "Аналитика продаж товаров и услуг на базе ИИ", en: "AI-based analytics of sales of goods and services" },
  { ru: "Персонализированные новости, лояльность и бонусные программы", en: "Personalised news, loyalty and bonus programmes" },
  { ru: "Анализ CCTV-видеопотоков для безопасности", en: "CCTV video stream analysis for security" },
  { ru: "Анализ реакции зрачка для идентификации и функционального состояния", en: "Pupil-reaction analysis for identification and functional state" },
  { ru: "Цифровые решения и идентичность ACEXIS", en: "Digital solutions and the ACEXIS identity" },
];

export const t = (value: T, lang: Locale) => value[lang];
