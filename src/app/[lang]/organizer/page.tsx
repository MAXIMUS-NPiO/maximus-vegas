import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { orgsFor } from "@/server/queries.ts";
import { ActionForm, DbDown, Empty, Field, Flash, PageHead, SignInPrompt, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "organizer", dict(lang).organizer.title, dict(lang).organizer.lead);
}

export default async function Organizer({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  const back = `/${lang}/organizer`;
  const spaces = db && user ? await orgsFor(db, user) : [];
  return (
    <div className="container page">
      <PageHead title={d.organizer.title} lead={d.organizer.lead} />
      <Flash lang={lang} params={sp} />
      {dbError ? (
        <DbDown lang={lang} />
      ) : !user ? (
        <SignInPrompt lang={lang} back={back} />
      ) : (
        <div className="split">
          <section>
            <h2 className="h3">{d.organizer.spaces}</h2>
            {spaces.length ? (
              <ul className="list">
                {spaces.map((s) => (
                  <li key={s.id}>
                    <Link href={`/${lang}/organizer/${s.slug}`} className="grow">
                      {s.name}
                    </Link>
                    <span className="small muted">
                      {d.organizer.roles[s.role]} · {s.tournaments} {lang === "ru" ? "турн." : "events"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title={d.organizer.noSpaces} />
            )}
            <p className="small muted">{d.organizer.staffNote}</p>
          </section>
          <section>
            <h2 className="h3">{d.organizer.create}</h2>
            <ActionForm action="org.create" lang={lang} back={back} className="card form-card">
              <Field label={d.organizer.name}>
                <input name="name" required minLength={2} maxLength={60} />
              </Field>
              <Field label={d.organizer.description} hint={d.common.optional}>
                <textarea name="description" rows={3} maxLength={600} />
              </Field>
              <button className="btn btn-primary">{d.organizer.create}</button>
            </ActionForm>
          </section>
        </div>
      )}
    </div>
  );
}
