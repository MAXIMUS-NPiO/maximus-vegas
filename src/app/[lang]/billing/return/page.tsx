import {reportError} from "@/server/observability.ts";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { attemptStatus } from "@/lib/labels.ts";
import { viewer } from "@/server/viewer.ts";
import { attemptForUser, reconcileAttempt } from "@/server/billing.ts";
import { Badge, DbDown, one, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "billing/return", lang === "ru" ? "Статус оплаты" : "Payment status", undefined, { noindex: true });
}

/**
 * The provider redirects here after checkout. Query parameters are never trusted: the page reads the
 * attempt from the database and, if it is still open, asks the provider for the authoritative state.
 */
export default async function Return({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
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
  const attemptId = one(sp.attempt);
  if (!user) redirect(`/${lang}/signin?next=${encodeURIComponent(`/${lang}/billing/return?attempt=${attemptId}`)}`);
  let attempt = await attemptForUser(db, attemptId, user.id);
  if (!attempt) notFound();
  if (["open", "processing"].includes(attempt.status)) {
    await reconcileAttempt(db, attempt.id, "return").catch((e) => reportError("checkout.return_failure", e));
    attempt = (await attemptForUser(db, attemptId, user.id))!;
  }
  const status = attempt.status;
  return (
    <div className="container narrow page">
      <h1>{T("Статус оплаты", "Payment status")}</h1>
      <p>
        <Badge status={status}>{attemptStatus(status, lang)}</Badge>
      </p>
      {status === "succeeded" ? (
        <p className="notice notice-ok">{T("Платёжный провайдер подтвердил оплату. Членство активируется по правилам предложения.", "The payment provider confirmed the payment. Membership is activated under the offer's rules.")}</p>
      ) : status === "processing" || status === "open" ? (
        <p className="notice">
          {T(
            "Подтверждение от провайдера ещё не получено. Некоторые способы оплаты подтверждаются с задержкой — статус обновится автоматически. Ничего не оплачивайте повторно.",
            "The provider has not confirmed the payment yet. Some payment methods confirm with a delay — the status updates automatically. Do not pay again.",
          )}
        </p>
      ) : (
        <p className="notice notice-warn">{T("Оплата не прошла или истекла. Счёт остаётся открытым.", "The payment did not go through or expired. The invoice stays open.")}</p>
      )}
      <div className="row">
        <Link href={`/${lang}/billing/invoices/${attempt.number}`} className="btn btn-primary btn-sm">
          {T("Открыть счёт", "Open the invoice")}
        </Link>
        <Link href={`/${lang}/billing`} className="btn btn-ghost btn-sm">
          {T("Членство и счета", "Membership and billing")}
        </Link>
      </div>
    </div>
  );
}
