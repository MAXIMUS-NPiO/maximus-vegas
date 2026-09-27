import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, fill, isLocale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { adminApplications, adminAudit, adminDisputes, adminOverview, adminTournaments, adminUsers } from "@/server/queries.ts";
import { verifyAuditChain } from "@/server/audit.ts";
import { isAdmin, isStaff } from "@/server/access.ts";
import { ActionForm, Badge, DbDown, Empty, Flash, one, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "admin", dict(lang).admin.title, undefined, { noindex: true });
}

const TABS = ["overview", "users", "disputes", "applications", "tournaments", "audit"] as const;

export default async function Admin({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const a = d.admin;
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user) redirect(`/${lang}/signin?next=/${lang}/admin`);
  if (!isStaff(user))
    return (
      <div className="container narrow page">
        <h1>{a.title}</h1>
        <p className="notice notice-warn">{a.forbidden}</p>
        <Link href={`/${lang}/admin/claim`} className="text-link">
          {a.claimTitle}
        </Link>
      </div>
    );
  const tab = (TABS as readonly string[]).includes(one(sp.tab)) ? (one(sp.tab) as (typeof TABS)[number]) : "overview";
  const back = `/${lang}/admin?tab=${tab}`;
  const admin = isAdmin(user);

  let body: React.ReactNode = null;
  if (tab === "overview") {
    const counts = await adminOverview(db);
    body = (
      <dl className="stat-grid">
        {Object.entries(counts).map(([k, v]) => (
          <div key={k}>
            <dt>{a.counts[k]}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    );
  } else if (tab === "users") {
    const q = one(sp.q).slice(0, 60);
    const users = await adminUsers(db, q);
    body = (
      <>
        <form method="get" className="inline-form toolbar">
          <input type="hidden" name="tab" value="users" />
          <input name="q" defaultValue={q} placeholder={a.search} aria-label={a.search} />
          <button className="btn btn-ghost btn-sm">{d.common.search}</button>
        </form>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{d.players.title}</th>
                <th>Email</th>
                <th>{a.roles}</th>
                <th>{d.match.status}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <Link href={`/${lang}/players/${u.username}`}>{u.display_name}</Link>
                    <div className="small muted">
                      @{u.username} · <LocalTime iso={u.created_at} lang={lang} dateOnly />
                    </div>
                  </td>
                  <td className="small">{u.email}</td>
                  <td>
                    <div className="row">
                      {(["admin", "referee", "support"] as const).map((role) => {
                        const has = u.roles.includes(role);
                        return admin ? (
                          <ActionForm key={role} action="admin.role" lang={lang} back={back + (q ? `&q=${encodeURIComponent(q)}` : "")} hidden={{ user: u.id, role, grant: has ? "0" : "1" }}>
                            <button className={has ? "btn btn-primary btn-xs" : "btn btn-ghost btn-xs"} title={has ? a.revokeRole : a.grant}>
                              {role}
                            </button>
                          </ActionForm>
                        ) : has ? (
                          <span key={role} className="badge badge-info">
                            {role}
                          </span>
                        ) : null;
                      })}
                    </div>
                  </td>
                  <td>
                    <Badge status={u.status === "active" ? "works" : "rejected"}>{u.status}</Badge>
                    {admin && u.id !== user.id ? (
                      u.status === "active" ? (
                        <details className="disclosure">
                          <summary>{a.suspend}</summary>
                          <ActionForm action="admin.user_status" lang={lang} back={back} hidden={{ user: u.id, status: "suspended" }} className="inline-form">
                            <input name="reason" required minLength={5} maxLength={300} placeholder={a.reason} aria-label={a.reason} />
                            <button className="btn btn-danger btn-xs">{a.suspend}</button>
                          </ActionForm>
                        </details>
                      ) : (
                        <ActionForm action="admin.user_status" lang={lang} back={back} hidden={{ user: u.id, status: "active", reason: "reinstated" }}>
                          <button className="btn btn-ghost btn-xs">{a.unsuspend}</button>
                        </ActionForm>
                      )
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  } else if (tab === "disputes") {
    const list = await adminDisputes(db);
    body = list.length ? (
      <ul className="list">
        {list.map((x) => (
          <li key={x.id}>
            <span className="grow">
              <Link href={`/${lang}/matches/${x.match_id}`}>{x.t_name}</Link>
              <span className="small muted">
                {" "}
                · @{x.opened_by} · <LocalTime iso={x.created_at} lang={lang} />
              </span>
              <div className="small prewrap">{x.reason === "conflicting_results" ? (lang === "ru" ? "Стороны отправили разные результаты" : "The sides submitted different results") : x.reason}</div>
            </span>
            <Link href={`/${lang}/matches/${x.match_id}`} className="btn btn-ghost btn-xs">
              {d.organizer.open}
            </Link>
          </li>
        ))}
      </ul>
    ) : (
      <Empty title={a.noDisputes} />
    );
  } else if (tab === "applications") {
    const list = await adminApplications(db);
    body = list.length ? (
      <ul className="list">
        {list.map((x) => (
          <li key={x.id} className="stack-sm">
            <div className="row-between">
              <strong>
                {d.forms.kinds[x.kind] ?? x.kind} · {x.name}
              </strong>
              <Badge status={x.status}>{a.applicationStatus[x.status]}</Badge>
            </div>
            <span className="small">
              <a href={`mailto:${x.email}`} className="text-link">
                {x.email}
              </a>
              {x.company ? ` · ${x.company}` : ""} · {x.lang.toUpperCase()} · <LocalTime iso={x.created_at} lang={lang} />
            </span>
            {x.message ? <p className="small prewrap">{x.message}</p> : null}
            <div className="row">
              {(["new", "in_review", "closed"] as const)
                .filter((s) => s !== x.status)
                .map((s) => (
                  <ActionForm key={s} action="admin.application" lang={lang} back={back} hidden={{ application: x.id, status: s }}>
                    <button className="btn btn-ghost btn-xs">{a.applicationStatus[s]}</button>
                  </ActionForm>
                ))}
            </div>
          </li>
        ))}
      </ul>
    ) : (
      <Empty title={a.noApplications} />
    );
  } else if (tab === "tournaments") {
    const list = await adminTournaments(db);
    body = (
      <div className="table-wrap">
        <table className="table">
          <tbody>
            {list.map((x) => (
              <tr key={x.slug}>
                <td>
                  <Link href={`/${lang}/organizer/t/${x.slug}`}>{x.name}</Link>
                  <div className="small muted">{x.org_name}</div>
                </td>
                <td>{gameBySlug(x.game)?.name ?? x.game}</td>
                <td>
                  <Badge status={x.status}>{d.statuses.tournament[x.status]}</Badge>
                </td>
                <td className="small">
                  <LocalTime iso={x.starts_at} lang={lang} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else if (tab === "audit") {
    const [chain, rows] = await Promise.all([verifyAuditChain(db), adminAudit(db)]);
    body = (
      <>
        <p className={chain.valid ? "notice notice-ok" : "notice notice-warn"}>
          <strong>{a.chain}:</strong> {chain.valid ? fill(a.chainOk, { n: chain.records }) : fill(a.chainBroken, { id: chain.brokenAt })}
        </p>
        <div className="table-wrap">
          <table className="table small">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">#{r.id}</td>
                  <td>
                    <LocalTime iso={r.at} lang={lang} />
                  </td>
                  <td>{r.actor ? `@${r.actor}` : "system"}</td>
                  <td className="mono">{r.action}</td>
                  <td className="mono muted">
                    {r.entity}:{r.entity_id.slice(0, 8)}
                  </td>
                  <td className="mono muted">{r.hash.slice(0, 12)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <div className="container page">
      <h1>{a.title}</h1>
      <Flash lang={lang} params={sp} />
      <nav className="chips" aria-label={a.title}>
        {TABS.map((k) => (
          <Link key={k} href={`/${lang}/admin?tab=${k}`} className={k === tab ? "chip is-active" : "chip"} aria-current={k === tab ? "page" : undefined}>
            {a.tabs[k]}
          </Link>
        ))}
      </nav>
      <section className="section-tight">{body}</section>
    </div>
  );
}
