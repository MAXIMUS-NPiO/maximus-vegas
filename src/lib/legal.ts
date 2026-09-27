import type { Locale } from "./i18n.ts";

type Doc = { title: string; sections: Array<[string, string[]]> };

/**
 * Versions of the published documents. A new version is a new id; acceptances are recorded against the
 * id (table `consents`). The previous version (2026-09-27) is preserved in the repository history.
 */
export const LEGAL_VERSIONS = { terms: "2026-09-27.2", privacy: "2026-09-27.2" } as const;
export const LEGAL_DATES: Record<Locale, string> = { ru: "Редакция 2 от 27 сентября 2026", en: "Version 2 of 27 September 2026" };

const terms: Record<Locale, Doc> = {
  ru: {
    title: "Условия использования",
    sections: [
      ["1. Оператор", ["Портал MAXIMUS VEGAS (maximus.vegas) предоставляет MAXIMUS VEGAS L.L.C-FZ, коммерческая компания Meydan Free Zone, Dubai, UAE. Контакт: info@maximus.ltd."]],
      ["2. Аккаунт", ["Регистрация доступна с 18 лет. Аккаунты для несовершеннолетних с согласием опекуна будут доступны после запуска соответствующего модуля.", "Вы отвечаете за достоверность данных профиля и сохранность пароля. Один человек — один аккаунт; передача аккаунта другому лицу запрещена. Подтверждение email подтверждает только доступ к почтовому ящику, но не личность."]],
      ["3. Бесплатное участие и отсутствие азартных механик", ["Регистрация, команды, участие в турнирах, вызовы 1v1 и быстрые матчи бесплатны.", "На портале нет и не допускаются ставки, пари, ставки монетами, лотереи, игры на деньги, платные прогнозы, платные случайные награды и призовые фонды из взносов участников."]],
      ["4. Турниры и результаты", ["Форматы: олимпийская система, double elimination с перезапуском финала и leaderboard. Организатор события определяет правила турнира в пределах этих условий.", "Результат подтверждается соперником или решением судьи. Исправление создаёт новую версию и не переписывает молча уже сыгранные зависимые матчи.", "В leaderboard статистику вносят участники, пока не подключена интеграция с издателем. Логически невозможные и неправдоподобные строки не учитываются до решения организатора. Это проверка целостности данных, а не античит.", "Отправляя доказательство, вы подтверждаете, что имеете право им делиться."]],
      ["5. Споры и честная игра", ["Участник может оспорить решённый матч с описанием и доказательством. Организатор оставляет результат в силе или отменяет его.", "Оспаривание, которое после рассмотрения оставлено без удовлетворения, снижает вашу репутацию; обоснованное оспаривание её не снижает.", "Запрещены читы, эксплойты, договорные матчи, игра за чужой аккаунт, подставные аккаунты и давление на соперников или судей. Санкции применяются с указанием причины и фиксируются в журнале решений. Решение можно обжаловать через поддержку."]],
      ["6. XP, монеты, ранги и сезонный пропуск", ["XP и монеты — неденежные показатели активности. Они начисляются только за подтверждённую активность, описанную на портале: цели, уровни пропуска, реферальные бонусы и турнирные награды, назначенные оператором.", "Монеты можно потратить только на косметические предметы и премиальную линию пропуска. Их нельзя купить, продать, передать, обменять на деньги или товары, поставить на исход и вывести; вне портала они не имеют ценности.", "Ошибочно начисленные XP и монеты могут быть исправлены. XP и монеты прекращаются вместе с аккаунтом."]],
      ["7. Вызовы 1v1 и быстрый матч", ["Вызовы и быстрые матчи проводятся без ставок. Быстрый матч соединяет вас только с реальным игроком, ожидающим в очереди той же игры.", "Результат подтверждает соперник; спорный результат решает команда портала."]],
      ["8. Платное членство", ["MAXIMUS VEGAS L.L.C-FZ может предлагать необязательное платное членство. Оно даёт только косметические возможности и премиальную линию пропуска и никогда не влияет на посев, результаты, рейтинги и доступ к турнирам.", "Цена, валюта, срок, налоговый режим, что включено и что исключено, условия отмены и возврата показываются в предложении до оплаты и становятся частью соглашения, которое вы принимаете при оплате. Принятая версия сохраняется.", "Членство активируется только после одобрения заявки и подтверждения оплаты платёжным провайдером. Данные карты вводятся на странице провайдера и не попадают на портал. Автоматическое продление не применяется."]],
      ["9. Пользовательский контент", ["Вы сохраняете права на свой контент и предоставляете оператору право отображать его на портале в объёме, необходимом для работы сервиса. Запрещены незаконные материалы, оскорбления, дискриминация и нарушение чужих прав."]],
      ["10. Игры и издатели", ["Названия игр принадлежат их правообладателям. Портал не аффилирован с издателями, если это прямо не указано. Интеграции с издателями подключаются только с их разрешения; до этого результаты проверяются вручную."]],
      ["11. Доступность сервиса", ["Функции, отмеченные как «в разработке», «требует подключения» или «исследование», не являются действующими услугами. Мы стремимся к бесперебойной работе, но не гарантируем её и можем изменять функции портала."]],
      ["12. Ответственность", ["Портал предоставляется «как есть». Оператор не отвечает за действия третьих лиц, игровых серверов и издателей. Ничто в этих условиях не ограничивает ответственность, которую нельзя ограничить по применимому праву."]],
      ["13. Прекращение и изменения", ["Вы можете удалить аккаунт в настройках. Мы можем приостановить аккаунт при нарушении условий. О существенных изменениях мы сообщаем на портале и просим принять новую редакцию; принятая версия фиксируется."]],
    ],
  },
  en: {
    title: "Terms of use",
    sections: [
      ["1. Operator", ["The MAXIMUS VEGAS portal (maximus.vegas) is provided by MAXIMUS VEGAS L.L.C-FZ, a commercial company in Meydan Free Zone, Dubai, UAE. Contact: info@maximus.ltd."]],
      ["2. Account", ["Sign-up is available from 18. Accounts for minors with guardian consent will be available once the corresponding module launches.", "You are responsible for accurate profile data and keeping your password safe. One person, one account; transferring an account to someone else is prohibited. Email confirmation only confirms access to a mailbox, not identity."]],
      ["3. Free entry and no gambling mechanics", ["Sign-up, teams, tournament entry, 1v1 challenges and quick matches are free.", "The portal has no and does not allow betting, wagering, coin stakes, lotteries, real-money games, paid predictions, paid random rewards or prize pools funded by participant fees."]],
      ["4. Tournaments and results", ["Formats: single elimination, double elimination with a bracket reset, and leaderboard. An event's organiser sets its rules within these terms.", "A result is confirmed by the opponent or a referee decision. A correction creates a new version and never silently rewrites dependent matches that were played.", "Leaderboard stats are entered by participants until a publisher integration is connected. Logically impossible and implausible lines do not count until the organiser decides. This is a data integrity check, not anti-cheat.", "By submitting evidence you confirm you have the right to share it."]],
      ["5. Disputes and fair play", ["A participant can dispute a decided match with a description and evidence. The organiser upholds or overturns the result.", "A dispute that is rejected after review (the result stands) lowers your reputation; a dispute that turns out to be justified does not.", "Cheats, exploits, match fixing, playing on someone else's account, smurf accounts and pressure on opponents or referees are prohibited. Sanctions are applied with a stated reason and recorded in the decision log. Decisions can be appealed through support."]],
      ["6. XP, coins, ranks and the season pass", ["XP and coins are non-monetary activity points. They are credited only for confirmed activity described on the portal: objectives, pass tiers, referral bonuses and tournament awards set by the operator.", "Coins can be spent only on cosmetic items and the premium pass track. They cannot be bought, sold, transferred, exchanged for money or goods, staked on an outcome or withdrawn, and have no value outside the portal.", "Wrongly credited XP and coins may be corrected. XP and coins end with the account."]],
      ["7. 1v1 challenges and quick match", ["Challenges and quick matches carry no stakes. Quick match pairs you only with a real player waiting in the queue for the same game.", "The opponent confirms the result; the portal team decides disputed results."]],
      ["8. Paid membership", ["MAXIMUS VEGAS L.L.C-FZ may offer an optional paid membership. It provides cosmetic features and the premium pass track only and never affects seeding, results, rankings or access to tournaments.", "Price, currency, term, tax treatment, what is included and excluded, and cancellation and refund terms are shown in the offer before payment and form part of the agreement you accept at checkout. The accepted version is recorded.", "A membership is activated only after the application is approved and the payment provider confirms the payment. Card details are entered on the provider's page and never reach the portal. There is no automatic renewal."]],
      ["9. User content", ["You keep the rights to your content and grant the operator the right to display it on the portal to the extent needed to run the service. Illegal material, abuse, discrimination and infringement of others' rights are prohibited."]],
      ["10. Games and publishers", ["Game titles belong to their rights holders. The portal is not affiliated with publishers unless expressly stated. Publisher integrations are connected only with their permission; until then results are verified manually."]],
      ["11. Service availability", ["Features marked “in development”, “requires connection” or “research” are not live services. We aim for uninterrupted operation but do not guarantee it and may change portal features."]],
      ["12. Liability", ["The portal is provided “as is”. The operator is not liable for the actions of third parties, game servers or publishers. Nothing in these terms limits liability that cannot be limited under applicable law."]],
      ["13. Termination and changes", ["You can delete your account in settings. We may suspend an account for breach of these terms. We announce material changes on the portal and ask you to accept the new version; the accepted version is recorded."]],
    ],
  },
};

const privacy: Record<Locale, Doc> = {
  ru: {
    title: "Уведомление о конфиденциальности",
    sections: [
      ["Кто обрабатывает данные", ["MAXIMUS VEGAS L.L.C-FZ, Meydan Free Zone, Dubai, UAE — оператор портала. Вопросы о данных: info@maximus.ltd."]],
      ["Какие данные мы собираем", [
        "Аккаунт: email, имя пользователя, отображаемое имя, хеш пароля (сам пароль не хранится), подтверждение возраста 18+, дата подтверждения email.",
        "Согласия: какие версии условий и уведомления вы приняли и когда; отдельная отметка о рассылках (по умолчанию выключена).",
        "Профиль по вашему выбору: страна, описание, игровые ники, цвет аватара.",
        "Участие: команды, заявки, check-in, результаты матчей и статистика leaderboard, доказательства (ссылки и изображения), споры и решения, вызовы и очередь быстрого матча.",
        "Прогрессия: XP, монеты и их история, косметические предметы, прогресс пропуска, реферальный код и его использование.",
        "Членство и оплаты: заявки, счета, попытки оплаты и подтверждения провайдера (сумма, валюта, статус, идентификаторы). Данные карты вводятся только на странице платёжного провайдера и не попадают на портал.",
        "Безопасность: сессии (время, браузер), неудачные попытки входа в виде хеша, одноразовые токены подтверждения и восстановления в виде хеша, журнал критичных действий. Для сотрудников — второй фактор входа и хеши резервных кодов.",
        "Обращения: имя, email, организация и текст сообщения.",
      ]],
      ["Зачем", ["Чтобы вести аккаунт, проводить турниры и матчи, проверять результаты, разрешать споры, начислять прогрессию, рассматривать заявки на членство и учитывать оплаты, обеспечивать честную игру и безопасность, отвечать на обращения.", "Рассылки отправляются только при вашем отдельном согласии; сейчас портал рассылок не отправляет."]],
      ["Cookie и память браузера", ["Используются только необходимые cookie: сессия входа, кратковременная копия введённых в форму регистрации данных (без пароля) на случай ошибки и одноразовая передача резервных кодов второго фактора сотрудникам. Чтобы смена языка не стирала форму регистрации, введённое (без пароля) хранится в памяти текущей вкладки браузера и удаляется при отправке. Рекламных и аналитических cookie нет."]],
      ["Кому передаются данные", ["Провайдеру хостинга и управляемой базы данных — для работы портала. Если подключён сервис доставки email — адрес и текст служебного письма. Если подключены оплаты — платёжному провайдеру: email, сумма и номер счёта. Если настроен внешний сервис заявок — данные обращений. Данные не продаются.", "Фактически подключённые сервисы перечислены ниже на этой странице; новый сервис указывается здесь до его включения."]],
      ["Где хранятся данные", ["Серверы портала работают у хостинг-провайдера в регионе, указанном ниже. Расположение базы данных определяется её провайдером."]],
      ["Публичность", ["Публичный профиль и результаты видны всем. Профиль можно скрыть в настройках; результаты матчей остаются в сетках турниров, так как они являются частью результатов других участников. Изображения-доказательства видят только участники матча и сотрудники."]],
      ["Хранение и удаление", ["Данные хранятся, пока существует аккаунт. При удалении аккаунта личные данные обезличиваются, сессии завершаются; записи о матчах и журнал решений сохраняются без вашего имени для целостности турниров.", "Незавершённые заявки на членство отзываются, неоплаченные счета аннулируются, членство прекращается. Если платёж ещё обрабатывается провайдером, удалить аккаунт можно после его завершения.", "Счета, оплаты и бухгалтерские записи сохраняются столько, сколько требует применимое бухгалтерское и налоговое законодательство, и остаются связанными с обезличенным аккаунтом."]],
      ["Ваши права", ["Выгрузить свои данные (JSON), изменить согласие на рассылки и удалить аккаунт можно в настройках. По другим запросам пишите на info@maximus.ltd."]],
    ],
  },
  en: {
    title: "Privacy notice",
    sections: [
      ["Who processes data", ["MAXIMUS VEGAS L.L.C-FZ, Meydan Free Zone, Dubai, UAE — the portal operator. Data questions: info@maximus.ltd."]],
      ["What we collect", [
        "Account: email, username, display name, password hash (the password itself is never stored), 18+ confirmation, email confirmation date.",
        "Consents: which versions of the terms and notice you accepted and when; a separate marketing preference (off by default).",
        "Profile, at your choice: country, bio, in-game names, avatar colour.",
        "Participation: teams, entries, check-ins, match results and leaderboard stats, evidence (links and images), disputes and decisions, challenges and the quick match queue.",
        "Progression: XP, coins and their history, cosmetic items, pass progress, your referral code and its use.",
        "Membership and payments: applications, invoices, payment attempts and provider confirmations (amount, currency, status, references). Card details are entered only on the payment provider's page and never reach the portal.",
        "Security: sessions (time, browser), failed sign-in attempts in hashed form, one-time confirmation and recovery tokens in hashed form, a log of critical actions. For staff, a second sign-in factor and hashed recovery codes.",
        "Inquiries: name, email, organisation and message text.",
      ]],
      ["Why", ["To run your account, hold tournaments and matches, verify results, resolve disputes, credit progression, review membership applications and record payments, ensure fair play and security, and answer inquiries.", "Marketing emails are sent only with your separate consent; the portal currently sends none."]],
      ["Cookies and browser storage", ["Only necessary cookies are used: the sign-in session, a short-lived copy of what you typed into the sign-up form (never the password) in case of an error, and a one-time hand-over of staff recovery codes. So that switching language does not wipe the sign-up form, what you type there (never the password) is kept in the current browser tab's storage and removed when you submit. No advertising or analytics cookies."]],
      ["Who receives data", ["The hosting and managed database provider — to run the portal. If an email delivery service is connected — the address and text of service emails. If payments are connected — the payment provider receives your email, the amount and the invoice number. If an external inquiry service is configured — inquiry data. Data is never sold.", "The services actually connected are listed below on this page; a new service is named here before it is switched on."]],
      ["Where data is stored", ["The portal's servers run at the hosting provider in the region listed below. The database location is determined by its provider."]],
      ["Visibility", ["A public profile and results are visible to everyone. You can hide your profile in settings; match results remain in tournament brackets because they are part of other participants' results. Evidence images are visible only to the match participants and staff."]],
      ["Retention and deletion", ["Data is kept while the account exists. When you delete your account, personal data is anonymised and sessions end; match records and the decision log are kept without your name to preserve tournament integrity.", "Open membership applications are withdrawn, unpaid invoices are voided and any membership ends. If the provider is still processing a payment, the account can be deleted once it settles.", "Invoices, payments and accounting records are kept for as long as applicable accounting and tax law requires and remain linked to the anonymised account."]],
      ["Your rights", ["You can export your data (JSON), change your marketing preference and delete your account in settings. For other requests, write to info@maximus.ltd."]],
    ],
  },
};

export const legalDocs = { terms, privacy };
