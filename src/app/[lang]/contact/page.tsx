import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { contactEmail } from "@/lib/site.ts";
import { viewer } from "@/server/viewer.ts";
import { Flash, PageHead, type SearchParams } from "@/components/ui";
import { ApplicationForm } from "@/components/application-form";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "contact", dict(lang).contact.title, dict(lang).contact.lead);
}

export default async function Contact({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const sp = await searchParams;
  const { user } = await viewer();
  const email = contactEmail();
  return (
    <div className="container page">
      <PageHead title={d.contact.title} lead={d.contact.lead} />
      <Flash lang={lang} params={sp} />
      <div className="split">
        <dl className="kv">
          <div>
            <dt>{d.contact.company}</dt>
            <dd>MAXIMUS VEGAS L.L.C-FZ · Meydan Free Zone · Dubai, UAE</dd>
          </div>
          <div>
            <dt>{d.contact.email}</dt>
            <dd>
              <a href={`mailto:${email}`} className="text-link">
                {email}
              </a>
            </dd>
          </div>
        </dl>
        <ApplicationForm lang={lang} back={`/${lang}/contact`} kinds={["contact", "support", "partner", "media", "investor"]} user={user} />
      </div>
    </div>
  );
}
