import { fill, type Locale } from "@/lib/i18n.ts";
import { systemText } from "@/lib/message-text.ts";
import type { Database } from "@/server/db.ts";
import type { SessionUser } from "@/server/auth.ts";
import { systemStatus } from "@/server/system.ts";
import { mailConfigured } from "@/server/mail.ts";
import { paymentReadiness, publicOffer } from "@/server/billing.ts";
import { ActionForm, Badge, Field } from "@/components/ui";
import { LocalTime } from "@/components/time";

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** Control-centre tab: live state of this deployment, feature switches and maintenance (MV-STAFF-1). */
export async function SystemTab({ db, lang, back }: { db: Database; user: SessionUser; lang: Locale; back: string }) {
  const x = systemText[lang];
  const [s, offer] = await Promise.all([systemStatus(db), publicOffer(db).catch(() => null)]);
  const pay = paymentReadiness(offer);
  const m = s.maintenance;
  const Since = ({ at }: { at: Date | null }) =>
    at ? (
      <span className="queue-age muted">
        {x.oldest} <LocalTime iso={at} lang={lang} />
      </span>
    ) : null;
  return (
    <div className="stack">
      <h2 className="h3">{x.title}</h2>
      <p className="small muted">{x.lead}</p>

      <section className="card stack-sm">
        <h3 className="h4">{x.maintenance}</h3>
        <p className="small muted">{x.maintenanceLead}</p>
        {m?.enabled ? (
          <p className="notice notice-warn small">
            <span>
              {x.maintenanceActive} <LocalTime iso={m.updated_at} lang={lang} /> · @{m.updated_by ?? "—"}
              {m.note ? ` · ${m.note}` : ""}
            </span>
          </p>
        ) : null}
        <ActionForm action="system.maintenance" lang={lang} back={back} hidden={{ on: m?.enabled ? "0" : "1" }} className="stack-sm">
          {m?.enabled ? null : (
            <Field label={x.maintenanceNote}>
              <input name="note" maxLength={300} />
            </Field>
          )}
          <button className={m?.enabled ? "btn btn-primary btn-sm" : "btn btn-danger btn-sm"}>{m?.enabled ? x.maintenanceOff : x.maintenanceOn}</button>
        </ActionForm>
      </section>

      <section className="stack-sm">
        <h3 className="h4">{x.services}</h3>
        <ul className="list small">
          <li>
            <span className="grow">{x.database}</span>
            <span>
              <Badge status="ok">{fill(x.latency, { ms: s.latencyMs })}</Badge>
              {s.sizeBytes !== null ? ` · ${x.size} ${mb(s.sizeBytes)}` : ""}
            </span>
          </li>
          {s.migration ? (
            <li>
              <span className="grow">{x.migration}</span>
              <span className="mono break-all">
                #{s.migration.id} {s.migration.name}
              </span>
            </li>
          ) : null}
          <li>
            <span className="grow">{x.mail}</span>
            <Badge status={mailConfigured() ? "ok" : "warn"}>{mailConfigured() ? x.connected : x.notConnected}</Badge>
          </li>
          <li>
            <span className="grow">{x.payments}</span>
            <Badge status={pay.ready ? "ok" : "warn"}>{pay.ready ? `${x.on} · ${pay.mode}` : x.off}</Badge>
          </li>
        </ul>
      </section>

      <section className="stack-sm">
        <h3 className="h4">{x.queues}</h3>
        <ul className="list small">
          <li>
            <span className="grow">
              {x.mailQueue}
              <Since at={s.mail.oldest} />
            </span>
            <span>{s.mail.pending}</span>
          </li>
          <li>
            <span className="grow">{x.mailFailed}</span>
            <Badge status={s.mail.failed ? "bad" : "ok"}>{s.mail.failed}</Badge>
          </li>
          <li>
            <span className="grow">
              {x.hookQueue}
              <Since at={s.webhooks.oldest} />
            </span>
            <span>{s.webhooks.pending}</span>
          </li>
          <li>
            <span className="grow">{x.hookFailed}</span>
            <Badge status={s.webhooks.failed ? "bad" : "ok"}>{s.webhooks.failed}</Badge>
          </li>
          <li>
            <span className="grow">{x.incidents}</span>
            <Badge status={s.openIncidents ? "warn" : "ok"}>{s.openIncidents}</Badge>
          </li>
          <li>
            <span className="grow">{x.quickQueue}</span>
            <span>{s.queued}</span>
          </li>
        </ul>
      </section>

      <section className="stack-sm">
        <h3 className="h4">{x.runs}</h3>
        {s.runs.length ? (
          <ul className="list small">
            {s.runs.map((r) => (
              <li key={r.name}>
                <span className="grow mono">{r.name}</span>
                <span className="muted">
                  {x.lastRun} <LocalTime iso={r.last_at} lang={lang} />
                </span>
                <span className="mono small break-all">{JSON.stringify(r.result)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">{x.noRuns}</p>
        )}
      </section>

      <section className="stack-sm">
        <h3 className="h4">{x.config}</h3>
        <ul className="list small">
          {Object.entries(s.config).map(([k, present]) => (
            <li key={k}>
              <span className="grow">{x.configNames[k] ?? k}</span>
              <Badge status={present ? "ok" : "warn"}>{present ? x.present : x.missing}</Badge>
            </li>
          ))}
        </ul>
      </section>

      <section className="stack-sm">
        <h3 className="h4">{x.features}</h3>
        <p className="small muted">{x.featuresLead}</p>
        <ul className="list">
          {s.features.map((f) => (
            <li key={f.key} className="stack-sm">
              <span className="row">
                <strong className="grow">{x.featureNames[f.key] ?? f.key}</strong>
                <Badge status={f.enabled ? "ok" : "bad"}>{f.enabled ? x.enabled : x.disabled}</Badge>
              </span>
              {f.updated_at ? (
                <span className="small muted">
                  {x.changed} @{f.updated_by ?? "—"} · <LocalTime iso={f.updated_at} lang={lang} />
                  {f.note ? ` · ${f.note}` : ""}
                </span>
              ) : null}
              <ActionForm action="system.flag" lang={lang} back={back} hidden={{ key: f.key, on: f.enabled ? "0" : "1" }} className="inline-form">
                <input name="note" maxLength={300} placeholder={x.note} aria-label={x.note} />
                <button className={f.enabled ? "btn btn-danger btn-xs" : "btn btn-primary btn-xs"}>{f.enabled ? x.turnOff : x.turnOn}</button>
              </ActionForm>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
