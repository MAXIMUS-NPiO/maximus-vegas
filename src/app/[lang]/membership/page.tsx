import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { formatMoney, missingFields, publicOffer } from "@/server/billing.ts";
import { ActionForm, DbDown, Field, Flash, PageHead, SignInPrompt, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(
    lang,
    "membership",
    lang === "ru" ? "Членство MAXIMUS VEGAS" : "MAXIMUS VEGAS membership",
    lang === "ru" ? "Необязательное членство: премиальная линия пропуска и косметика. Никакого преимущества в игре." : "Optional membership: premium pass track and cosmetics. No in-game advantage.",
  );
}

export default async function Membership({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
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
  const offer = await publicOffer(db);
  const complete = offer ? offer.status === "active" && missingFields(offer).length === 0 : false;
  const [open] = user && offer ? await db.query<{ reference: string; status: string }>(
    "select reference, status from membership_applications where user_id = $1 and offer_id in (select id from offers where code = $2) and status in ('submitted','under_review','awaiting_info','approved') order by created_at desc limit 1",
    [user.id, offer.code],
  ) : [];
  const back = `/${lang}/membership`;
  return (
    <div className="container page">
      <PageHead
        eyebrow={T("СООБЩЕСТВО", "COMMUNITY")}
        title={offer ? offer.title[lang] : T("Членство", "Membership")}
        lead={T(
          "Членство необязательно. Регистрация, команды, турниры, вызовы и быстрые матчи остаются бесплатными для всех. Членство даёт только косметические возможности и премиальную линию сезонного пропуска.",
          "Membership is optional. Sign-up, teams, tournaments, challenges and quick matches stay free for everyone. Membership provides cosmetic features and the premium season-pass track only.",
        )}
      />
      <Flash lang={lang} params={sp} />
      {!offer ? (
        <p className="notice">{T("Предложение пока не опубликовано.", "No offer has been published yet.")}</p>
      ) : (
        <div className="split">
          <div className="stack">
            <section className="card stack-sm">
              <h2 className="h4">{T("Что входит", "What is included")}</h2>
              <ul className="bullets">
                {offer.benefits[lang].map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              {offer.exclusions[lang].length ? (
                <>
                  <h2 className="h4">{T("Что не входит", "What is not included")}</h2>
                  <ul className="bullets">
                    {offer.exclusions[lang].map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
            <section className="card stack-sm">
              <h2 className="h4">{T("Условия", "Terms")}</h2>
              {complete ? (
                <dl className="kv">
                  <div>
                    <dt>{T("Цена", "Price")}</dt>
                    <dd>{formatMoney(offer.price_minor, offer.currency, lang)}</dd>
                  </div>
                  <div>
                    <dt>{T("Срок", "Term")}</dt>
                    <dd>
                      {offer.duration_days} {T("дн.", "days")} · {T("без автоматического продления", "no automatic renewal")}
                    </dd>
                  </div>
                  <div>
                    <dt>{T("Налоговый режим", "Tax treatment")}</dt>
                    <dd>{offer.tax_treatment}</dd>
                  </div>
                  <div>
                    <dt>{T("Получатель платежа", "Payment recipient")}</dt>
                    <dd>{offer.legal_recipient}</dd>
                  </div>
                  <div>
                    <dt>{T("Порядок", "Process")}</dt>
                    <dd>{offer.admission === "self_service" ? T("Счёт выставляется сразу после заявки", "An invoice is issued right after you apply") : T("Заявка → рассмотрение → счёт → оплата", "Application → review → invoice → payment")}</dd>
                  </div>
                </dl>
              ) : (
                <p>
                  {T(
                    "Условия оплаты направляются только после рассмотрения заявки. Цена, срок, налоговый режим, условия отмены и возврата будут показаны в счёте до оплаты.",
                    "Payment terms are issued only after your application is reviewed. The price, term, tax treatment, and cancellation and refund terms are shown on the invoice before any payment.",
                  )}
                </p>
              )}
              <p className="small muted">
                {T("Заявка бесплатна и ни к чему не обязывает. Подача заявки не означает членства, а оплата не означает одобрения.", "Applying is free and commits you to nothing. An application is not membership, and a payment is not an approval.")}
              </p>
            </section>
          </div>
          <div className="stack">
            {!user ? (
              <SignInPrompt lang={lang} back={back} />
            ) : open ? (
              <div className="card stack-sm">
                <p className="field-label">{T("Ваша заявка", "Your application")}</p>
                <p className="mono">{open.reference}</p>
                <Link href={`/${lang}/billing`} className="btn btn-primary btn-sm">
                  {T("Открыть статус", "View status")}
                </Link>
              </div>
            ) : (
              <ActionForm action="membership.apply" lang={lang} back={back} hidden={{ offer: offer.code }} className="card form-card">
                <h2 className="h4">{T("Подать заявку", "Apply")}</h2>
                <Field label={T("Зачем вам членство", "Why you want membership")} hint={T("необязательно", "optional")}>
                  <textarea name="objective" rows={3} maxLength={1000} />
                </Field>
                <button className="btn btn-primary">{T("Отправить заявку", "Submit application")}</button>
                <p className="small muted">{T("Номер заявки появится сразу после сохранения.", "The application reference appears as soon as it is saved.")}</p>
              </ActionForm>
            )}
            <p className="small">
              <Link href={`/${lang}/terms`} className="text-link">
                {T("Условия использования, раздел 8", "Terms of use, section 8")}
              </Link>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
