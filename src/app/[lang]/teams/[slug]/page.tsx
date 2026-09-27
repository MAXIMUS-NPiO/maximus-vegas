import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { teamBySlug } from "@/server/queries.ts";
import { ActionForm, Badge, DbDown, Flash, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  const { db } = await viewer();
  const data = db ? await teamBySlug(db, slug).catch(() => null) : null;
  return pageMeta(lang, `teams/${slug}`, data?.team.name ?? dict(lang).teams.title);
}

export default async function TeamPage({ params, searchParams }: { params: Promise<{ lang: string; slug: string }>; searchParams: SearchParams }) {
  const { lang, slug } = await params;
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
  const data = await teamBySlug(db, slug);
  if (!data) notFound();
  const { team, members, invites, tournaments } = data;
  const isOwner = user?.id === team.owner_id;
  const isLeader = isOwner || user?.id === team.captain_id;
  const isMember = Boolean(user && members.some((m) => m.id === user.id));
  const back = `/${lang}/teams/${team.slug}`;
  const hidden = { team: team.id };
  return (
    <div className="container page">
      <p className="eyebrow">
        <Link href={`/${lang}/games/${team.game}`}>{gameBySlug(team.game)?.name ?? team.game}</Link>
      </p>
      <h1>
        {team.name} {team.tag ? <span className="badge badge-muted">{team.tag}</span> : null}
      </h1>
      <Flash lang={lang} params={sp} />
      <div className="grid grid-2">
        <section>
          <h2 className="h3">
            {d.teams.members} ({members.length})
          </h2>
          <ul className="list">
            {members.map((m) => (
              <li key={m.id} className="member-row">
                <span className="grow">
                  <Link href={`/${lang}/players/${m.username}`}>{m.display_name}</Link>{" "}
                  <span className="small muted">@{m.username}</span>
                </span>
                <span className="small">
                  {m.id === team.owner_id ? (
                    <Badge status="works">{d.teams.owner}</Badge>
                  ) : m.id === team.captain_id ? (
                    <Badge status="connect">{d.teams.captain}</Badge>
                  ) : (
                    <span className="muted">{d.teams.player}</span>
                  )}
                </span>
                {isOwner && m.id !== team.owner_id ? (
                  <span className="row">
                    {m.id !== team.captain_id ? (
                      <ActionForm action="team.role" lang={lang} back={back} hidden={{ ...hidden, member: m.id, role: "captain" }}>
                        <button className="btn btn-ghost btn-xs">{d.teams.makeCaptain}</button>
                      </ActionForm>
                    ) : null}
                    <ActionForm action="team.role" lang={lang} back={back} hidden={{ ...hidden, member: m.id, role: "owner" }}>
                      <button className="btn btn-ghost btn-xs">{d.teams.makeOwner}</button>
                    </ActionForm>
                  </span>
                ) : null}
                {isLeader && m.id !== team.owner_id && m.id !== user?.id && (isOwner || m.id !== team.captain_id) ? (
                  <ActionForm action="team.remove" lang={lang} back={back} hidden={{ ...hidden, member: m.id }}>
                    <button className="btn btn-ghost btn-xs">{d.teams.remove}</button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
          {isMember && !isOwner ? (
            <ActionForm action="team.leave" lang={lang} back={back} hidden={hidden}>
              <button className="btn btn-ghost btn-sm">{d.teams.leave}</button>
            </ActionForm>
          ) : null}
        </section>
        <section>
          {isLeader ? (
            <>
              <h2 className="h3">{d.teams.invite}</h2>
              <ActionForm action="team.invite" lang={lang} back={back} hidden={hidden} className="inline-form">
                <input name="username" required pattern="[A-Za-z0-9_]{3,24}" placeholder={d.teams.inviteUsername} aria-label={d.teams.inviteUsername} autoCapitalize="none" />
                <button className="btn btn-primary btn-sm">{d.common.send}</button>
              </ActionForm>
              {invites.length ? (
                <>
                  <h3 className="h4">{d.teams.pendingInvites}</h3>
                  <ul className="list">
                    {invites.map((i) => (
                      <li key={i.id}>
                        <span>@{i.username}</span>
                        <ActionForm action="team.revoke" lang={lang} back={back} hidden={{ invite: i.id }}>
                          <button className="btn btn-ghost btn-xs">{d.teams.revoke}</button>
                        </ActionForm>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          ) : null}
          <h2 className="h3">{d.teams.tournaments}</h2>
          {tournaments.length ? (
            <ul className="list">
              {tournaments.map((t) => (
                <li key={t.slug}>
                  <Link href={`/${lang}/tournaments/${t.slug}`}>{t.name}</Link>
                  <span className="small">
                    {t.placement ? (
                      <strong>
                        {d.tournaments.place} {t.placement}
                      </strong>
                    ) : (
                      <Badge status={t.status}>{d.statuses.tournament[t.status]}</Badge>
                    )}{" "}
                    <span className="muted">
                      <LocalTime iso={t.starts_at} lang={lang} dateOnly />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{d.players.noTournaments}</p>
          )}
        </section>
      </div>
      {!user ? (
        <p className="small muted">
          <Link href={`/${lang}/signin?next=${encodeURIComponent(back)}`} className="text-link">
            {d.nav.signIn}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
