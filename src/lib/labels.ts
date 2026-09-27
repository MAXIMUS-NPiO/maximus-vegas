import type { Locale } from "./i18n.ts";

type Map = Record<string, string>;
const pick = (lang: Locale, ru: Map, en: Map, key: string) => (lang === "ru" ? ru : en)[key] ?? key;

export const reviewLabel = (review: string, lang: Locale) =>
  pick(lang, { accepted: "Учтён", approved: "Подтверждён организатором", pending: "На проверке", rejected: "Отклонён" }, { accepted: "Counted", approved: "Approved by the organiser", pending: "In review", rejected: "Rejected" }, review);

export const flagLabel = (flag: string, lang: Locale) =>
  pick(
    lang,
    { headshots_exceed_kills: "попаданий в голову больше, чем убийств", kills_extreme: "более 40 убийств", damage_extreme: "более 6000 урона", distance_extreme: "более 20 000 м пути" },
    { headshots_exceed_kills: "more headshots than kills", kills_extreme: "over 40 kills", damage_extreme: "over 6,000 damage", distance_extreme: "over 20,000 m travelled" },
    flag,
  );

export const challengeStatus = (status: string, lang: Locale) =>
  pick(
    lang,
    { pending: "Ждёт ответа", accepted: "Принят — играйте", declined: "Отклонён", cancelled: "Отменён", expired: "Истёк", reported: "Результат на подтверждении", completed: "Завершён", disputed: "Спор у команды портала" },
    { pending: "Awaiting reply", accepted: "Accepted — play it", declined: "Declined", cancelled: "Cancelled", expired: "Expired", reported: "Result awaiting confirmation", completed: "Completed", disputed: "Disputed — with the portal team" },
    status,
  );

export const applicationStatus = (status: string, lang: Locale) =>
  pick(
    lang,
    { submitted: "Подана", under_review: "На рассмотрении", awaiting_info: "Нужны сведения", approved: "Одобрена", declined: "Отклонена", withdrawn: "Отозвана" },
    { submitted: "Submitted", under_review: "Under review", awaiting_info: "Information needed", approved: "Approved", declined: "Declined", withdrawn: "Withdrawn" },
    status,
  );

export const invoiceStatus = (status: string, lang: Locale) =>
  pick(
    lang,
    { open: "К оплате", paid: "Оплачен", void: "Аннулирован", refunded: "Возвращён", partially_refunded: "Частичный возврат", disputed: "Оспорен в банке" },
    { open: "Open", paid: "Paid", void: "Void", refunded: "Refunded", partially_refunded: "Partially refunded", disputed: "Disputed with the bank" },
    status,
  );

export const attemptStatus = (status: string, lang: Locale) =>
  pick(
    lang,
    { created: "Создана", open: "Ожидает оплаты у провайдера", processing: "Обрабатывается провайдером", succeeded: "Оплата подтверждена провайдером", failed: "Не прошла", expired: "Истекла", canceled: "Отменена" },
    { created: "Created", open: "Awaiting payment at the provider", processing: "Being processed by the provider", succeeded: "Confirmed by the provider", failed: "Failed", expired: "Expired", canceled: "Cancelled" },
    status,
  );

export const membershipStatus = (status: string, lang: Locale) =>
  pick(
    lang,
    { pending: "Ожидает оплаты", active: "Действует", suspended: "Приостановлено", expired: "Истекло", ended: "Завершено" },
    { pending: "Awaiting payment", active: "Active", suspended: "Suspended", expired: "Expired", ended: "Ended" },
    status,
  );

export const offerStatus = (status: string, lang: Locale) =>
  pick(lang, { proposed: "Предложено (не активно)", active: "Активно", retired: "Выведено" }, { proposed: "Proposed (not active)", active: "Active", retired: "Retired" }, status);

export const readinessReason = (reason: string, lang: Locale) =>
  pick(
    lang,
    {
      payments_disabled: "Оплаты выключены (PAYMENTS_ENABLED)",
      provider_not_configured: "Провайдер не подключён (STRIPE_SECRET_KEY)",
      provider_key_unrecognised: "Ключ провайдера не распознан",
      webhook_secret_missing: "Нет секрета webhook (STRIPE_WEBHOOK_SECRET)",
      mode_not_declared: "Не задан режим (PAYMENTS_MODE)",
      mode_mismatch: "Режим не совпадает с ключом",
      live_not_confirmed: "Боевой режим не подтверждён (PAYMENTS_LIVE_CONFIRMED)",
      merchant_not_verified: "Мерчант не подтверждён (MERCHANT_VERIFIED)",
      merchant_name_missing: "Не указано юридическое название мерчанта",
      recipient_mismatch: "Мерчант не совпадает с получателем в предложении",
      site_origin_missing: "Не задан адрес сайта (NEXT_PUBLIC_SITE_URL)",
      offer_not_active: "Предложение не утверждено",
      offer_incomplete: "В предложении нет обязательных условий",
    },
    {
      payments_disabled: "Payments are switched off (PAYMENTS_ENABLED)",
      provider_not_configured: "No provider connected (STRIPE_SECRET_KEY)",
      provider_key_unrecognised: "Provider key not recognised",
      webhook_secret_missing: "No webhook secret (STRIPE_WEBHOOK_SECRET)",
      mode_not_declared: "Mode not declared (PAYMENTS_MODE)",
      mode_mismatch: "Mode does not match the key",
      live_not_confirmed: "Live mode not confirmed (PAYMENTS_LIVE_CONFIRMED)",
      merchant_not_verified: "Merchant not verified (MERCHANT_VERIFIED)",
      merchant_name_missing: "Merchant legal name missing",
      recipient_mismatch: "Merchant does not match the offer's recipient",
      site_origin_missing: "Site origin not set (NEXT_PUBLIC_SITE_URL)",
      offer_not_active: "Offer not approved",
      offer_incomplete: "Offer is missing required terms",
    },
    reason,
  );

export const missingLabel = (field: string, lang: Locale) =>
  pick(
    lang,
    { price: "цена", currency: "валюта", exponent: "разрядность валюты", tax_treatment: "налоговый режим", duration: "срок", terms: "условия членства", refund_and_cancellation: "условия отмены и возврата", approval_reference: "основание утверждения" },
    { price: "price", currency: "currency", exponent: "currency exponent", tax_treatment: "tax treatment", duration: "term", terms: "membership terms", refund_and_cancellation: "cancellation and refund terms", approval_reference: "approval reference" },
    field,
  );
