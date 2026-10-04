import { clanRelationships } from "@/server/clan-relationships.ts";
import { MemberAvatar } from "@/components/member-avatar";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { clanText } from "@/lib/clan-text.ts";
import { viewer } from "@/server/viewer.ts";
import { clanBySlug, clanOf, clanPendingInvites, clanRecord, clanSeason, clanWars, settleWars } from "@/server/clans.ts";
import { seasonOf } from "@/server/ladder-rules.ts";
import { ActionForm, Badge, DbDown, Field, Flash, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";
import { WarList, WarProposeForm } from "@/components/clan-wars";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  const { db } = await viewer();
  const data = db ? await clanBySlug(db, slug).catch(() => null) : null;
  return pageMeta(lang, `clans/${slug}`, data ? `[${data.clan.tag}] ${data.clan.name}` : clanText[lang].title, data?.clan.description || clanText[lang].lead);
}

export default async function ClanPage({ params, searchParams }: { params: Promise<{ lang: string; slug: string }>; searchParams: SearchParams }) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  const x = clanText[lang];
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  // Overdue wars are settled on view as well as by the daily maintenance run.
  await settleWars(db).catch(() => undefined);
  const data = await clanBySlug(db, slug);
  if (!data) notFound();
  const { clan, members } = data;
  const back = `/${lang}/clans/${clan.slug}`;
  const myRole = user ? (members.find((m) => m.id === user.id)?.role ?? null) : null;
  const leader = myRole === "owner" || myRole === "officer";
  const owner = myRole === "owner";
  const active = clan.status === "active";
  const season = seasonOf(new Date());
  const [wars, record, standing, invites, viewerClan] = await Promise.all([
    clanWars(db, clan.id),
    clanRecord(db, clan.id),
    clanSeason(db, clan.id, season),
    leader ? clanPendingInvites(db, clan.id) : Promise.resolve([]),
    user && !myRole ? clanOf(db, user.id) : Promise.resolve(null),
  ]);
  // A leader of another clan can challenge this one from here.
  const challenger = active && viewerClan && viewerClan.role !== "member" ? viewerClan : null;
  const challengerMembers = challenger ? ((await clanBySlug(db, challenger.slug))?.members ?? []) : [];
  const relationships = await clanRelationships(db, clan.id, leader);
  const T = (ru: string, en: string) => lang === "ru" ? ru : en;
  const hidden = { clan: clan.id };
  return (
    <div className="container page">
      <p className="eyebrow">
        <Link href={`/${lang}/clans`}>{x.title}</Link>
      </p>
      <div className="team-head">
        <h1>
          {clan.name} <span className="badge badge-muted">{clan.tag}</span> {active ? null : <Badge status="muted">{x.disbanded}</Badge>}
        </h1>
      </div>
      {clan.description ? <p className="prewrap">{clan.description}</p> : null}
      <Flash lang={lang} params={sp} />
      {myRole && active && <p className="row"><Link className="btn btn-primary" href={`/${lang}/community/chat?scope=clan&id=${clan.id}`}>{T("Чат нашего клана", "Our clan chat")}</Link><Link className="btn btn-ghost" href={`/${lang}/community`}>{T("Моё сообщество", "My community")}</Link></p>}
      <section className="card section-tight"><h2 className="h3">{T("Союзники и соперники", "Allies and rivals")}</h2><p className="small muted">{T("Договорённость подтверждают оба клана. Соперничество — в матчах по правилам; любой клан может завершить отношения.", "Both clans confirm the relationship. Rivalry takes place in rule-based matches; either clan can end the relationship.")}</p>
        {relationships.length ? <ul className="list">{relationships.map(r => <li key={r.id}><Link className="grow" href={`/${lang}/clans/${r.slug}`}>[{r.tag}] {r.name}</Link><span>{r.kind === "allies" ? T("Союзники", "Allies") : T("Соперники", "Rivals")} · {r.status === "active" ? T("Подтверждено", "Confirmed") : T("Ожидает ответа", "Awaiting reply")}</span>{leader && <span className="row">{r.incoming && r.status === "pending" && <ActionForm action="clan.relationship_respond" lang={lang} back={back} hidden={{ clan: clan.id, id: r.id, step: "accept" }}><button className="btn btn-primary btn-sm">{T("Принять", "Accept")}</button></ActionForm>}<ActionForm action="clan.relationship_respond" lang={lang} back={back} hidden={{ clan: clan.id, id: r.id, step: "end" }}><button className="btn btn-ghost btn-sm">{T("Завершить", "End")}</button></ActionForm></span>}</li>)}</ul> : <p className="muted">{T("Пока нет договорённостей с другими кланами.", "No relationships with other clans yet.")}</p>}
        {leader && active && <ActionForm action="clan.relationship" lang={lang} back={back} hidden={hidden} className="stack-sm"><Field label={T("Тег другого клана", "Other clan tag")}><input name="tag" required maxLength={8} /></Field><Field label={T("Предложение", "Proposal")}><select name="kind"><option value="allies">{T("Дружеский союз", "Alliance")}</option><option value="rivals">{T("Спортивное соперничество", "Sporting rivalry")}</option></select></Field><button className="btn btn-primary btn-sm">{T("Предложить отношения", "Send proposal")}</button></ActionForm>}
      </section>
      <dl className="stat-row">
        <div>
          <dt>{x.members}</dt>
          <dd>{clan.members}</dd>
        </div>
        <div>
          <dt>{x.warsCol}</dt>
          <dd>{record.wars}</dd>
        </div>
        <div>
          <dt>{x.wins}</dt>
          <dd>{record.wins}</dd>
        </div>
        <div>
          <dt>{x.losses}</dt>
          <dd>{record.losses}</dd>
        </div>
      </dl>
      <div className="grid grid-2">
        <section>
          <h2 className="h3">
            {x.members} ({members.length})
          </h2>
          <ul className="list">
            {members.map((m) => (
              <li key={m.id} className="member-row">
                <MemberAvatar name={m.display_name} mediaId={m.avatar_media_id} />
                <span className="grow">
                  <Link href={`/${lang}/players/${m.username}`}>{m.display_name}</Link> <span className="small muted">@{m.username}</span>
                </span>
                <span className="small">
                  {m.role === "member" ? <span className="muted">{x.roles.member}</span> : <Badge status={m.role === "owner" ? "works" : "connect"}>{x.roles[m.role]}</Badge>}
                </span>
                {owner && m.id !== user?.id ? (
                  <span className="row">
                    <ActionForm action="clan.role" lang={lang} back={back} hidden={{ ...hidden, member: m.id, role: m.role === "officer" ? "member" : "officer" }}>
                      <button className="btn btn-ghost btn-xs">{m.role === "officer" ? x.makeMember : x.makeOfficer}</button>
                    </ActionForm>
                    <ActionForm action="clan.role" lang={lang} back={back} hidden={{ ...hidden, member: m.id, role: "owner" }}>
                      <button className="btn btn-ghost btn-xs">{x.makeOwner}</button>
                    </ActionForm>
                  </span>
                ) : null}
                {leader && m.id !== user?.id && m.role !== "owner" && (owner || m.role === "member") ? (
                  <ActionForm action="clan.remove" lang={lang} back={back} hidden={{ ...hidden, member: m.id }}>
                    <button className="btn btn-ghost btn-xs">{x.remove}</button>
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
          {myRole && (myRole !== "owner" || members.length === 1) ? (
            <div className="stack-sm">
              {myRole === "owner" ? <p className="small muted">{x.disbandHint}</p> : null}
              <ActionForm action="clan.leave" lang={lang} back={back} hidden={hidden}>
                <button className={`btn btn-sm ${myRole === "owner" ? "btn-danger" : "btn-ghost"}`}>{myRole === "owner" ? x.disband : x.leave}</button>
              </ActionForm>
            </div>
          ) : null}
        </section>
        <section>
          {leader && active ? (
            <>
              <h2 className="h3">{x.invite}</h2>
              <ActionForm action="clan.invite" lang={lang} back={back} hidden={hidden} className="inline-form">
                <input name="username" required pattern="[A-Za-z0-9_]{3,24}" placeholder={x.inviteUsername} aria-label={x.inviteUsername} autoCapitalize="none" />
                <button className="btn btn-primary btn-sm">{x.send}</button>
              </ActionForm>
              {invites.length ? (
                <>
                  <h3 className="h4">{x.pendingInvites}</h3>
                  <ul className="list">
                    {invites.map((i) => (
                      <li key={i.id}>
                        <span>
                          @{i.username}{" "}
                          <span className="small muted">
                            <LocalTime iso={i.created_at} lang={lang} dateOnly />
                          </span>
                        </span>
                        <ActionForm action="clan.revoke" lang={lang} back={back} hidden={{ invite: i.id }}>
                          <button className="btn btn-ghost btn-xs">{x.revoke}</button>
                        </ActionForm>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <details className="disclosure card">
                <summary>{x.editDescription}</summary>
                <ActionForm action="clan.update" lang={lang} back={back} hidden={hidden} className="stack-sm">
                  <Field label={x.description}>
                    <textarea name="description" maxLength={500} rows={3} defaultValue={clan.description} />
                  </Field>
                  <button className="btn btn-primary btn-sm">{x.save}</button>
                </ActionForm>
              </details>
            </>
          ) : null}
          <h2 className="h3">
            {x.season}: {x.seasonLabel(season)}
          </h2>
          {standing.length ? (
            <ul className="list small">
              {standing.map((r) => (
                <li key={r.game}>
                  <Link href={`/${lang}/ladders?season=${season}&game=${r.game}`} className="grow">
                    {gameBySlug(r.game)?.name ?? r.game}
                  </Link>
                  <span>
                    {x.rating} <strong>{r.rating}</strong> · {r.rank} {x.rank} · {r.wins}–{r.losses}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">{x.noSeason}</p>
          )}
          <p className="small">
            <Link href={`/${lang}/ladders`}>{x.ladders} →</Link>
          </p>
        </section>
      </div>
      <section className="section-tight" id="wars">
        <h2 className="h3">{x.wars}</h2>
        <p className="small muted">{x.warsLead}</p>
        {leader && active ? <WarProposeForm lang={lang} clanId={clan.id} members={members} back={back} /> : null}
        {challenger ? (
          <WarProposeForm lang={lang} clanId={challenger.id} members={challengerMembers} back={back} opponent={{ id: clan.id, name: clan.name }} />
        ) : null}
        <WarList lang={lang} wars={wars} clanId={clan.id} leader={leader} members={members} back={back} />
      </section>
    </div>
  );
}
