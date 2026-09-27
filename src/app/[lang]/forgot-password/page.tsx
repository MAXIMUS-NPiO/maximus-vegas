import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { ApplicationForm } from "@/components/application-form";
import { Flash, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "forgot-password", dict(lang).auth.forgotTitle, undefined, { noindex: true });
}

export default async function Forgot({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const sp = await searchParams;
  const { user } = await viewer();
  return (
    <div className="container narrow page">
      <h1>{d.auth.forgotTitle}</h1>
      <p className="lead">{d.auth.forgotText}</p>
      <Flash lang={lang} params={sp} />
      <ApplicationForm lang={lang} back={`/${lang}/forgot-password`} kinds={["support"]} user={user} title={d.auth.contactSupport} />
    </div>
  );
}
