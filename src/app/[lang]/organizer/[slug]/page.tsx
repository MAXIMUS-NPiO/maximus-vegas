import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { orgBySlug } from "@/server/queries.ts";
import { canManageOrg, orgRole } from "@/server/access.ts";
import { ActionForm, Badge, DbDown, Empty, Flash, type SearchParams } from "@/components/ui";
import { TournamentForm } from "@/components/tournament-form";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, `organizer/${slug}`, dict(lang).organizer.title, undefined, { noindex: true });
}

export default async function OrgPage({ params, searchParams }: { params: Promise<{ lang: string; slug: string }>; searchParams: SearchParams }) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const o = d.organizer;
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user) redirect(`/${lang}/signin?next=/${lang}/organizer/${slug}`);
  const data = await orgBySlug(db, slug);
  if (!data) notFound();
  const role = await orgRole(db, data.org.id, user.id);
  const manager = await canManageOrg(db, data.org.id, user);
  if (!role && !user.roles.includes("admin")) notFound();
  const owner = role === "owner" || user.roles.includes("admin");
  const back = `/${lang}/organizer/${slug}`;
  return (
    <div className="container page">
      <p className="eyebrow">
        <Link href={`/${lang}/organizer`}>{o.title}</Link>
      </p>
      <h1>{data.org.name}</h1>
      {data.org.description ? <p className="lead prewrap">{data.org.description}</p> : null}
      <Flash lang={lang} params={sp} />

      <section className="section-tight">
        <h2 className="h3">{o.tournaments}</h2>
        {data.tournaments.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{o.tName}</th>
                  <th>{o.game}</th>
                  <th>{o.status}</th>
                  <th>{d.tournaments.starts}</th>
                  <th>{d.tournaments.participants}</th>
                </tr>
              </thead>
              <tbody>
                {data.tournaments.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/${lang}/organizer/t/${t.slug}`}>{t.name}</Link>
                    </td>
                    <td>{gameBySlug(t.game)?.name ?? t.game}</td>
                    <td>
                      <Badge status={t.status}>{d.statuses.tournament[t.status]}</Badge>
                    </td>
                    <td className="small">
                      <LocalTime iso={t.starts_at} lang={lang} />
                    </td>
                    <td>{t.registered}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={d.common.emptyTitle} />
        )}
      </section>

      <div className="split">
        {manager ? (
          <section>
            <h2 className="h3">{o.newTournament}</h2>
            <TournamentForm lang={lang} back={back} orgId={data.org.id} />
          </section>
        ) : null}
        <section>
          <h2 className="h3">{o.members}</h2>
          <ul className="list">
            {data.members.map((m) => (
              <li key={m.id}>
                <span className="grow">
                  <Link href={`/${lang}/players/${m.username}`}>{m.display_name}</Link> <span className="small muted">@{m.username}</span>
                </span>
                <span className="small">{o.roles[m.role]}</span>
                {owner && m.id !== user.id ? (
                  <ActionForm action="org.remove" lang={lang} back={back} hidden={{ org: data.org.id, member: m.id }}>
                    <button className="btn btn-ghost btn-xs">{o.remove}</button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
          {manager ? (
            <ActionForm action="org.member" lang={lang} back={back} hidden={{ org: data.org.id }} className="inline-form">
              <input name="username" required pattern="[A-Za-z0-9_]{3,24}" placeholder={d.teams.inviteUsername} aria-label={d.teams.inviteUsername} autoCapitalize="none" />
              <select name="role" defaultValue="referee" aria-label={o.members}>
                <option value="referee">{o.roles.referee}</option>
                <option value="admin">{o.roles.admin}</option>
                {owner ? <option value="owner">{o.roles.owner}</option> : null}
              </select>
              <button className="btn btn-ghost btn-sm">{o.addMember}</button>
            </ActionForm>
          ) : null}
          <p className="small muted">{o.staffNote}</p>
        </section>
      </div>
    </div>
  );
}
