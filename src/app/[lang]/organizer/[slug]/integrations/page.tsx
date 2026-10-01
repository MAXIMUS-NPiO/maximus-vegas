import Link from "next/link";
import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { siteOrigin } from "@/lib/site.ts";
import { embedCode, integrationsText } from "@/lib/integrations-text.ts";
import { viewer } from "@/server/viewer.ts";
import { orgBySlug } from "@/server/queries.ts";
import { canManageOrg } from "@/server/access.ts";
import { listApiKeys, listWebhooks, recentDeliveries, WEBHOOK_EVENTS } from "@/server/partner.ts";
import { sealScheme } from "@/server/secret-box.ts";
import { ActionForm, Badge, Check, DbDown, Empty, Field, Flash, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; slug: string }> }): Promise<Metadata> {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, `organizer/${slug}/integrations`, integrationsText[lang].title, undefined, { noindex: true });
}

function readSecret(raw: string | undefined): { kind: "key" | "webhook"; value: string } | null {
  if (!raw || raw.length > 400) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { kind?: string; value?: string };
    if ((v.kind === "key" && /^mvk_[A-Za-z0-9_-]{20,80}$/.test(v.value ?? "")) || (v.kind === "webhook" && /^whsec_[A-Za-z0-9_-]{20,80}$/.test(v.value ?? "")))
      return { kind: v.kind, value: v.value! };
  } catch {
    // ignore a malformed cookie
  }
  return null;
}

const PUBLIC = new Set(["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED", "IN_PROGRESS", "PAUSED", "COMPLETED"]);

export default async function Integrations({ params, searchParams }: { params: Promise<{ lang: string; slug: string }>; searchParams: SearchParams }) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();
  const x = integrationsText[lang];
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  const back = `/${lang}/organizer/${slug}/integrations`;
  if (!user) redirect(`/${lang}/signin?next=${back}`);
  const data = await orgBySlug(db, slug);
  if (!data) notFound();
  if (!(await canManageOrg(db, data.org.id, user))) notFound();
  const org = data.org;
  const [keys, hooks, deliveries] = await Promise.all([listApiKeys(db, org.id), listWebhooks(db, org.id), recentDeliveries(db, org.id)]);
  const secret = readSecret((await cookies()).get("mv_secret")?.value);
  const h = await headers();
  const origin = siteOrigin() ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost"}`;
  const published = data.tournaments.filter((t) => PUBLIC.has(t.status));
  const hidden = { org: org.id };
  const plain = sealScheme("webhook") === "plain";
  return (
    <div className="container page">
      <p className="eyebrow">
        <Link href={`/${lang}/organizer/${slug}`}>
          {x.toSpace}: {org.name}
        </Link>
      </p>
      <h1>{x.title}</h1>
      <p className="lead">{x.lead}</p>
      <p>
        <Link href={`/${lang}/developers`} className="btn btn-ghost btn-sm">
          {x.docs}
        </Link>
      </p>
      <Flash lang={lang} params={sp} />
      {secret ? (
        <section className="notice stack-sm one-time-secret" aria-live="polite">
          <strong>{x.oneTime}</strong>
          <p className="small">{secret.kind === "key" ? x.oneTimeKey : x.oneTimeSecret}</p>
          <code className="mono secret-value">{secret.value}</code>
          <ActionForm action="integrations.secret_hide" lang={lang} back={back}>
            <button className="btn btn-primary btn-sm">{x.saved}</button>
          </ActionForm>
        </section>
      ) : null}

      <section className="section-tight" id="keys">
        <h2 className="h3">{x.keys}</h2>
        <p className="small muted">{x.keysLead}</p>
        {keys.length ? (
          <ul className="list">
            {keys.map((k) => (
              <li key={k.id}>
                <span className="grow">
                  <strong>{k.name}</strong> <code className="mono small">{k.prefix}…</code>{" "}
                  <span className="small muted">
                    {x.created} <LocalTime iso={k.created_at} lang={lang} dateOnly /> @{k.created_by} ·{" "}
                    {k.last_used_at ? (
                      <>
                        {x.lastUsed} <LocalTime iso={k.last_used_at} lang={lang} />
                      </>
                    ) : (
                      x.never
                    )}
                  </span>
                </span>
                {k.revoked_at ? (
                  <Badge status="muted">{x.revoked}</Badge>
                ) : (
                  <span className="row">
                    <Badge status="ok">{x.active}</Badge>
                    <ActionForm action="integrations.key_revoke" lang={lang} back={back} hidden={{ key: k.id }}>
                      <button className="btn btn-ghost btn-xs">{x.revoke}</button>
                    </ActionForm>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">{x.noKeys}</p>
        )}
        <ActionForm action="integrations.key_create" lang={lang} back={back} hidden={hidden} className="inline-form">
          <Field label={x.keyName}>
            <input name="name" required minLength={2} maxLength={60} />
          </Field>
          <button className="btn btn-primary btn-sm">{x.createKey}</button>
        </ActionForm>
      </section>

      <section className="section-tight" id="webhooks">
        <h2 className="h3">{x.hooks}</h2>
        <p className="small muted">{x.hooksLead}</p>
        {plain ? <p className="small text-bad">{x.plainSecrets}</p> : null}
        {hooks.length ? (
          <ul className="list">
            {hooks.map((e) => (
              <li key={e.id} className="stack-sm">
                <div className="row-between">
                  <code className="mono small break-all">{e.url}</code>
                  <Badge status={e.active ? "ok" : "muted"}>{e.active ? x.on : x.off}</Badge>
                </div>
                <p className="small muted">
                  {e.events.map((ev) => x.eventNames[ev] ?? ev).join(" · ")} · {x.pending}: {e.pending} · {x.failed}: {e.failed}
                </p>
                <div className="row">
                  {e.active ? (
                    <ActionForm action="integrations.webhook_test" lang={lang} back={back} hidden={{ endpoint: e.id }}>
                      <button className="btn btn-ghost btn-xs">{x.test}</button>
                    </ActionForm>
                  ) : null}
                  <ActionForm action="integrations.webhook_rotate" lang={lang} back={back} hidden={{ endpoint: e.id }}>
                    <button className="btn btn-ghost btn-xs">{x.rotate}</button>
                  </ActionForm>
                  <ActionForm action="integrations.webhook_toggle" lang={lang} back={back} hidden={{ endpoint: e.id, active: e.active ? "0" : "1" }}>
                    <button className="btn btn-ghost btn-xs">{e.active ? x.disable : x.enable}</button>
                  </ActionForm>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">{x.noHooks}</p>
        )}
        <details className="disclosure card">
          <summary>{x.addHook}</summary>
          <ActionForm action="integrations.webhook_create" lang={lang} back={back} hidden={hidden} className="stack-sm">
            <Field label={x.url}>
              <input name="url" type="url" required maxLength={500} placeholder="https://" inputMode="url" />
            </Field>
            <div className="stack-sm" role="group" aria-label={x.events}>
              <span className="field-label">{x.events}</span>
              <div className="check-grid">
                {WEBHOOK_EVENTS.map((ev) => (
                  <Check key={ev} name="events" value={ev} defaultChecked label={`${x.eventNames[ev]} (${ev})`} />
                ))}
              </div>
            </div>
            <button className="btn btn-primary btn-sm">{x.addHook}</button>
          </ActionForm>
        </details>
        <h3 className="h4">{x.deliveries}</h3>
        {deliveries.length ? (
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <code className="mono small">{d.event_type}</code>
                      <div className="small muted break-all">{d.url}</div>
                    </td>
                    <td>
                      <Badge status={d.status === "delivered" ? "ok" : d.status === "failed" ? "bad" : "warn"}>{x.statuses[d.status] ?? d.status}</Badge>
                      <div className="small muted">
                        {d.attempts} {x.attempts}
                        {d.last_status ? ` · HTTP ${d.last_status}` : ""}
                        {d.last_error ? ` · ${d.last_error}` : ""}
                      </div>
                    </td>
                    <td className="small muted">
                      <LocalTime iso={d.delivered_at ?? d.created_at} lang={lang} />
                    </td>
                    <td>
                      {d.status !== "delivered" ? (
                        <ActionForm action="integrations.delivery_retry" lang={lang} back={back} hidden={{ delivery: d.id }}>
                          <button className="btn btn-ghost btn-xs">{x.retry}</button>
                        </ActionForm>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="small muted">{x.noDeliveries}</p>
        )}
      </section>

      <section className="section-tight" id="widgets">
        <h2 className="h3">{x.widgets}</h2>
        <p className="small muted">{x.widgetsLead}</p>
        <div className="stack-sm">
          <h3 className="h4">{x.calendar}</h3>
          <textarea
            readOnly
            rows={2}
            className="mono small embed-code"
            value={embedCode(`${origin}/embed/${lang}/organizer/${org.slug}/calendar`, `${org.name} — ${x.calendar}`, 420)}
          />
          <a href={`/embed/${lang}/organizer/${org.slug}/calendar`} target="_blank" rel="noopener" className="small">
            {x.preview} ↗
          </a>
        </div>
        {published.length ? (
          published.slice(0, 20).map((t) => (
            <details key={t.id} className="disclosure card">
              <summary>{t.name}</summary>
              <div className="stack-sm">
                {(["bracket", "registration", "standings"] as const).map((w) => (
                  <div key={w} className="stack-sm">
                    <span className="field-label">{x[w]}</span>
                    <textarea
                      readOnly
                      rows={2}
                      className="mono small embed-code"
                      value={embedCode(`${origin}/embed/${lang}/tournaments/${t.slug}/${w}`, `${t.name} — ${x[w]}`, w === "registration" ? 260 : 560)}
                    />
                    <a href={`/embed/${lang}/tournaments/${t.slug}/${w}`} target="_blank" rel="noopener" className="small">
                      {x.preview} ↗
                    </a>
                  </div>
                ))}
              </div>
            </details>
          ))
        ) : (
          <Empty title={x.noTournaments} />
        )}
      </section>
    </div>
  );
}
