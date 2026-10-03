import { reservationByToken } from "@/server/username-reservations.ts";
import Link from "next/link";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { emailFirstMode } from "@/server/accounts.ts";
import { DRAFT_COOKIE, readDraft } from "@/server/http.ts";
import { ActionForm, Check, DbDown, Field, Flash, one, type SearchParams } from "@/components/ui";
import { DraftKeeper } from "@/components/draft-keeper";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "signup", dict(lang).auth.signUpTitle, dict(lang).auth.signUpLead, { noindex: true });
}

/** Which field an error code belongs to, so it is shown next to that field instead of only at the top. */
const FIELD_OF: Record<string, "email" | "username" | "displayName" | "password" | "adult" | "terms"> = {
  invalid_email: "email",
  signup_unavailable: "email",
  email_taken: "email",
  invalid_username: "username",
  username_taken: "username",
  invalid_name: "displayName",
  weak_password: "password",
  adult_required: "adult",
  consent_required: "terms",
};

export default async function SignUp({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  const sp = await searchParams;
  const { user, db, dbError } = await viewer();
  if (user) redirect(`/${lang}/hub`);
  const reservationToken = one(sp.reservation);
  const reservation = db && reservationToken ? await reservationByToken(db, reservationToken) : null;
  const draft = readDraft((await cookies()).get(DRAFT_COOKIE)?.value);
  const code = one(sp.e);
  const field = FIELD_OF[code];
  const err = (name: string) => (field === name ? (d.errors[code] ?? d.errors.invalid_input) : undefined);
  const aria = (name: string) => (field === name ? { "aria-invalid": true, "aria-describedby": `err-${name}` } : {});
  const emailFirst = emailFirstMode();
  return (
    <div className="container narrow page">
      <h1>{d.auth.signUpTitle}</h1>
      <p className="lead">{d.auth.signUpLead}</p>
      {field ? (
        <div className="flash flash-err" role="alert">
          {T("Проверьте отмеченное поле.", "Check the highlighted field.")}
        </div>
      ) : (
        <Flash lang={lang} params={sp} />
      )}
      {dbError ? <DbDown lang={lang} /> : null}
      {reservation ? <div className="notice">{T("Для вас зарезервировано имя", "Your reserved username is")} <strong>@{reservation.username}</strong>. {T("После регистрации вы сможете принять приглашение в команду", "After registration you can accept the invitation to team")} <strong>{reservation.name}</strong>.</div> : reservationToken ? <p role="alert">{T("Резерв истёк или отменён. Попросите новую ссылку или выберите другое имя.", "This reservation expired or was cancelled. Ask for a new link or choose another username.")}</p> : null}
      <ActionForm action="auth.signup" lang={lang} hidden={reservation ? {reservation:reservation.id} : undefined} back={`/${lang}/signup${reservation ? "?reservation="+reservation.id : ""}`} className="card form-card" pending={T("Создаём профиль…", "Creating your profile…")}>
        <Field label={d.auth.email} error={err("email")} errorId="err-email">
          <input name="email" type="email" required autoComplete="email" maxLength={254} defaultValue={draft.email} autoFocus={field === "email"} {...aria("email")} />
        </Field>
        <Field label={d.auth.username} error={err("username")} errorId="err-username">
          <input
            name="username"
            required
            pattern="[A-Za-z0-9_]{3,24}"
            minLength={3}
            maxLength={24}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            defaultValue={reservation?.username ?? draft.username}
            readOnly={Boolean(reservation)}
            autoFocus={field === "username"}
            {...aria("username")}
          />
        </Field>
        <Field label={d.auth.displayName} error={err("displayName")} errorId="err-displayName">
          <input name="displayName" required minLength={2} maxLength={60} autoComplete="nickname" defaultValue={draft.displayName} {...aria("displayName")} />
        </Field>
        <Field label={d.auth.password} error={err("password")} errorId="err-password">
          <input name="password" type="password" required minLength={10} maxLength={200} autoComplete="new-password" autoFocus={field === "password"} {...aria("password")} />
        </Field>
        <Check name="adult" required label={d.auth.adult} error={err("adult")} />
        <p className="muted small">{d.auth.adultNote}</p>
        <Check
          name="terms"
          required
          error={err("terms")}
          label={
            <>
              {d.auth.terms} (<Link href={`/${lang}/terms`}>{ru ? "условия" : "terms"}</Link>, <Link href={`/${lang}/privacy`}>{ru ? "конфиденциальность" : "privacy"}</Link>)
            </>
          }
        />
        <Check
          name="marketing"
          value="1"
          defaultChecked={draft.marketing === "1"}
          label={T(
            "Присылать новости портала и анонсы турниров на email (необязательно, можно отключить в настройках)",
            "Email me portal news and tournament announcements (optional; you can turn this off in settings)",
          )}
        />
        {emailFirst ? (
          <p className="small muted">
            {T(
              "Мы пришлём письмо со ссылкой для активации. Аккаунт заработает после подтверждения email.",
              "We will email you an activation link. The account works once the email is confirmed.",
            )}
          </p>
        ) : null}
        <button className="btn btn-primary" type="submit">
          {d.auth.signUp}
        </button>
        <DraftKeeper formKey="signup" fields={reservation ? ["email", "displayName", "marketing"] : ["email", "username", "displayName", "marketing"]} />
      </ActionForm>
      <p className="muted center">
        {d.auth.haveAccount}{" "}
        <Link href={`/${lang}/signin`} className="text-link">
          {d.auth.signIn}
        </Link>
      </p>
    </div>
  );
}
