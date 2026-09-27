import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { isStaff } from "@/server/access.ts";
import { mfaStatus } from "@/server/mfa.ts";
import { ActionForm, DbDown, Field, Flash, one, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "admin/mfa", lang === "ru" ? "Подтверждение входа" : "Confirm sign-in", undefined, { noindex: true });
}

export default async function MfaCheck({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  const sp = await searchParams;
  const requested = one(sp.next);
  const next = /^\/(ru|en)\/admin(\/|\?|$)/.test(requested) && !requested.includes("//") ? requested : `/${lang}/admin`;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user) redirect(`/${lang}/signin?next=${encodeURIComponent(`/${lang}/admin/mfa?next=${encodeURIComponent(next)}`)}`);
  if (!isStaff(user)) redirect(`/${lang}/admin`);
  const status = await mfaStatus(db, user.id);
  if (!status.enrolled) redirect(`/${lang}/admin/security`);
  const stepUp = one(sp.e) === "step_up_required";
  return (
    <div className="container narrow page">
      <h1>{T("Подтверждение входа", "Confirm sign-in")}</h1>
      <p className="lead">
        {stepUp
          ? T("Для этого действия нужен свежий код: с последней проверки прошло больше 15 минут.", "This action needs a fresh code: more than 15 minutes have passed since the last check.")
          : T("Введите код из приложения-аутентификатора или один из резервных кодов.", "Enter the code from your authenticator app or one of your recovery codes.")}
      </p>
      <Flash lang={lang} params={stepUp ? {} : sp} />
      <ActionForm action="mfa.verify" lang={lang} back={`/${lang}/admin/mfa?next=${encodeURIComponent(next)}`} hidden={{ next }} className="card form-card">
        <Field label={T("Код", "Code")} hint={T("6 цифр или резервный код вида ABCDE-FGHIJ", "6 digits or a recovery code like ABCDE-FGHIJ")}>
          <input name="code" required minLength={6} maxLength={12} autoComplete="one-time-code" autoFocus spellCheck={false} autoCapitalize="characters" />
        </Field>
        <button className="btn btn-primary">{T("Подтвердить", "Confirm")}</button>
      </ActionForm>
      <p className="small muted">
        {T("Если после подтверждения вы вернётесь на форму, отправьте действие ещё раз — оно не выполнялось.", "After confirming, submit your action again — it was not carried out.")}{" "}
        <Link href={`/${lang}/admin/security`} className="text-link">
          {T("Настройки второго фактора", "Second factor settings")}
        </Link>
      </p>
    </div>
  );
}
