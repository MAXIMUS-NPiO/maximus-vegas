import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { clanText } from "@/lib/clan-text.ts";
import { viewer } from "@/server/viewer.ts";
import { clanOf, listClans, myClanInvites } from "@/server/clans.ts";
import { ActionForm, Badge, DbDown, Empty, Field, Flash, one, PageHead, SignInPrompt, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "clans", clanText[lang].title, clanText[lang].lead);
}

export default async function Clans({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const x = clanText[lang];
  const sp = await searchParams;
  const q = (one(sp.q) ?? "").slice(0, 40);
  const back = `/${lang}/clans`;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <PageHead title={x.title} lead={x.lead} />
        <DbDown lang={lang} />
      </div>
    );
  const [list, mine, invites] = await Promise.all([listClans(db, q), user ? clanOf(db, user.id) : Promise.resolve(null), user ? myClanInvites(db, user.id) : Promise.resolve([])]);
  return (
    <div className="container page">
      <PageHead title={x.title} lead={x.lead}>
        <Link href={`/${lang}/ladders`} className="btn btn-ghost btn-sm">
          {x.ladders}
        </Link>
      </PageHead>
      <Flash lang={lang} params={sp} />
      {mine ? (
        <p className="notice">
          {x.yourClan}:{" "}
          <Link href={`/${lang}/clans/${mine.slug}`}>
            [{mine.tag}] {mine.name}
          </Link>{" "}
          <Badge status={mine.role === "member" ? "muted" : "info"}>{x.roles[mine.role]}</Badge>
        </p>
      ) : null}
      {invites.length ? (
        <section className="section-tight" id="invites">
          <h2 className="h3">{x.invites}</h2>
          <ul className="list">
            {invites.map((i) => (
              <li key={i.id}>
                <span className="grow">
                  <Link href={`/${lang}/clans/${i.slug}`}>
                    [{i.tag}] {i.name}
                  </Link>{" "}
                  <span className="small muted">
                    {x.from} @{i.by} · <LocalTime iso={i.created_at} lang={lang} dateOnly />
                  </span>
                </span>
                <span className="row">
                  <ActionForm action="clan.respond" lang={lang} back={back} hidden={{ invite: i.id, accept: "1" }}>
                    <button className="btn btn-primary btn-xs">{x.accept}</button>
                  </ActionForm>
                  <ActionForm action="clan.respond" lang={lang} back={back} hidden={{ invite: i.id, accept: "0" }}>
                    <button className="btn btn-ghost btn-xs">{x.decline}</button>
                  </ActionForm>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <form method="get" action={`/${lang}/clans`} className="inline-form toolbar">
        <input name="q" defaultValue={q} placeholder={x.search} aria-label={x.search} maxLength={40} />
        <button className="btn btn-ghost btn-sm">{x.find}</button>
      </form>
      {list.length ? (
        <div className="grid grid-3">
          {list.map((c) => (
            <Link key={c.id} href={`/${lang}/clans/${c.slug}`} className="card card-link">
              <div className="row-between">
                <h3>{c.name}</h3>
                <span className="badge badge-muted">{c.tag}</span>
              </div>
              {c.description ? <p className="small muted clamp-2">{c.description}</p> : null}
              <p className="small">
                {x.members}: {c.members}
              </p>
            </Link>
          ))}
        </div>
      ) : (
        <Empty title={q ? x.noMatch : x.none} />
      )}
      {user && !mine ? (
        <section className="card form-card section-tight" id="create">
          <h2 className="h3">{x.create}</h2>
          <p className="small muted">{x.createLead}</p>
          <ActionForm action="clan.create" lang={lang} back={back} className="stack-sm">
            <div className="form-grid">
              <Field label={x.name}>
                <input name="name" required minLength={2} maxLength={40} />
              </Field>
              <Field label={x.tag}>
                <input name="tag" required minLength={2} maxLength={5} pattern="[A-Za-z0-9]{2,5}" autoCapitalize="characters" />
              </Field>
            </div>
            <Field label={x.description}>
              <textarea name="description" maxLength={500} rows={3} />
            </Field>
            <button className="btn btn-primary btn-sm">{x.create}</button>
          </ActionForm>
        </section>
      ) : null}
      {!user ? <SignInPrompt lang={lang} back={back} /> : null}
    </div>
  );
}
