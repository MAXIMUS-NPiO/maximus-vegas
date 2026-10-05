import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { publicGames } from "@/server/catalog.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { ActionForm, DbDown, Field, Flash, one, SignInPrompt, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "teams/new", dict(lang).teams.createTitle, undefined, { noindex: true });
}

export default async function NewTeam({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  const games=await publicGames(db);
  const preset=games.some(g=>g.slug===one(sp.game))?one(sp.game):games[0]?.slug;
  const back = `/${lang}/teams/new`;
  return (
    <div className="container narrow page">
      <h1>{d.teams.createTitle}</h1>
      <Flash lang={lang} params={sp} />
      {dbError ? (
        <DbDown lang={lang} />
      ) : !user ? (
        <SignInPrompt lang={lang} back={back} />
      ) : (
        <ActionForm action="team.create" lang={lang} back={back} className="card form-card">
          <Field label={d.teams.name}>
            <input name="name" required minLength={2} maxLength={48} />
          </Field>
          <Field label={d.teams.tag} hint={d.common.optional}>
            <input name="tag" maxLength={6} pattern="[A-Za-z0-9]{0,6}" />
          </Field>
          <Field label={d.teams.game}>
            <select name="game" defaultValue={preset} required>
              {games.map((g) => (
                <option key={g.slug} value={g.slug}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn btn-primary">{d.teams.create}</button>
        </ActionForm>
      )}
    </div>
  );
}
