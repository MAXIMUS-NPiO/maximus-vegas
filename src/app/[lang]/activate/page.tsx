import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { ActionForm, Flash, one, type SearchParams } from "@/components/ui";
import { cleanToken, TokenShell } from "@/components/token-page";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { ...pageMeta(lang, "activate", lang === "ru" ? "Активация аккаунта" : "Activate account", undefined, { noindex: true }), referrer: "strict-origin" };
}

export default async function Activate({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  const sp = await searchParams;
  const token = cleanToken(one(sp.token));
  const used = one(sp.e) === "token_invalid";
  return (
    <TokenShell lang={lang} path="activate" token={used ? "" : token} title={T("Активация аккаунта", "Activate your account")}>
      <Flash lang={lang} params={sp} />
      {!used && token ? (
        <ActionForm action="auth.activate" lang={lang} back={`/${lang}/activate?token=${token}`} hidden={{ token }} className="card form-card">
          <p>
            {T(
              "Нажмите кнопку, чтобы подтвердить email и активировать аккаунт. После этого вы сразу войдёте на портал.",
              "Press the button to confirm your email and activate the account. You will be signed in straight away.",
            )}
          </p>
          <button className="btn btn-primary">{T("Активировать аккаунт", "Activate account")}</button>
        </ActionForm>
      ) : (
        <div className="notice notice-warn">
          <p>
            {used
              ? T(
                  "Ссылка уже использована или устарела (она действует 24 часа). Если аккаунт уже активирован — просто войдите. Иначе зарегистрируйтесь ещё раз с тем же email: мы пришлём новую ссылку.",
                  "The link has been used or has expired (it lasts 24 hours). If the account is already active, just sign in. Otherwise sign up again with the same email and we will send a new link.",
                )
              : T("Ссылка неполная или повреждена.", "The link is incomplete or damaged.")}
          </p>
          <div className="row">
            <Link href={`/${lang}/signin`} className="btn btn-primary btn-sm">
              {T("Войти", "Sign in")}
            </Link>
            <Link href={`/${lang}/signup`} className="btn btn-ghost btn-sm">
              {T("Регистрация", "Sign up")}
            </Link>
          </div>
        </div>
      )}
    </TokenShell>
  );
}
