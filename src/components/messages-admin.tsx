import { fill, type Locale } from "@/lib/i18n.ts";
import { GAMES } from "@/lib/games.ts";
import { countryOptions } from "@/lib/countries.ts";
import { messageText, segmentLabel } from "@/lib/message-text.ts";
import type { Database } from "@/server/db.ts";
import type { SessionUser } from "@/server/auth.ts";
import { ACTIVE_DAYS, AUDIENCES, CAP_DAYS, MARKETING_CAP, MESSAGE_KINDS, messageList, previewReach, type StaffMessage } from "@/server/messages.ts";
import { canSendMessage } from "@/server/staff-roles.ts";
import { ActionForm, Badge, Empty, Field } from "@/components/ui";
import { LocalTime } from "@/components/time";

function MessageFields({ lang, kinds, m }: { lang: Locale; kinds: string[]; m?: StaffMessage }) {
  const x = messageText[lang];
  return (
    <>
      <div className="form-grid">
        <Field label={x.kind}>
          <select name="kind" defaultValue={m?.kind ?? kinds[0]}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {x.kinds[k]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={x.subject}>
          <input name="title" required minLength={3} maxLength={120} defaultValue={m?.title} />
        </Field>
        <Field label={x.audience}>
          <select name="audience" defaultValue={m?.segment.audience ?? "all"}>
            {AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {x.audiences[a]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={x.game}>
          <select name="game" defaultValue={m?.segment.game ?? ""}>
            <option value="">{x.any}</option>
            {GAMES.map((g) => (
              <option key={g.slug} value={g.slug}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={x.country}>
          <select name="country" defaultValue={m?.segment.country ?? ""}>
            <option value="">{x.any}</option>
            {countryOptions(lang).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={x.active}>
          <select name="activeDays" defaultValue={String(m?.segment.activeDays ?? 0)}>
            <option value="0">{x.activeAny}</option>
            {ACTIVE_DAYS.map((n) => (
              <option key={n} value={n}>
                {fill(x.activeDays, { n })}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={x.body}>
        <textarea name="body" required maxLength={2000} rows={5} defaultValue={m?.body} />
      </Field>
    </>
  );
}

/** Control-centre tab: drafts, templates and sent messages with their delivery statuses and openings. */
export async function MessagesTab({ db, user, lang, back }: { db: Database; user: SessionUser; lang: Locale; back: string }) {
  const x = messageText[lang];
  const kinds = MESSAGE_KINDS.filter((k) => canSendMessage(user.roles, k));
  const rows = await messageList(db);
  const pending = rows.filter((m) => m.status !== "sent");
  const sent = rows.filter((m) => m.status === "sent");
  const reach = await Promise.all(pending.map((m) => (m.status === "draft" ? previewReach(db, m.kind, m.segment) : null)));
  return (
    <div className="stack">
      <h2 className="h3">{x.title}</h2>
      <p className="small muted">{fill(x.lead, { cap: MARKETING_CAP, days: CAP_DAYS })}</p>
      <p className="small muted">{x.rights}</p>
      {kinds.length ? (
        <details className="disclosure card" open={!rows.length}>
          <summary>{x.create}</summary>
          <ActionForm action="message.create" lang={lang} back={back} className="stack-sm">
            <MessageFields lang={lang} kinds={kinds} />
            <div className="row">
              <button className="btn btn-primary btn-sm" name="template" value="0">
                {x.saveDraft}
              </button>
              <button className="btn btn-ghost btn-sm" name="template" value="1">
                {x.saveTemplate}
              </button>
            </div>
          </ActionForm>
        </details>
      ) : (
        <p className="notice small">{x.readOnly}</p>
      )}
      <section className="stack-sm">
        <h3 className="h4">{x.drafts}</h3>
        {pending.length ? (
          <ul className="list">
            {pending.map((m, i) => {
              const mine = canSendMessage(user.roles, m.kind);
              const r = reach[i];
              return (
                <li key={m.id} className="stack-sm">
                  <strong className="msg-title">{m.title}</strong>
                  <span className="row">
                    <Badge status={m.status === "draft" ? "info" : "muted"}>{m.status === "draft" ? x.draft : x.template}</Badge>
                    <Badge status={m.kind === "marketing" ? "warn" : "ok"}>{x.kinds[m.kind]}</Badge>
                  </span>
                  <span className="small muted">
                    {segmentLabel(lang, m.segment)} · {x.by} @{m.author} · <LocalTime iso={m.created_at} lang={lang} />
                  </span>
                  <p className="small prewrap clamp-2">{m.body}</p>
                  {r ? (
                    <p className="small">
                      {fill(x.reach, { reach: r.reach, total: r.total })}
                      {m.kind === "marketing" ? ` · ${fill(x.skippedConsent, { n: r.skippedConsent })} · ${fill(x.skippedCap, { n: r.skippedCap })}` : ""}
                    </p>
                  ) : null}
                  {mine ? (
                    <div className="row">
                      {m.status === "draft" ? (
                        <ActionForm action="message.send" lang={lang} back={back} hidden={{ message: m.id }}>
                          <button className="btn btn-primary btn-sm">{x.send}</button>
                        </ActionForm>
                      ) : null}
                      <ActionForm action="message.copy" lang={lang} back={back} hidden={{ message: m.id, as: "draft" }}>
                        <button className="btn btn-ghost btn-sm">{m.status === "template" ? x.useTemplate : x.copy}</button>
                      </ActionForm>
                      {m.status === "draft" ? (
                        <ActionForm action="message.copy" lang={lang} back={back} hidden={{ message: m.id, as: "template" }}>
                          <button className="btn btn-ghost btn-sm">{x.asTemplate}</button>
                        </ActionForm>
                      ) : null}
                      <ActionForm action="message.delete" lang={lang} back={back} hidden={{ message: m.id }}>
                        <button className="btn btn-ghost btn-sm">{x.remove}</button>
                      </ActionForm>
                    </div>
                  ) : null}
                  {mine ? (
                    <details className="disclosure">
                      <summary>{x.edit}</summary>
                      <ActionForm action="message.update" lang={lang} back={back} hidden={{ message: m.id }} className="stack-sm">
                        <MessageFields lang={lang} kinds={kinds} m={m} />
                        <button className="btn btn-ghost btn-sm">{x.save}</button>
                      </ActionForm>
                    </details>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty title={x.noDrafts} />
        )}
      </section>
      <section className="stack-sm">
        <h3 className="h4">{x.sent}</h3>
        {sent.length ? (
          <ul className="list">
            {sent.map((m) => {
              const delivered = m.stats.sent ?? 0;
              return (
                <li key={m.id} className="stack-sm">
                  <strong className="msg-title">{m.title}</strong>
                  <span className="row">
                    <Badge status={m.kind === "marketing" ? "warn" : "ok"}>{x.kinds[m.kind]}</Badge>
                    {mineCopy(user, m, lang, back)}
                  </span>
                  <span className="small muted">
                    {segmentLabel(lang, m.segment)} · {x.sentBy} @{m.sender ?? "—"} · {m.sent_at ? <LocalTime iso={m.sent_at} lang={lang} /> : "—"}
                  </span>
                  <span className="small">
                    {Object.entries(m.stats)
                      .map(([k, n]) => `${x.stat[k] ?? k}: ${n}`)
                      .join(" · ")}
                    {` · ${x.opened}: ${m.opened}${delivered ? ` (${Math.round((m.opened / delivered) * 100)}%)` : ""}`}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty title={x.noSent} />
        )}
      </section>
    </div>
  );
}

function mineCopy(user: SessionUser, m: StaffMessage, lang: Locale, back: string) {
  if (!canSendMessage(user.roles, m.kind)) return null;
  return (
    <ActionForm action="message.copy" lang={lang} back={back} hidden={{ message: m.id, as: "draft" }}>
      <button className="btn btn-ghost btn-xs">{messageText[lang].copy}</button>
    </ActionForm>
  );
}
