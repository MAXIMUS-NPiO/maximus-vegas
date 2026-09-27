import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { ActionForm, Field, Flash, one, type SearchParams } from "@/components/ui";
import { cleanToken, TokenShell } from "@/components/token-page";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { ...pageMeta(lang, "reset-password", lang === "ru" ? "Новый пароль" : "New password", undefined, { noindex: true }), referrer: "no-referrer" };
}

export default async function ResetPassword({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  const sp = await searchParams;
  const token = cleanToken(one(sp.token));
  const used = one(sp.e) === "token_invalid";
  return (
    <TokenShell lang={lang} path="reset-password" token={used ? "" : token} title={T("Новый пароль", "Set a new password")}>
      <Flash lang={lang} params={sp} />
      {!used && token ? (
        <ActionForm action="auth.reset" lang={lang} back={`/${lang}/reset-password?token=${token}`} hidden={{ token }} className="card form-card">
          <Field label={T("Новый пароль", "New password")} hint={T("не менее 10 символов", "at least 10 characters")}>
            <input name="password" type="password" required minLength={10} maxLength={200} autoComplete="new-password" />
          </Field>
          <button className="btn btn-primary">{T("Сохранить пароль", "Save password")}</button>
          <p className="small muted">
            {T(
              "После смены пароля все остальные сессии будут завершены, а вы войдёте на портал в этом браузере.",
              "After the change every other session is signed out and you are signed in on this browser.",
            )}
          </p>
        </ActionForm>
      ) : (
        <div className="notice notice-warn">
          <p>
            {used
              ? T("Ссылка уже использована или устарела — она действует 30 минут.", "The link has been used or has expired — it lasts 30 minutes.")
              : T("Ссылка неполная или повреждена.", "The link is incomplete or damaged.")}
          </p>
          <Link href={`/${lang}/forgot-password`} className="btn btn-primary btn-sm">
            {T("Запросить новую ссылку", "Request a new link")}
          </Link>
        </div>
      )}
    </TokenShell>
  );
}
