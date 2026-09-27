import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "signup/check-email", lang === "ru" ? "Проверьте почту" : "Check your email", undefined, { noindex: true });
}

/**
 * Shown after an email-first sign-up. The text is the same whether or not the address already had an
 * account, so the page never reveals who is registered.
 */
export default async function CheckEmail({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  return (
    <div className="container narrow page">
      <h1>{T("Проверьте почту", "Check your email")}</h1>
      <p className="lead">
        {T(
          "Если адрес можно использовать для регистрации, на него придёт письмо со ссылкой для активации аккаунта. Ссылка действует 24 часа.",
          "If the address can be used to sign up, it will receive an email with a link to activate the account. The link lasts 24 hours.",
        )}
      </p>
      <div className="card stack-sm">
        <h2 className="h4">{T("Письма нет?", "No email?")}</h2>
        <ul className="bullets">
          <li>{T("Проверьте папки «Спам» и «Промоакции».", "Check your spam and promotions folders.")}</li>
          <li>
            {T(
              "Через 10 минут отправьте форму регистрации ещё раз с тем же email — мы пришлём новую ссылку.",
              "After 10 minutes, submit the sign-up form again with the same email and we will send a new link.",
            )}
          </li>
          <li>
            {T("Если аккаунт у вас уже есть, письмо подскажет, как восстановить доступ.", "If you already have an account, the email explains how to recover access.")}
          </li>
        </ul>
      </div>
      <div className="row section-tight">
        <Link href={`/${lang}/signin`} className="btn btn-primary btn-sm">
          {T("Войти", "Sign in")}
        </Link>
        <Link href={`/${lang}/signup`} className="btn btn-ghost btn-sm">
          {T("Вернуться к регистрации", "Back to sign-up")}
        </Link>
      </div>
    </div>
  );
}
