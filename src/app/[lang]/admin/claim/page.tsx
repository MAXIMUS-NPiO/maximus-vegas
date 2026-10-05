import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { adminClaimMode, adminCount } from "@/server/auth.ts";
import { ActionForm, DbDown, Field, Flash, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "admin/claim", dict(lang).admin.claimTitle, undefined, { noindex: true });
}

export default async function Claim({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  const admins = await adminCount(db);
  // Signed out, while no administrator exists: the owner may recover the account without its password.
  if (!user && admins > 0) redirect(`/${lang}/signin?next=/${lang}/admin/claim`);
  if (!user)
    return (
      <div className="container narrow page">
        <h1>{d.admin.recoverTitle}</h1>
        <p className="lead">{d.admin.recoverText}</p>
        <Flash lang={lang} params={sp} />
        <ActionForm action="account.owner_recover" lang={lang} back={`/${lang}/admin/claim`} className="card form-card">
          <Field label={d.admin.recoverLogin}>
            <input name="login" required autoComplete="username" />
          </Field>
          <Field label={d.admin.claimToken}>
            <input name="token" type="password" required autoComplete="off" />
          </Field>
          <Field label={d.admin.recoverPassword}>
            <input name="password" type="password" required minLength={10} autoComplete="new-password" />
          </Field>
          <button className="btn btn-primary">{d.admin.recover}</button>
        </ActionForm>
        <p className="small muted">
          <Link href={`/${lang}/signin?next=/${lang}/admin/claim`} className="text-link">
            {d.admin.recoverSignin}
          </Link>
        </p>
      </div>
    );
  const enabled = adminClaimMode() === "env" || admins === 0;
  return (
    <div className="container narrow page">
      <h1>{d.admin.claimTitle}</h1>
      <p className="lead">{d.admin.claimText}</p>
      <Flash lang={lang} params={sp} />
      {enabled ? (
        <ActionForm action="account.claim_admin" lang={lang} back={`/${lang}/admin/claim`} className="card form-card">
          <Field label={d.admin.claimToken}>
            <input name="token" type="password" required autoComplete="off" />
          </Field>
          <button className="btn btn-primary">{d.admin.claim}</button>
        </ActionForm>
      ) : (
        <p className="notice notice-warn">{d.admin.claimDisabled}</p>
      )}
    </div>
  );
}
