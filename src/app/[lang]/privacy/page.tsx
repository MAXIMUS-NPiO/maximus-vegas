import type { Metadata } from "next";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { LEGAL_DATES, LEGAL_VERSIONS, legalDocs } from "@/lib/legal.ts";
import { pageMeta } from "@/lib/meta.ts";
import { connectedServices } from "@/server/services.ts";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "privacy", legalDocs.privacy[lang].title);
}

const KIND: Record<string, { ru: string; en: string; purpose: { ru: string; en: string } }> = {
  hosting: { ru: "Хостинг портала", en: "Portal hosting", purpose: { ru: "работа сайта и серверных функций", en: "running the website and server functions" } },
  database: { ru: "База данных", en: "Database", purpose: { ru: "хранение аккаунтов, турниров, счетов и журнала", en: "storing accounts, tournaments, invoices and the log" } },
  email: { ru: "Доставка писем", en: "Email delivery", purpose: { ru: "служебные письма: подтверждение, восстановление, счета", en: "service emails: confirmation, recovery, invoices" } },
  payments: { ru: "Платёжный провайдер", en: "Payment provider", purpose: { ru: "оплата членства на странице провайдера", en: "membership payment on the provider's page" } },
  inquiries: { ru: "Копия обращений", en: "Inquiry copy", purpose: { ru: "обработка обращений командой портала", en: "handling inquiries by the portal team" } },
};

export default async function LegalPage({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  // Rendered per request: the list of connected services must reflect the live configuration.
  await connection();
  const ru = lang === "ru";
  const doc = legalDocs.privacy[lang];
  const services = connectedServices();
  return (
    <article className="container narrow page legal">
      <h1>{doc.title}</h1>
      <p className="muted small">
        {LEGAL_DATES[lang]} · {ru ? "версия" : "version"} <span className="mono">{LEGAL_VERSIONS.privacy}</span>
      </p>
      {doc.sections.map(([title, paragraphs]) => (
        <section key={title}>
          <h2 className="h4">{title}</h2>
          {paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </section>
      ))}
      <section id="services">
        <h2 className="h4">{ru ? "Подключённые сервисы сейчас" : "Services connected right now"}</h2>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{ru ? "Назначение" : "Purpose"}</th>
                <th>{ru ? "Сервис" : "Service"}</th>
                <th>{ru ? "Регион" : "Region"}</th>
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.kind}>
                  <td>
                    <strong>{ru ? KIND[s.kind].ru : KIND[s.kind].en}</strong>
                    <div className="small muted">{ru ? KIND[s.kind].purpose.ru : KIND[s.kind].purpose.en}</div>
                  </td>
                  <td>{s.active ? s.name : ru ? "Не подключён" : "Not connected"}</td>
                  <td className="small">{s.active ? (s.region ?? (ru ? "определяется провайдером" : "set by the provider")) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          {ru
            ? "Список формируется из текущей конфигурации портала при каждом открытии страницы."
            : "This list is generated from the portal's current configuration every time the page is opened."}
        </p>
      </section>
    </article>
  );
}
