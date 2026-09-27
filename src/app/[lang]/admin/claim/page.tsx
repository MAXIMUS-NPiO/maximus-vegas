import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { adminClaimMode } from "@/server/auth.ts";
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
  if (!user) redirect(`/${lang}/signin?next=/${lang}/admin/claim`);
  const [admins] = await db.query<{ n: number }>("select count(*)::int as n from user_roles where role = 'admin'");
  const enabled = adminClaimMode() === "env" || (admins?.n ?? 0) === 0;
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
