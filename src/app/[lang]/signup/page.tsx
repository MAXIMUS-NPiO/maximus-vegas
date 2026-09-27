import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { ActionForm, Check, DbDown, Field, Flash, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "signup", dict(lang).auth.signUpTitle, dict(lang).auth.signUpLead);
}

export default async function SignUp({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const sp = await searchParams;
  const { user, dbError } = await viewer();
  if (user) redirect(`/${lang}/hub`);
  return (
    <div className="container narrow page">
      <h1>{d.auth.signUpTitle}</h1>
      <p className="lead">{d.auth.signUpLead}</p>
      <Flash lang={lang} params={sp} />
      {dbError ? <DbDown lang={lang} /> : null}
      <ActionForm action="auth.signup" lang={lang} back={`/${lang}/signup`} className="card form-card">
        <Field label={d.auth.email}>
          <input name="email" type="email" required autoComplete="email" maxLength={254} />
        </Field>
        <Field label={d.auth.username}>
          <input name="username" required pattern="[A-Za-z0-9_]{3,24}" minLength={3} maxLength={24} autoComplete="username" autoCapitalize="none" spellCheck={false} />
        </Field>
        <Field label={d.auth.displayName}>
          <input name="displayName" required minLength={2} maxLength={60} autoComplete="nickname" />
        </Field>
        <Field label={d.auth.password}>
          <input name="password" type="password" required minLength={10} maxLength={200} autoComplete="new-password" />
        </Field>
        <Check name="adult" required label={d.auth.adult} />
        <p className="muted small">{d.auth.adultNote}</p>
        <Check
          name="terms"
          required
          label={
            <>
              {d.auth.terms} (<Link href={`/${lang}/terms`}>{lang === "ru" ? "условия" : "terms"}</Link>,{" "}
              <Link href={`/${lang}/privacy`}>{lang === "ru" ? "конфиденциальность" : "privacy"}</Link>)
            </>
          }
        />
        <button className="btn btn-primary" type="submit">
          {d.auth.signUp}
        </button>
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
