import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { GAMES, gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { sessionsFor } from "@/server/queries.ts";
import { ActionForm, Check, DbDown, Field, Flash, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "settings", dict(lang).settings.title, undefined, { noindex: true });
}

export default async function Settings({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
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
  if (!user) redirect(`/${lang}/signin?next=/${lang}/settings`);
  const [profile] = await db.query<{ display_name: string; country: string; bio: string; profile_public: boolean }>(
    "select display_name, country, bio, profile_public from users where id = $1",
    [user.id],
  );
  const accounts = await db.query<{ game: string; handle: string }>("select game, handle from linked_game_accounts where user_id = $1 order by game", [user.id]);
  const sessions = await sessionsFor(db, user.id);
  const back = `/${lang}/settings`;
  return (
    <div className="container narrow page">
      <h1>{d.settings.title}</h1>
      <Flash lang={lang} params={sp} />

      <section className="section-tight">
        <h2 className="h3">{d.settings.profile}</h2>
        <ActionForm action="account.profile" lang={lang} back={back} className="card form-card">
          <Field label={d.settings.displayName}>
            <input name="displayName" required minLength={2} maxLength={60} defaultValue={profile.display_name} />
          </Field>
          <Field label={d.settings.country} hint={d.common.optional}>
            <input name="country" maxLength={60} defaultValue={profile.country} />
          </Field>
          <Field label={d.settings.bio} hint={d.common.optional}>
            <textarea name="bio" rows={3} maxLength={600} defaultValue={profile.bio} />
          </Field>
          <Check name="profilePublic" label={d.settings.public} defaultChecked={profile.profile_public} />
          <button className="btn btn-primary">{d.common.save}</button>
        </ActionForm>
      </section>

      <section className="section-tight">
        <h2 className="h3">{d.settings.games}</h2>
        <p className="small muted">{d.settings.gamesNote}</p>
        {accounts.length ? (
          <ul className="list">
            {accounts.map((a) => (
              <li key={a.game}>
                <span className="grow">{gameBySlug(a.game)?.name ?? a.game}</span>
                <span className="mono">{a.handle}</span>
                <ActionForm action="account.game" lang={lang} back={back} hidden={{ game: a.game, handle: "" }}>
                  <button className="btn btn-ghost btn-xs">{d.organizer.remove}</button>
                </ActionForm>
              </li>
            ))}
          </ul>
        ) : null}
        <ActionForm action="account.game" lang={lang} back={back} className="inline-form">
          <select name="game" aria-label={d.teams.game}>
            {GAMES.map((g) => (
              <option key={g.slug} value={g.slug}>
                {g.name}
              </option>
            ))}
          </select>
          <input name="handle" required maxLength={60} placeholder={d.settings.handle} aria-label={d.settings.handle} />
          <button className="btn btn-ghost btn-sm">{d.common.save}</button>
        </ActionForm>
      </section>

      <section className="section-tight">
        <h2 className="h3">{d.settings.security}</h2>
        <ActionForm action="account.password" lang={lang} back={back} className="card form-card">
          <Field label={d.settings.currentPassword}>
            <input name="current" type="password" required autoComplete="current-password" />
          </Field>
          <Field label={d.settings.newPassword} hint={d.auth.password}>
            <input name="password" type="password" required minLength={10} autoComplete="new-password" />
          </Field>
          <button className="btn btn-primary">{d.settings.changePassword}</button>
        </ActionForm>
        <h3 className="h4">{d.settings.sessions}</h3>
        <ul className="list">
          {sessions.map((s) => (
            <li key={s.id}>
              <span className="grow small">
                {s.user_agent.slice(0, 80) || "—"}
                {s.id === user.sessionId ? <strong> · {d.settings.thisSession}</strong> : null}
              </span>
              <span className="small muted">
                {d.settings.lastSeen}: <LocalTime iso={s.last_seen_at} lang={lang} withZone={false} />
              </span>
              {s.id !== user.sessionId ? (
                <ActionForm action="account.session" lang={lang} back={back} hidden={{ session: s.id }}>
                  <button className="btn btn-ghost btn-xs">{d.settings.revoke}</button>
                </ActionForm>
              ) : null}
            </li>
          ))}
        </ul>
        {sessions.length > 1 ? (
          <ActionForm action="account.session" lang={lang} back={back} hidden={{ session: "others" }}>
            <button className="btn btn-ghost btn-sm">{d.settings.revokeOthers}</button>
          </ActionForm>
        ) : null}
      </section>

      <section className="section-tight" id="privacy">
        <h2 className="h3">{d.settings.privacy}</h2>
        <p>
          <a href="/api/account/export" className="btn btn-ghost btn-sm">
            {d.settings.export}
          </a>
        </p>
        <details className="disclosure danger-zone">
          <summary>{d.settings.delete}</summary>
          <p className="small muted">{d.settings.deleteNote}</p>
          <ActionForm action="account.delete" lang={lang} back={back} className="inline-form">
            <input name="password" type="password" required placeholder={d.settings.deleteConfirm} aria-label={d.settings.deleteConfirm} autoComplete="current-password" />
            <button className="btn btn-danger btn-sm">{d.settings.delete}</button>
          </ActionForm>
        </details>
      </section>
    </div>
  );
}
