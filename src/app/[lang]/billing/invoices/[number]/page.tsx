import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { attemptStatus, invoiceStatus } from "@/lib/labels.ts";
import { viewer } from "@/server/viewer.ts";
import { formatMoney, invoiceByNumber, paymentReadiness, type Offer } from "@/server/billing.ts";
import { isAdmin } from "@/server/access.ts";
import { ActionForm, Badge, Check, DbDown, Flash, one, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; number: string }> }): Promise<Metadata> {
  const { lang, number } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, `billing/invoices/${number}`, number, undefined, { noindex: true });
}

type Snapshot = {
  title: { ru: string; en: string };
  benefits: { ru: string[]; en: string[] };
  exclusions: { ru: string[]; en: string[] };
  duration_days: number;
  terms_text: { ru: string; en: string } | null;
  refund_text: { ru: string; en: string } | null;
};

export default async function Invoice({ params, searchParams }: { params: Promise<{ lang: string; number: string }>; searchParams: SearchParams }) {
  const { lang, number } = await params;
  if (!isLocale(lang)) notFound();
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user) redirect(`/${lang}/signin?next=/${lang}/billing/invoices/${encodeURIComponent(number)}`);
  if (!/^MV-INV-\d{4}-\d{5,}$/.test(number)) notFound();
  const data = await invoiceByNumber(db, number);
  // Another participant's invoice is indistinguishable from a missing one.
  if (!data || (data.invoice.user_id !== user.id && !isAdmin(user))) notFound();
  const { invoice: inv, attempts, ledger } = data;
  const snap = inv.offer_snapshot as unknown as Snapshot;
  const [offer] = await db.query<Offer>("select * from offers where id = $1", [inv.offer_id]);
  const readiness = paymentReadiness(offer);
  const [me] = await db.query<{ email_verified_at: Date | null }>("select email_verified_at from users where id = $1", [user.id]);
  const back = `/${lang}/billing/invoices/${inv.number}`;
  const payable = inv.status === "open" && inv.user_id === user.id;
  const active = attempts.find((a) => ["open", "processing"].includes(a.status));
  const paid = ledger.filter((l) => l.kind === "charge");

  return (
    <div className="container narrow page invoice">
      <p className="eyebrow">
        <Link href={`/${lang}/billing`}>{T("Членство и счета", "Membership and billing")}</Link>
      </p>
      <div className="row-between">
        <h1 className="mono">{inv.number}</h1>
        <Badge status={inv.status}>{invoiceStatus(inv.status, lang)}</Badge>
      </div>
      <Flash lang={lang} params={sp} />
      {one(sp.canceled) ? <p className="notice">{T("Оплата не завершена. Счёт остаётся открытым.", "Payment was not completed. The invoice stays open.")}</p> : null}

      <section className="card">
        <dl className="kv">
          <div>
            <dt>{T("Получатель", "Recipient")}</dt>
            <dd>{inv.recipient}, Meydan Free Zone, Dubai, UAE</dd>
          </div>
          <div>
            <dt>{T("Назначение", "Purpose")}</dt>
            <dd>{snap.title[lang]}</dd>
          </div>
          {readiness.collector ? <div><dt>{T("Приём оплаты", "Payment collection")}</dt><dd>{readiness.collector} — {T("по внутреннему соглашению с получателем", "under an internal agreement with the beneficiary")}</dd></div> : null}
          <div>
            <dt>{T("Срок", "Term")}</dt>
            <dd>
              {snap.duration_days} {T("дн. с момента подтверждённой оплаты, без автоматического продления", "days from the confirmed payment, no automatic renewal")}
            </dd>
          </div>
          <div>
            <dt>{T("Итого", "Total")}</dt>
            <dd>
              <strong>{formatMoney(inv.amount_minor, inv.currency, lang)}</strong>
            </dd>
          </div>
          <div>
            <dt>{T("Налоговый режим", "Tax treatment")}</dt>
            <dd>{inv.tax_treatment}</dd>
          </div>
          <div>
            <dt>{T("Условия", "Terms version")}</dt>
            <dd className="mono small">{inv.terms_version}</dd>
          </div>
          <div>
            <dt>{T("Выставлен", "Issued")}</dt>
            <dd>
              <LocalTime iso={inv.created_at} lang={lang} />
            </dd>
          </div>
          {inv.paid_at ? (
            <div>
              <dt>{T("Оплата подтверждена", "Payment confirmed")}</dt>
              <dd>
                <LocalTime iso={inv.paid_at} lang={lang} />
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="section-tight">
        <h2 className="h4">{T("Что входит и что нет", "Included and excluded")}</h2>
        <ul className="bullets">
          {snap.benefits[lang].map((b) => (
            <li key={b}>{b}</li>
          ))}
          {snap.exclusions[lang].map((b) => (
            <li key={b} className="muted">
              {b}
            </li>
          ))}
        </ul>
      </section>

      {snap.terms_text ? (
        <details className="disclosure card" open={payable}>
          <summary>{T("Условия членства", "Membership terms")}</summary>
          <p className="prewrap small">{snap.terms_text[lang]}</p>
        </details>
      ) : null}
      {snap.refund_text ? (
        <details className="disclosure card" open={payable}>
          <summary>{T("Отмена и возврат", "Cancellation and refunds")}</summary>
          <p className="prewrap small">{snap.refund_text[lang]}</p>
        </details>
      ) : null}

      {payable ? (
        <section className="card action-card">
          {!readiness.ready ? (
            <p className="notice notice-warn">
              {T("Онлайн-оплата сейчас недоступна. Счёт остаётся открытым; мы сообщим, когда оплата будет включена.", "Online payment is not available right now. The invoice stays open; we will let you know when payment is enabled.")}
            </p>
          ) : !me?.email_verified_at ? (
            <p className="notice notice-warn">
              {T("Перед оплатой подтвердите email в", "Confirm your email before paying in")}{" "}
              <Link href={`/${lang}/settings`} className="text-link">
                {T("настройках", "settings")}
              </Link>
              .
            </p>
          ) : active?.status === "processing" ? (
            <p className="notice">{T("Платёж обрабатывается провайдером. Статус обновится автоматически после подтверждения.", "The payment is being processed by the provider. The status updates automatically once confirmed.")}</p>
          ) : (
            <ActionForm action="billing.checkout" lang={lang} back={back} hidden={{ invoice: inv.id }} className="stack">
              <Check
                name="accept"
                required
                label={T(
                  `Я принимаю условия членства, отмены и возврата (версия ${inv.terms_version}). Получатель — ${inv.recipient}.${readiness.collector ? ` Оплату принимает ${readiness.collector} по внутреннему соглашению.` : ""}`,
                  `I accept the membership, cancellation and refund terms (version ${inv.terms_version}). The beneficiary is ${inv.recipient}.${readiness.collector ? ` Payment is collected by ${readiness.collector} under an internal agreement.` : ""}`,
                )}
              />
              <button className="btn btn-primary">
                {T("Перейти к оплате", "Continue to payment")} · {formatMoney(inv.amount_minor, inv.currency, lang)}
              </button>
              <p className="small muted">
                {T(
                  "Оплата проходит на защищённой странице платёжного провайдера; данные карты на портал не попадают. Доступные способы оплаты показывает провайдер.",
                  "Payment happens on the payment provider's secure page; card details never reach the portal. The provider shows the payment methods available.",
                )}
                {readiness.mode === "test" ? ` ${T("Сейчас включён тестовый режим провайдера: реальные деньги не списываются.", "The provider is in test mode: no real money is charged.")}` : ""}
              </p>
            </ActionForm>
          )}
        </section>
      ) : null}

      {attempts.length ? (
        <section className="section-tight">
          <h2 className="h4">{T("Попытки оплаты", "Payment attempts")}</h2>
          <ul className="list">
            {attempts.map((a) => (
              <li key={a.id}>
                <span className="grow small">
                  <LocalTime iso={a.created_at} lang={lang} /> · {formatMoney(a.amount_minor, a.currency, lang)} · {a.mode === "test" ? T("тест", "test") : T("боевой", "live")}
                </span>
                <Badge status={a.status}>{attemptStatus(a.status, lang)}</Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {paid.length || ledger.length ? (
        <section className="section-tight receipt" aria-label={T("Квитанция", "Receipt")}>
          <h2 className="h4">{T("Квитанция: подтверждения провайдера", "Receipt: provider confirmations")}</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{T("Дата", "Date")}</th>
                  <th>{T("Операция", "Entry")}</th>
                  <th>{T("Сумма", "Amount")}</th>
                  <th>{T("Ссылка провайдера", "Provider reference")}</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((l) => (
                  <tr key={`${l.kind}-${l.provider_ref}`}>
                    <td className="small">
                      <LocalTime iso={l.created_at} lang={lang} />
                    </td>
                    <td>{{ charge: T("Оплата", "Payment"), refund: T("Возврат", "Refund"), dispute: T("Спор в банке", "Bank dispute"), dispute_reversal: T("Спор в банке закрыт в пользу продавца", "Bank dispute closed in the merchant's favour") }[l.kind] ?? l.kind}</td>
                    <td>{formatMoney(l.amount_minor, l.currency, lang)}</td>
                    <td className="mono small">{l.provider_ref}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
