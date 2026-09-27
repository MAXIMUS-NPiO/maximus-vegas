import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { ActionForm, DbDown, Field, Flash, one, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "signin", dict(lang).auth.signInTitle, undefined, { noindex: true });
}

export default async function SignIn({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const sp = await searchParams;
  const { user, dbError } = await viewer();
  const next = one(sp.next);
  if (user) redirect(/^\/(ru|en)\//.test(next) ? next : `/${lang}/hub`);
  return (
    <div className="container narrow page">
      <h1>{d.auth.signInTitle}</h1>
      <Flash lang={lang} params={sp} />
      {dbError ? <DbDown lang={lang} /> : null}
      <ActionForm action="auth.signin" lang={lang} back={`/${lang}/signin${next ? `?next=${encodeURIComponent(next)}` : ""}`} className="card form-card" hidden={next ? { next } : undefined}>
        <Field label={d.auth.login}>
          <input name="login" required autoComplete="username" maxLength={254} autoFocus />
        </Field>
        <Field label={d.auth.passwordPlain}>
          <input name="password" type="password" required autoComplete="current-password" maxLength={200} />
        </Field>
        <button className="btn btn-primary" type="submit">
          {d.auth.signIn}
        </button>
        <p className="muted small">
          <Link href={`/${lang}/forgot-password`} className="text-link">
            {d.auth.forgot}
          </Link>
        </p>
      </ActionForm>
      <p className="muted center">
        {d.auth.noAccount}{" "}
        <Link href={`/${lang}/signup`} className="text-link">
          {d.auth.signUp}
        </Link>
      </p>
    </div>
  );
}
