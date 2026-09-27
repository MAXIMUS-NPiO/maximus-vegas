import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { mailConfigured } from "@/server/mail.ts";
import { ApplicationForm } from "@/components/application-form";
import { ActionForm, Field, Flash, one, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "forgot-password", dict(lang).auth.forgotTitle, undefined, { noindex: true });
}

export default async function Forgot({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  const sp = await searchParams;
  const { user } = await viewer();
  const back = `/${lang}/forgot-password`;
  const sent = one(sp.ok) === "reset_sent";

  if (!mailConfigured())
    return (
      <div className="container narrow page">
        <h1>{d.auth.forgotTitle}</h1>
        <p className="lead">{d.auth.forgotText}</p>
        <Flash lang={lang} params={sp} />
        <ApplicationForm lang={lang} back={back} kinds={["support"]} user={user} title={d.auth.contactSupport} />
      </div>
    );

  return (
    <div className="container narrow page">
      <h1>{d.auth.forgotTitle}</h1>
      <p className="lead">
        {T(
          "Укажите email аккаунта. Если такой аккаунт есть, мы пришлём ссылку для нового пароля. Ссылка действует 30 минут.",
          "Enter your account email. If an account exists, we will send a link to set a new password. The link lasts 30 minutes.",
        )}
      </p>
      <Flash lang={lang} params={sp} />
      {sent ? (
        <p className="small muted">
          {T(
            "Письма нет через 10 минут? Проверьте спам. Повторный запрос возможен, но не чаще трёх раз в час.",
            "No email after 10 minutes? Check spam. You can ask again, up to three times an hour.",
          )}
        </p>
      ) : null}
      <ActionForm action="auth.reset_request" lang={lang} back={back} className="card form-card">
        <Field label={d.auth.email}>
          <input name="email" type="email" required autoComplete="email" maxLength={254} defaultValue={user?.email ?? ""} />
        </Field>
        <button className="btn btn-primary">{T("Отправить ссылку", "Send the link")}</button>
      </ActionForm>
      <p className="small muted">
        {T("Нет доступа к почте?", "Lost access to your email?")}{" "}
        <Link href={`/${lang}/contact`} className="text-link">
          {d.auth.contactSupport}
        </Link>
      </p>
    </div>
  );
}
