import type { Locale } from "./i18n.ts";

type Doc = { title: string; sections: Array<[string, string[]]> };

const terms: Record<Locale, Doc> = {
  ru: {
    title: "Условия использования",
    sections: [
      ["1. Оператор", ["Портал MAXIMUS VEGAS (maximus.vegas) предоставляет MAXIMUS VEGAS L.L.C-FZ, коммерческая компания Meydan Free Zone, Dubai, UAE. Контакт: info@maximus.ltd."]],
      ["2. Аккаунт", ["Регистрация доступна с 18 лет. Аккаунты для несовершеннолетних с согласием опекуна будут доступны после запуска соответствующего модуля.", "Вы отвечаете за достоверность данных профиля и сохранность пароля. Один человек — один аккаунт; передача аккаунта другому лицу запрещена."]],
      ["3. Бесплатное участие и отсутствие азартных механик", ["Регистрация, команды и участие в турнирах бесплатны.", "На портале нет и не допускаются ставки, пари, лотереи, игры на деньги, платные прогнозы, платные случайные награды и призовые фонды из взносов участников."]],
      ["4. Турниры и результаты", ["Организатор события определяет правила турнира в пределах этих условий. Результат подтверждается соперником или решением судьи. Исправление результата создаёт новую версию и не переписывает молча уже сыгранные зависимые матчи.", "Отправляя доказательство, вы подтверждаете, что имеете право им делиться."]],
      ["5. Честная игра", ["Запрещены читы, эксплойты, договорные матчи, игра за чужой аккаунт, подставные аккаунты и давление на соперников или судей.", "Санкции — от предупреждения до дисквалификации и блокировки аккаунта — применяются с указанием причины и фиксируются в журнале решений. Решение можно обжаловать через поддержку."]],
      ["6. Пользовательский контент", ["Вы сохраняете права на свой контент и предоставляете оператору право отображать его на портале в объёме, необходимом для работы сервиса. Запрещены незаконные материалы, оскорбления, дискриминация и нарушение чужих прав."]],
      ["7. Игры и издатели", ["Названия игр принадлежат их правообладателям. Портал не аффилирован с издателями, если это прямо не указано. Интеграции с издателями подключаются только с их разрешения; до этого результаты проверяются вручную."]],
      ["8. Доступность сервиса", ["Функции, отмеченные как «в разработке», «требует подключения» или «исследование», не являются действующими услугами. Мы стремимся к бесперебойной работе, но не гарантируем её и можем изменять функции портала."]],
      ["9. Ответственность", ["Портал предоставляется «как есть». Оператор не отвечает за действия третьих лиц, игровых серверов и издателей. Ничто в этих условиях не ограничивает ответственность, которую нельзя ограничить по применимому праву."]],
      ["10. Прекращение и изменения", ["Вы можете удалить аккаунт в настройках. Мы можем приостановить аккаунт при нарушении условий. Об изменении условий сообщаем на портале; продолжение использования означает согласие с новой редакцией."]],
    ],
  },
  en: {
    title: "Terms of use",
    sections: [
      ["1. Operator", ["The MAXIMUS VEGAS portal (maximus.vegas) is provided by MAXIMUS VEGAS L.L.C-FZ, a commercial company in Meydan Free Zone, Dubai, UAE. Contact: info@maximus.ltd."]],
      ["2. Account", ["Sign-up is available from 18. Accounts for minors with guardian consent will be available once the corresponding module launches.", "You are responsible for accurate profile data and keeping your password safe. One person, one account; transferring an account to someone else is prohibited."]],
      ["3. Free entry and no gambling mechanics", ["Sign-up, teams and tournament entry are free.", "The portal has no and does not allow betting, wagering, lotteries, real-money games, paid predictions, paid random rewards or prize pools funded by participant fees."]],
      ["4. Tournaments and results", ["An event's organiser sets its rules within these terms. A result is confirmed by the opponent or a referee decision. A correction creates a new version and never silently rewrites dependent matches that were played.", "By submitting evidence you confirm you have the right to share it."]],
      ["5. Fair play", ["Cheats, exploits, match fixing, playing on someone else's account, smurf accounts and pressure on opponents or referees are prohibited.", "Sanctions — from a warning to disqualification and account suspension — are applied with a stated reason and recorded in the decision log. Decisions can be appealed through support."]],
      ["6. User content", ["You keep the rights to your content and grant the operator the right to display it on the portal to the extent needed to run the service. Illegal material, abuse, discrimination and infringement of others' rights are prohibited."]],
      ["7. Games and publishers", ["Game titles belong to their rights holders. The portal is not affiliated with publishers unless expressly stated. Publisher integrations are connected only with their permission; until then results are verified manually."]],
      ["8. Service availability", ["Features marked “in development”, “requires connection” or “research” are not live services. We aim for uninterrupted operation but do not guarantee it and may change portal features."]],
      ["9. Liability", ["The portal is provided “as is”. The operator is not liable for the actions of third parties, game servers or publishers. Nothing in these terms limits liability that cannot be limited under applicable law."]],
      ["10. Termination and changes", ["You can delete your account in settings. We may suspend an account for breach of these terms. We announce changes on the portal; continued use means acceptance of the new version."]],
    ],
  },
};

const privacy: Record<Locale, Doc> = {
  ru: {
    title: "Уведомление о конфиденциальности",
    sections: [
      ["Кто обрабатывает данные", ["MAXIMUS VEGAS L.L.C-FZ, Meydan Free Zone, Dubai, UAE — оператор портала. Вопросы о данных: info@maximus.ltd."]],
      ["Какие данные мы собираем", ["Аккаунт: email, имя пользователя, отображаемое имя, хеш пароля (сам пароль не хранится), подтверждение возраста 18+.", "Профиль по вашему выбору: страна или город, описание, игровые ники.", "Участие: команды, заявки, check-in, результаты матчей, доказательства в виде ссылок, споры и решения.", "Безопасность: сессии (время, браузер), неудачные попытки входа в обезличенном виде (хеш), журнал критичных действий.", "Обращения: имя, email, организация и текст сообщения."]],
      ["Зачем", ["Чтобы вести аккаунт, проводить турниры, проверять результаты, разрешать споры, обеспечивать честную игру и безопасность, отвечать на обращения."]],
      ["Cookie", ["Используется только необходимый cookie сессии для входа в аккаунт. Рекламных и аналитических cookie нет."]],
      ["Кому передаются данные", ["Провайдеру хостинга и управляемой базы данных — для работы портала. Если настроен внешний сервис обработки заявок, данные обращений передаются ему. Данные не продаются."]],
      ["Публичность", ["Публичный профиль и результаты видны всем. Профиль можно скрыть в настройках; результаты матчей остаются в сетках турниров, так как они являются частью результатов других участников."]],
      ["Хранение и удаление", ["Данные хранятся, пока существует аккаунт. При удалении аккаунта личные данные обезличиваются, сессии завершаются; записи о матчах и журнал решений сохраняются без вашего имени для целостности турниров."]],
      ["Ваши права", ["Выгрузить свои данные (JSON) и удалить аккаунт можно в настройках. По другим запросам пишите на info@maximus.ltd."]],
    ],
  },
  en: {
    title: "Privacy notice",
    sections: [
      ["Who processes data", ["MAXIMUS VEGAS L.L.C-FZ, Meydan Free Zone, Dubai, UAE — the portal operator. Data questions: info@maximus.ltd."]],
      ["What we collect", ["Account: email, username, display name, password hash (the password itself is never stored), 18+ age confirmation.", "Profile, at your choice: country or city, bio, in-game names.", "Participation: teams, entries, check-ins, match results, evidence links, disputes and decisions.", "Security: sessions (time, browser), failed sign-in attempts in hashed form, a log of critical actions.", "Inquiries: name, email, organisation and message text."]],
      ["Why", ["To run your account, hold tournaments, verify results, resolve disputes, ensure fair play and security, and answer inquiries."]],
      ["Cookies", ["Only a necessary session cookie is used to keep you signed in. No advertising or analytics cookies."]],
      ["Who receives data", ["The hosting and managed database provider — to run the portal. If an external inquiry service is configured, inquiry data is passed to it. Data is never sold."]],
      ["Visibility", ["A public profile and results are visible to everyone. You can hide your profile in settings; match results remain in tournament brackets because they are part of other participants' results."]],
      ["Retention and deletion", ["Data is kept while the account exists. When you delete your account, personal data is anonymised and sessions end; match records and the decision log are kept without your name to preserve tournament integrity."]],
      ["Your rights", ["You can export your data (JSON) and delete your account in settings. For other requests, write to info@maximus.ltd."]],
    ],
  },
};

export const legalDocs = { terms, privacy };
