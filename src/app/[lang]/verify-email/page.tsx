import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { ActionForm, Flash, one, type SearchParams } from "@/components/ui";
import { cleanToken, TokenShell } from "@/components/token-page";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { ...pageMeta(lang, "verify-email", lang === "ru" ? "Подтверждение email" : "Confirm email", undefined, { noindex: true }), referrer: "no-referrer" };
}

export default async function VerifyEmail({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  const sp = await searchParams;
  const token = cleanToken(one(sp.token));
  const used = one(sp.e) === "token_invalid";
  const { user } = await viewer();
  return (
    <TokenShell lang={lang} path="verify-email" token={used ? "" : token} title={T("Подтверждение email", "Confirm your email")}>
      <Flash lang={lang} params={sp} />
      {used ? null : token ? (
        <ActionForm action="auth.verify" lang={lang} back={`/${lang}/verify-email?token=${token}`} hidden={{ token }} className="card form-card">
          <p>
            {T(
              "Нажмите кнопку, чтобы подтвердить, что этот адрес принадлежит вам. Ссылка срабатывает один раз.",
              "Press the button to confirm this address belongs to you. The link works once.",
            )}
          </p>
          <button className="btn btn-primary">{T("Подтвердить email", "Confirm email")}</button>
          <p className="small muted">
            {T(
              "Подтверждение email доказывает доступ к почтовому ящику. Это не проверка личности.",
              "Confirming an email proves access to the mailbox. It is not an identity check.",
            )}
          </p>
        </ActionForm>
      ) : (
        <div className="notice notice-warn">
          <p>{T("Ссылка неполная или повреждена.", "The link is incomplete or damaged.")}</p>
        </div>
      )}
      <p className="small muted">
        {user ? (
          <>
            {T("Новое письмо можно запросить в", "You can request a new email in")}{" "}
            <Link href={`/${lang}/settings#email`} className="text-link">
              {T("настройках", "settings")}
            </Link>
            .
          </>
        ) : (
          <>
            {T("Чтобы запросить новое письмо,", "To request a new email,")}{" "}
            <Link href={`/${lang}/signin?next=/${lang}/settings`} className="text-link">
              {T("войдите", "sign in")}
            </Link>{" "}
            {T("и откройте настройки.", "and open settings.")}
          </>
        )}
      </p>
    </TokenShell>
  );
}
