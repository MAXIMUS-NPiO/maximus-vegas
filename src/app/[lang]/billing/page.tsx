import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { applicationStatus, invoiceStatus, membershipStatus } from "@/lib/labels.ts";
import { viewer } from "@/server/viewer.ts";
import { billingFor, formatMoney } from "@/server/billing.ts";
import { ActionForm, Badge, DbDown, Empty, Flash, one, PageHead, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "billing", lang === "ru" ? "Членство и счета" : "Membership and billing", undefined, { noindex: true });
}

export default async function Billing({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
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
  if (!user) redirect(`/${lang}/signin?next=/${lang}/billing`);
  const { applications, invoices, memberships } = await billingFor(db, user.id);
  const ref = one(sp.ref);
  const back = `/${lang}/billing`;
  return (
    <div className="container page">
      <PageHead eyebrow={T("ЛИЧНОЕ", "PERSONAL")} title={T("Членство и счета", "Membership and billing")} lead={T("Заявки, счета, оплаты и сроки членства. Статус оплаты берётся только из подтверждения платёжного провайдера.", "Applications, invoices, payments and membership terms. Payment status comes only from the payment provider's confirmation.")}>
        <Link href={`/${lang}/membership`} className="btn btn-ghost btn-sm">
          {T("О членстве", "About membership")}
        </Link>
      </PageHead>
      <Flash lang={lang} params={sp} />
      {ref ? (
        <p className="notice notice-ok">
          {T("Номер заявки", "Application reference")}: <strong className="mono">{ref}</strong>
        </p>
      ) : null}

      <section className="section-tight">
        <h2 className="h3">{T("Членство", "Membership")}</h2>
        {memberships.length ? (
          <ul className="list">
            {memberships.map((m) => (
              <li key={m.id}>
                <span className="grow">
                  {m.title[lang]}
                  {m.starts_at && m.ends_at ? (
                    <span className="small muted">
                      {" "}
                      · <LocalTime iso={m.starts_at} lang={lang} dateOnly /> — <LocalTime iso={m.ends_at} lang={lang} dateOnly />
                    </span>
                  ) : null}
                </span>
                <Badge status={m.status}>{membershipStatus(m.status, lang)}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={T("Членства нет", "No membership")}>{T("Всё участие на портале бесплатно и без членства.", "All participation on the portal is free without membership.")}</Empty>
        )}
      </section>

      <section className="section-tight">
        <h2 className="h3">{T("Заявки", "Applications")}</h2>
        {applications.length ? (
          <ul className="list">
            {applications.map((a) => (
              <li key={a.id} className="stack-sm">
                <div className="row-between">
                  <span>
                    <strong className="mono">{a.reference}</strong> · {a.title[lang]}
                  </span>
                  <Badge status={a.status}>{applicationStatus(a.status, lang)}</Badge>
                </div>
                <p className="small muted">
                  <LocalTime iso={a.created_at} lang={lang} />
                  {a.decision_note && ["approved", "declined", "awaiting_info"].includes(a.status) ? ` · ${a.decision_note}` : ""}
                </p>
                {["submitted", "under_review", "awaiting_info"].includes(a.status) ? (
                  <ActionForm action="membership.withdraw" lang={lang} back={back} hidden={{ application: a.id }}>
                    <button className="btn btn-ghost btn-xs">{T("Отозвать заявку", "Withdraw application")}</button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">{T("Заявок нет.", "No applications.")}</p>
        )}
      </section>

      <section className="section-tight">
        <h2 className="h3">{T("Счета", "Invoices")}</h2>
        {invoices.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{T("Номер", "Number")}</th>
                  <th>{T("Сумма", "Amount")}</th>
                  <th>{T("Статус", "Status")}</th>
                  <th>{T("Дата", "Date")}</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <Link href={`/${lang}/billing/invoices/${i.number}`} className="text-link mono">
                        {i.number}
                      </Link>
                    </td>
                    <td>{formatMoney(i.amount_minor, i.currency, lang)}</td>
                    <td>
                      <Badge status={i.status}>{invoiceStatus(i.status, lang)}</Badge>
                    </td>
                    <td className="small">
                      <LocalTime iso={i.created_at} lang={lang} dateOnly />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted small">{T("Счетов нет.", "No invoices.")}</p>
        )}
      </section>
    </div>
  );
}
