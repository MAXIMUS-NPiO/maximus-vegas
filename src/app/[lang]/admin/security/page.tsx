import Link from "next/link";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { isStaff } from "@/server/access.ts";
import { MFA_SESSION_HOURS, mfaStatus, otpauthUri, pendingSecret, qrSvg, secretEncryption } from "@/server/mfa.ts";
import { ActionForm, Badge, DbDown, Field, Flash, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return { ...pageMeta(lang, "admin/security", lang === "ru" ? "Второй фактор входа" : "Second sign-in factor", undefined, { noindex: true }), referrer: "no-referrer" };
}

/** Recovery codes are handed over once, in a short-lived HttpOnly cookie scoped to this page. */
function readCodes(raw: string | undefined): string[] {
  if (!raw || raw.length > 400) return [];
  try {
    const codes = Buffer.from(raw, "base64url").toString("utf8").split(",");
    return codes.every((c) => /^[A-Z2-7]{5}-[A-Z2-7]{5}$/.test(c)) ? codes : [];
  } catch {
    return [];
  }
}

export default async function Security({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
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
  if (!user) redirect(`/${lang}/signin?next=/${lang}/admin/security`);
  const back = `/${lang}/admin/security`;
  if (!isStaff(user))
    return (
      <div className="container narrow page">
        <h1>{T("Второй фактор входа", "Second sign-in factor")}</h1>
        <p className="notice notice-warn">{T("Раздел доступен только сотрудникам платформы.", "This section is for platform staff only.")}</p>
      </div>
    );
  const status = await mfaStatus(db, user.id);
  const codes = status.enrolled ? readCodes((await cookies()).get("mv_codes")?.value) : [];
  const secret = status.pending ? await pendingSecret(db, user.id) : null;
  const uri = secret ? otpauthUri(user.username, secret) : null;
  const svg = uri ? await qrSvg(uri) : null;
  const verified = Boolean(user.mfaAt && Date.now() - user.mfaAt.getTime() < MFA_SESSION_HOURS * 3600_000);

  return (
    <div className="container narrow page">
      <p className="eyebrow">
        <Link href={`/${lang}/admin`}>{T("Администрирование", "Administration")}</Link>
      </p>
      <h1>{T("Второй фактор входа", "Second sign-in factor")}</h1>
      <p className="lead">
        {T(
          "Сотрудникам платформы вход в центр управления разрешён только с кодом из приложения-аутентификатора (Google Authenticator, 1Password, Microsoft Authenticator и подобные).",
          "Platform staff enter the control centre only with a code from an authenticator app (Google Authenticator, 1Password, Microsoft Authenticator and similar).",
        )}
      </p>
      <Flash lang={lang} params={sp} />

      {codes.length ? (
        <section className="card stack-sm">
          <h2 className="h4">{T("Резервные коды — показываются один раз", "Recovery codes — shown once")}</h2>
          <p className="small">
            {T(
              "Сохраните их в менеджере паролей. Каждый код срабатывает один раз вместо кода из приложения, если телефон недоступен.",
              "Store them in a password manager. Each code works once instead of an app code if your phone is unavailable.",
            )}
          </p>
          <ol className="codes mono">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
          <ActionForm action="mfa.codes_saved" lang={lang} back={back}>
            <button className="btn btn-primary">{T("Я сохранил коды", "I have saved the codes")}</button>
          </ActionForm>
        </section>
      ) : status.enrolled ? (
        <section className="card stack-sm">
          <div className="row-between">
            <h2 className="h4">{T("Второй фактор подключён", "Second factor enabled")}</h2>
            <Badge status="ok">TOTP</Badge>
          </div>
          <p className="small muted">
            {T("Осталось резервных кодов", "Recovery codes left")}: {status.recoveryLeft}.{" "}
            {T("Потеряли доступ — попросите другого администратора сбросить фактор.", "Lost access? Ask another administrator to reset your factor.")}
          </p>
          {verified ? (
            <Link href={`/${lang}/admin`} className="btn btn-primary btn-sm">
              {T("В центр управления", "To the control centre")}
            </Link>
          ) : (
            <Link href={`/${lang}/admin/mfa?next=${encodeURIComponent(`/${lang}/admin`)}`} className="btn btn-primary btn-sm">
              {T("Подтвердить вход кодом", "Confirm sign-in with a code")}
            </Link>
          )}
        </section>
      ) : secret && svg ? (
        <section className="card stack">
          <h2 className="h4">{T("Шаг 2. Отсканируйте код и введите 6 цифр", "Step 2. Scan the code and enter the 6 digits")}</h2>
          <div className="qr" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
          <p className="small">
            {T("Не сканируется? Введите ключ вручную", "Cannot scan? Enter the key manually")}:{" "}
            <code className="mono secret">{secret.replace(/(.{4})/g, "$1 ").trim()}</code>
          </p>
          <ActionForm action="mfa.confirm" lang={lang} back={back} className="inline-form">
            <Field label={T("Код из приложения", "Code from the app")}>
              <input name="code" required inputMode="numeric" pattern="[0-9 ]{6,7}" maxLength={7} autoComplete="one-time-code" />
            </Field>
            <button className="btn btn-primary">{T("Подключить", "Enable")}</button>
          </ActionForm>
          <ActionForm action="mfa.start" lang={lang} back={back}>
            <button className="btn btn-ghost btn-xs">{T("Сгенерировать новый ключ", "Generate a new key")}</button>
          </ActionForm>
        </section>
      ) : (
        <section className="card stack-sm">
          <h2 className="h4">{T("Шаг 1. Подключите приложение-аутентификатор", "Step 1. Connect an authenticator app")}</h2>
          <p className="small muted">
            {T(
              "Портал создаст секретный ключ и покажет QR-код. После подтверждения первым кодом вы получите 10 резервных кодов.",
              "The portal creates a secret key and shows a QR code. After you confirm with a first code you receive 10 recovery codes.",
            )}
          </p>
          <ActionForm action="mfa.start" lang={lang} back={back}>
            <button className="btn btn-primary">{T("Начать", "Start")}</button>
          </ActionForm>
        </section>
      )}
      <p className="small muted">
        {T("Хранение ключа", "Key storage")}: {secretEncryption() === "aes-256-gcm" ? "AES-256-GCM" : T("без шифрования (MFA_SECRET_KEY не задан)", "unencrypted (MFA_SECRET_KEY not set)")}
      </p>
    </div>
  );
}
