import type { Locale } from "./i18n.ts";
import type { StepAction, StepKey } from "../server/gameday.ts";

/** Texts of the Game Day screen and of the match page's step block (RU / EN). */
const STEPS: Record<StepKey, { ru: string; en: string }> = {
  paused: {
    ru: "Турнир на паузе. Продолжение — по решению организатора; время матчей может сдвинуться.",
    en: "The event is paused. It resumes when the organiser decides; match times may move.",
  },
  waiting_opponent: {
    ru: "Соперник ещё не определён: он выйдет из предыдущего матча. Матч обновится здесь сам.",
    en: "Your opponent is not known yet: they come from an earlier match. This match updates here by itself.",
  },
  check_in: { ru: "Матч готов. Отметьтесь, что вы на месте.", en: "The match is ready. Check in to say you are here." },
  opponent_check_in: {
    ru: "Вы отметились. Ждём отметки соперника; играть можно и без неё.",
    en: "You are checked in. Waiting for your opponent's check-in; you may play without it.",
  },
  opponent_absent: {
    ru: "Соперник не отметился в срок. Позовите судью: он может засчитать неявку.",
    en: "Your opponent did not check in on time. Call the referee: they can record a no-show.",
  },
  play: { ru: "Сыграйте матч{series} и отправьте счёт с доказательством.", en: "Play the match{series} and report the score with evidence." },
  confirm: { ru: "Соперник отправил счёт {score}. Подтвердите его или откройте спор.", en: "Your opponent reported {score}. Confirm it or open a dispute." },
  wait_confirm: {
    ru: "Ваш счёт отправлен. Ждём подтверждения соперника; если он не согласится, решит судья.",
    en: "Your score is in. Waiting for your opponent to confirm; if they disagree, the referee decides.",
  },
  review: { ru: "Спор у судьи. Решение придёт уведомлением.", en: "The dispute is with the referee. The decision arrives as a notification." },
  won: { ru: "Победа. Следующий матч уже в сетке.", en: "You won. Your next match is in the bracket." },
  won_last: { ru: "Победа.", en: "You won." },
  dropped: { ru: "Поражение: вы продолжаете в нижней сетке.", en: "You lost and continue in the lower bracket." },
  lost: { ru: "Поражение.", en: "You lost." },
  draw: { ru: "Ничья.", en: "A draw." },
  bye: { ru: "Проход без игры: вы проходите дальше.", en: "A bye: you advance without playing." },
  cancelled: { ru: "Матч отменён организатором.", en: "The organiser cancelled this match." },
  event_check_in: {
    ru: "Подтвердите участие: отметка показывает организатору, что вы будете играть.",
    en: "Confirm your participation: it tells the organiser you will play.",
  },
  event_ready: { ru: "Участие подтверждено. Первый матч появится здесь при старте.", en: "Participation confirmed. Your first match appears here at the start." },
  waiting_start: { ru: "Турнир ещё не начался. Первый матч появится здесь при старте.", en: "The event has not started. Your first match appears here at the start." },
  waiting_round: {
    ru: "Сейчас матчей для вас нет: ждём следующий тур или итог этапа.",
    en: "No match for you right now: waiting for the next round or the end of the stage.",
  },
  out: { ru: "Вы выбыли. Итоговое место появится после завершения турнира.", en: "You are out. Your final place appears when the event ends." },
  finished: { ru: "Турнир завершён.", en: "The event is over." },
  disqualified: { ru: "Заявка дисквалифицирована. Подробности — на странице турнира.", en: "This entry was disqualified. Details are on the event page." },
  ffa: { ru: "Ваше лобби открыто: код комнаты и игры — на странице лобби.", en: "Your lobby is open: the room code and games are on the lobby page." },
  leaderboard: {
    ru: "Результаты отправляются на странице турнира, пока открыто окно отправки.",
    en: "Results are submitted on the event page while the submission window is open.",
  },
};

const ACTIONS: Record<StepAction | "open_match" | "dispute", { ru: string; en: string }> = {
  checkin: { ru: "Я на месте", en: "I'm here" },
  report: { ru: "Отправить счёт", en: "Report the score" },
  confirm: { ru: "Подтвердить счёт", en: "Confirm the score" },
  call_referee: { ru: "Позвать судью", en: "Call the referee" },
  next: { ru: "К следующему матчу", en: "To the next match" },
  event_checkin: { ru: "Подтвердить участие", en: "Confirm participation" },
  open_lobby: { ru: "Открыть лобби", en: "Open the lobby" },
  open_tournament: { ru: "Открыть турнир", en: "Open the event" },
  open_match: { ru: "Открыть матч", en: "Open the match" },
  dispute: { ru: "Не согласен", en: "I disagree" },
};

const fillVars = (t: string, vars: Record<string, string | number | undefined>) => t.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));

export function stepText(key: StepKey, lang: Locale, vars: { series?: string; score?: string; place?: number | null } = {}) {
  let text = fillVars(STEPS[key][lang], { series: vars.series ? ` (${vars.series})` : "", score: vars.score ?? "" });
  if (key === "finished" && vars.place) text += lang === "ru" ? ` Ваше место: ${vars.place}.` : ` Your place: ${vars.place}.`;
  return text;
}

export const actionText = (action: StepAction | "open_match" | "dispute", lang: Locale) => ACTIONS[action][lang];

export const gameDayText = {
  ru: {
    title: "Игровой день",
    lead: "Ваши турниры на сегодня: что происходит и что сделать сейчас.",
    now: "Сейчас",
    deadline: "Неявку можно зафиксировать с",
    opponent: "Соперник",
    yourRoster: "Ваш состав",
    time: "Время матча",
    readiness: "Готовность",
    you: "вы",
    here: "на месте",
    notYet: "нет отметки",
    format: "Формат",
    venue: "Площадка",
    referee: "Судья",
    callLabel: "Что случилось",
    callHint: "Технический сбой, соперник не пришёл, нарушение правил — коротко, без личных данных.",
    callOpen: "Судья вызван",
    callReply: "Ответ судьи",
    callNoComment: "Вызов закрыт без комментария.",
    evidence: "Доказательства",
    noEvidence: "Доказательств пока нет.",
    next: "Дальше",
    ifWin: "При победе",
    ifLose: "При поражении",
    out: "выбывание",
    startsAt: "Старт",
    emptyTitle: "Сегодня у вас нет турниров",
    emptyBody: "Здесь появятся турниры, которые идут сейчас, начинаются в ближайшие сутки или открыли check-in.",
    leaderOnly: "Действия за команду выполняют капитан или владелец.",
    staffCalls: "Вызовы судьи",
    staffReply: "Ответ участникам",
    staffClose: "Ответить и закрыть",
    staffEmpty: "Открытых вызовов нет.",
    side: "сторона",
  },
  en: {
    title: "Game Day",
    lead: "Your events today: what is happening and what to do now.",
    now: "Now",
    deadline: "A no-show can be recorded from",
    opponent: "Opponent",
    yourRoster: "Your roster",
    time: "Match time",
    readiness: "Readiness",
    you: "you",
    here: "here",
    notYet: "not yet",
    format: "Format",
    venue: "Venue",
    referee: "Referee",
    callLabel: "What happened",
    callHint: "A technical problem, an absent opponent, a rule breach — briefly, without personal data.",
    callOpen: "Referee called",
    callReply: "Referee's reply",
    callNoComment: "Closed without a comment.",
    evidence: "Evidence",
    noEvidence: "No evidence yet.",
    next: "Next",
    ifWin: "If you win",
    ifLose: "If you lose",
    out: "elimination",
    startsAt: "Starts",
    emptyTitle: "No events for you today",
    emptyBody: "Events appear here when they are running, start within a day, or have opened check-in.",
    leaderOnly: "The captain or owner acts for the team.",
    staffCalls: "Referee calls",
    staffReply: "Reply to the participants",
    staffClose: "Reply and close",
    staffEmpty: "No open calls.",
    side: "side",
  },
} satisfies Record<Locale, Record<string, string>>;
