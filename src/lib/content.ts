export type Locale = "ru" | "en";
export const isLocale = (value: string): value is Locale =>
  value === "ru" || value === "en";

export const content = {
  ru: {
    title: "MAXIMUS VEGAS — Инфраструктура игрового бизнеса",
    description:
      "Tournament Suite от MAXIMUS VEGAS: единая платформа для турниров, игровых сообществ и проектов под собственным брендом. Для операторов, партнёров и инвесторов.",
    skip: "К содержимому",
    nav: ["Экосистема", "Для партнёров", "Бизнес-модель", "О компании"],
    cta: "Обсудить проект",
    menu: "Открыть меню",
    close: "Закрыть меню",
    eyebrow: "GAMING INFRASTRUCTURE / DUBAI, UAE",
    headline: ["Большая игра.", "Ваша платформа."],
    intro:
      "Инфраструктура, которая объединяет турниры, игроков и бизнес. Запускайте игровые проекты под своим брендом — на технологиях MAXIMUS VEGAS.",
    primary: "Стать партнёром",
    secondary: "Изучить экосистему",
    heroNote: "Для операторов, издателей и инвесторов",
    diagramTop: "АРХИТЕКТУРА ЭКОСИСТЕМЫ",
    diagramBrand: "Ваш бренд. Ваша аудитория.",
    diagramSub: "Одна технологическая платформа",
    diagramItems: [
      ["Organizer", "Управление турнирами"],
      ["Arena", "Опыт игроков"],
      ["Admin", "Контроль платформы"],
    ],
    diagramFoundation: "Турниры / Сообщество / Интеграции",
    metrics: [
      ["03", "Связанных продукта"],
      ["White-label", "Ваш бренд и домен"],
      ["B2B SaaS", "Модель развития"],
      ["Web + Mobile", "Единая экосистема"],
    ],
    ecoLabel: "01 / ЭКОСИСТЕМА",
    ecoTitle: "Всё связано.\nВсё работает на вас.",
    ecoDesc:
      "Tournament Suite объединяет операционную работу, игровой опыт и контроль платформы в одной системе.",
    products: [
      {
        name: "Organizer",
        tag: "ДЛЯ ОПЕРАТОРОВ",
        title: "Управляйте всей игрой.",
        description:
          "Рабочее пространство для запуска и проведения соревнований: от регистрации участников до финальных результатов.",
        features: [
          "Турниры, сетки и расписания",
          "Участники, команды и live operations",
          "Финансы, аналитика и интеграции",
        ],
      },
      {
        name: "Arena",
        tag: "ДЛЯ ИГРОКОВ",
        title: "Аудитория становится сообществом.",
        description:
          "Игровая платформа под вашим брендом, где участники находят турниры, собирают команды и развивают свой профиль.",
        features: [
          "Профили игроков и команды",
          "Матчи, рейтинги и соревнования",
          "Социальные механики и вовлечение",
        ],
      },
      {
        name: "Admin",
        tag: "ДЛЯ КОМАНДЫ ПЛАТФОРМЫ",
        title: "Контроль в масштабе.",
        description:
          "Центр управления операциями: роли и доступы, модерация, поддержка и обзор состояния платформы.",
        features: [
          "Пользователи, проекты и права доступа",
          "Модерация и история действий",
          "Операционный мониторинг",
        ],
      },
    ],
    foundation: "Общий технологический фундамент",
    foundations: [
      "Игровые интеграции",
      "Облачный гейминг",
      "Защита игрового опыта",
      "Мобильные продукты",
    ],
    partnerLabel: "02 / ПАРТНЁРСТВО",
    partnerTitle: "Ваш рынок.\nНаши технологии.",
    partnerDesc:
      "От локального сообщества до собственной игровой экосистемы. Вы развиваете аудиторию — платформа поддерживает её рост.",
    partners: [
      [
        "Издатели игр",
        "Создавайте соревновательные программы вокруг своих игр и поддерживайте вовлечённость аудитории.",
      ],
      [
        "Киберспортивные операторы",
        "Управляйте лигами, сериями турниров и партнёрскими проектами из одного пространства.",
      ],
      [
        "Игровые клубы и сообщества",
        "Объединяйте площадки, игроков и мероприятия под собственным брендом.",
      ],
      [
        "Стратегические инвесторы",
        "Изучите продуктовую экосистему, бизнес-модель и возможности участия в развитии компании.",
      ],
    ],
    modelLabel: "03 / БИЗНЕС-МОДЕЛЬ",
    modelTitle: "Технологии в основе.\nРост в каждой модели.",
    modelIntro:
      "Модель платформы сочетает подписку на программное обеспечение и монетизацию использования сервисов.",
    modelCards: [
      [
        "01",
        "Подписка",
        "Доступ операторов к возможностям платформы по модели SaaS.",
      ],
      [
        "02",
        "Транзакции",
        "Комиссионная модель для поддерживаемых платёжных и торговых сценариев.",
      ],
      [
        "03",
        "Сервисы",
        "Использование облачного гейминга, серверов и дополнительных продуктов.",
      ],
    ],
    investorTitle: "Давайте обсудим следующий этап.",
    investorDesc:
      "На встрече покажем продукт, разберём возможности партнёрства и обсудим материалы для инвестиционной оценки.",
    investorCta: "Связаться с командой",
    investorNote:
      "Коммерческие показатели и условия предоставляются индивидуально.",
    aboutLabel: "04 / КОМПАНИЯ",
    aboutTitle: "Из Дубая.\nДля игровой индустрии.",
    aboutDesc:
      "MAXIMUS VEGAS LLC FZ создаёт Tournament Suite — технологическую основу для соревновательного гейминга. Наш фокус — связать продукты, сообщества и бизнес в единую работающую экосистему.",
    founders: "Основатели",
    location: "Дубай, Объединённые Арабские Эмираты",
    faqLabel: "ВОПРОСЫ И ОТВЕТЫ",
    faqs: [
      [
        "Что такое MAXIMUS VEGAS?",
        "MAXIMUS VEGAS LLC FZ — компания из Дубая, которая разрабатывает Tournament Suite. Платформа объединяет продукты для организаторов, игроков и команды управления.",
      ],
      [
        "Можно ли запустить платформу под своим брендом?",
        "Да. White-label модель предусматривает собственный бренд и домен оператора. Состав функций, интеграции и условия запуска обсуждаются с командой.",
      ],
      [
        "Это сайт для регистрации на турниры?",
        "Этот сайт предназначен для партнёров и инвесторов. Здесь можно познакомиться с экосистемой и запросить встречу. Игровые сервисы работают в отдельных продуктах.",
      ],
      [
        "Как получить демонстрацию или материалы для инвестора?",
        "Оставьте контакт и укажите ваш интерес в форме ниже. Команда свяжется с вами для обсуждения и согласует формат демонстрации или предоставления материалов.",
      ],
    ],
    contactLabel: "05 / СЛЕДУЮЩИЙ ШАГ",
    contactTitle: "Начнём\nбольшую игру.",
    contactDesc:
      "Расскажите о вашем проекте. Найдём формат сотрудничества, который подходит вашему бизнесу.",
    contactDetail: "Партнёрство · Инвестиции · Демонстрация",
    form: {
      name: "Ваше имя",
      email: "Рабочий email",
      company: "Компания",
      optional: "необязательно",
      interest: "Что вас интересует?",
      interests: ["Партнёрство", "Инвестиции", "Демонстрация платформы"],
      message: "Пару слов о проекте",
      messagePlaceholder: "Ваша аудитория, задачи и планы…",
      consent: "Я согласен с обработкой данных согласно",
      privacy: "политике конфиденциальности",
      submit: "Отправить запрос",
      sending: "Отправляем…",
      success:
        "Спасибо! Ваш запрос отправлен. Команда свяжется с вами по указанному email.",
      error: "Не удалось отправить запрос. Попробуйте позже.",
      unavailable: "Приём запросов через форму пока недоступен.",
      retry: "Отправить ещё один запрос",
      fallback: "Вы также можете написать нам на",
      required: "Обязательное поле",
    },
    footer: "Технологии для следующего уровня игры.",
    rights: "Все права защищены.",
    back: "Наверх",
    privacyTitle: "Обработка контактных данных",
    privacyBack: "Вернуться на сайт",
    privacySections: [
      [
        "Кто обрабатывает данные",
        "Получатель обращений — MAXIMUS VEGAS LLC FZ, Дубай, ОАЭ. Эта страница описывает обработку данных, отправленных через форму на данном сайте.",
      ],
      [
        "Какие данные запрашиваются",
        "Имя, email, интересующее направление и, по желанию, компания и сообщение. Эти сведения используются для ответа на запрос о партнёрстве, инвестициях или демонстрации.",
      ],
      [
        "Как обрабатывается запрос",
        "После вашего согласия обращение передаётся команде через настроенный сервис приёма заявок. Данные не публикуются на сайте и не используются для автоматической рекламной подписки. Если сервис недоступен, сайт сообщает об ошибке, а не подтверждает отправку.",
      ],
      [
        "Технические данные",
        "Хостинг может обрабатывать технические журналы запросов для работы и защиты сайта. На сайте не установлены рекламные трекеры. Форма использует техническое поле для защиты от автоматических отправок.",
      ],
      [
        "Управление данными",
        "Для уточнения, изменения или удаления сведений воспользуйтесь опубликованным на сайте рабочим email либо ответьте на письмо команды по вашему обращению. Не отправляйте через форму пароли, платёжные реквизиты или конфиденциальные документы.",
      ],
    ],
  },
  en: {
    title: "MAXIMUS VEGAS — Gaming Business Infrastructure",
    description:
      "Tournament Suite by MAXIMUS VEGAS: one platform for tournaments, gaming communities and branded experiences. Built for operators, partners and investors.",
    skip: "Skip to content",
    nav: ["Ecosystem", "For partners", "Business model", "About us"],
    cta: "Let’s talk",
    menu: "Open menu",
    close: "Close menu",
    eyebrow: "GAMING INFRASTRUCTURE / DUBAI, UAE",
    headline: ["A bigger game.", "Your platform."],
    intro:
      "The infrastructure connecting tournaments, players and business. Build your own branded gaming destination — powered by MAXIMUS VEGAS.",
    primary: "Become a partner",
    secondary: "Explore the ecosystem",
    heroNote: "For operators, publishers and investors",
    diagramTop: "THE ECOSYSTEM ARCHITECTURE",
    diagramBrand: "Your brand. Your audience.",
    diagramSub: "One technology platform",
    diagramItems: [
      ["Organizer", "Tournament operations"],
      ["Arena", "Player experience"],
      ["Admin", "Platform control"],
    ],
    diagramFoundation: "Tournaments / Community / Integrations",
    metrics: [
      ["03", "Connected products"],
      ["White-label", "Your brand and domain"],
      ["B2B SaaS", "A model built to grow"],
      ["Web + Mobile", "One ecosystem"],
    ],
    ecoLabel: "01 / THE ECOSYSTEM",
    ecoTitle: "Connected by design.\nBuilt around you.",
    ecoDesc:
      "Tournament Suite brings operations, the player experience and platform oversight together in one system.",
    products: [
      {
        name: "Organizer",
        tag: "FOR OPERATORS",
        title: "Run the whole game.",
        description:
          "One workspace to launch and manage competitions, from participant registration to final results.",
        features: [
          "Tournaments, brackets and scheduling",
          "Participants, teams and live operations",
          "Finance, analytics and integrations",
        ],
      },
      {
        name: "Arena",
        tag: "FOR PLAYERS",
        title: "Turn an audience into a community.",
        description:
          "Your branded gaming destination, where players discover tournaments, form teams and build their gaming identity.",
        features: [
          "Player profiles and teams",
          "Matches, rankings and competitions",
          "Social features and engagement",
        ],
      },
      {
        name: "Admin",
        tag: "FOR PLATFORM TEAMS",
        title: "Stay in control. At scale.",
        description:
          "A central workspace for roles and access, moderation, support and platform operations.",
        features: [
          "Users, projects and permissions",
          "Moderation and audit trails",
          "Operational monitoring",
        ],
      },
    ],
    foundation: "One shared technology foundation",
    foundations: [
      "Game integrations",
      "Cloud gaming",
      "Player protection",
      "Mobile products",
    ],
    partnerLabel: "02 / PARTNERSHIPS",
    partnerTitle: "Your market.\nOur technology.",
    partnerDesc:
      "From a local community to your own gaming ecosystem. You build the audience. The platform supports its growth.",
    partners: [
      [
        "Game publishers",
        "Build competitive programs around your games and give your audience more reasons to return.",
      ],
      [
        "Esports operators",
        "Run leagues, tournament circuits and partner programs from a connected workspace.",
      ],
      [
        "Gaming venues & communities",
        "Bring venues, players and events together under your own brand.",
      ],
      [
        "Strategic investors",
        "Explore the product ecosystem, business model and opportunities to support the next phase of growth.",
      ],
    ],
    modelLabel: "03 / BUSINESS MODEL",
    modelTitle: "Technology at the core.\nGrowth across the model.",
    modelIntro:
      "The platform combines software subscriptions with usage-based service monetization.",
    modelCards: [
      [
        "01",
        "Subscriptions",
        "SaaS access to platform capabilities for gaming operators.",
      ],
      [
        "02",
        "Transactions",
        "A commission model for supported payment and marketplace workflows.",
      ],
      [
        "03",
        "Services",
        "Usage of cloud gaming, game servers and additional products.",
      ],
    ],
    investorTitle: "Let’s talk about what comes next.",
    investorDesc:
      "Meet the team, explore the product and discuss partnership opportunities and investment evaluation materials.",
    investorCta: "Connect with our team",
    investorNote: "Commercial metrics and terms are shared individually.",
    aboutLabel: "04 / THE COMPANY",
    aboutTitle: "Based in Dubai.\nBuilt for gaming.",
    aboutDesc:
      "MAXIMUS VEGAS LLC FZ builds Tournament Suite, a technology foundation for competitive gaming. We connect products, communities and business in one working ecosystem.",
    founders: "Founders",
    location: "Dubai, United Arab Emirates",
    faqLabel: "A FEW THINGS TO KNOW",
    faqs: [
      [
        "What is MAXIMUS VEGAS?",
        "MAXIMUS VEGAS LLC FZ is a Dubai-based company developing Tournament Suite. The platform connects products for organizers, players and platform management teams.",
      ],
      [
        "Can I launch under my own brand?",
        "Yes. The white-label model supports an operator’s own brand and domain. Features, integrations and launch terms are discussed with the team.",
      ],
      [
        "Can I register for a tournament here?",
        "This website is for partners and investors. You can explore the ecosystem and request a meeting. Player services run in separate products.",
      ],
      [
        "How do I request a demo or investor materials?",
        "Leave your contact details and select your interest below. The team will get in touch to discuss your request and arrange a demonstration or relevant materials.",
      ],
    ],
    contactLabel: "05 / YOUR NEXT MOVE",
    contactTitle: "Let’s build\na bigger game.",
    contactDesc:
      "Tell us what you have in mind. Together, we can find the right partnership for your business.",
    contactDetail: "Partnerships · Investment · Product demos",
    form: {
      name: "Your name",
      email: "Work email",
      company: "Company",
      optional: "optional",
      interest: "What are you interested in?",
      interests: ["Partnership", "Investment", "Platform demo"],
      message: "Tell us about your project",
      messagePlaceholder: "Your audience, challenges and plans…",
      consent: "I agree to the processing of my data under the",
      privacy: "privacy notice",
      submit: "Send inquiry",
      sending: "Sending…",
      success:
        "Thank you! Your inquiry has been sent. Our team will contact you at the email provided.",
      error: "We couldn’t send your inquiry. Please try again later.",
      unavailable: "Inquiries through this form are not available yet.",
      retry: "Send another inquiry",
      fallback: "You can also email us at",
      required: "Required field",
    },
    footer: "Technology for the next level of gaming.",
    rights: "All rights reserved.",
    back: "Back to top",
    privacyTitle: "Contact data privacy notice",
    privacyBack: "Back to the website",
    privacySections: [
      [
        "Who receives your data",
        "Inquiries are addressed to MAXIMUS VEGAS LLC FZ, Dubai, UAE. This notice describes how contact information submitted through this website is handled.",
      ],
      [
        "What we request",
        "Your name, email, area of interest and, optionally, company and message. This information is used to respond to your request about a partnership, investment or product demonstration.",
      ],
      [
        "How inquiries are processed",
        "With your consent, inquiries are forwarded to the team through the configured intake service. They are not published on this website and do not subscribe you to automated marketing. When delivery is unavailable, the website displays an error instead of confirming delivery.",
      ],
      [
        "Technical information",
        "The hosting provider may process technical request logs to operate and protect the website. No advertising trackers are installed. The form uses a technical field to help prevent automated submissions.",
      ],
      [
        "Managing your information",
        "To clarify, correct or delete your details, use the business email published on the website or reply to the team’s response to your inquiry. Do not submit passwords, payment details or confidential documents through this form.",
      ],
    ],
  },
};

export type Copy = typeof content.ru;
