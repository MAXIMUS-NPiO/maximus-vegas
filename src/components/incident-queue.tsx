import Link from "next/link";
import type { Locale } from "@/lib/i18n.ts";
import { liveopsText } from "@/lib/liveops-text.ts";
import { overdue, PRIORITIES, STAFF_KINDS, type QueueItem } from "@/server/liveops.ts";
import { ActionForm, Badge, Field } from "@/components/ui";
import { LocalTime } from "@/components/time";

/** Badge tones by priority, reusing the shared badge palette: bad, warn, info, muted. */
const tone: Record<string, string> = { urgent: "disputed", high: "result_submitted", normal: "connect", low: "completed" };

function Item({ lang, i, staff, back, userId, now }: { lang: Locale; i: QueueItem; staff: { id: string; username: string }[]; back: string; userId: string; now: Date }) {
  const x = liveopsText[lang];
  const waited = Math.floor((now.getTime() - new Date(i.created_at).getTime()) / 60_000);
  return (
    <li className={`incident incident-${i.priority}`}>
      <div className="row incident-head">
        <Badge status={tone[i.priority]}>{x.priorities[i.priority]}</Badge>
        <strong>{x.kinds[i.kind]}</strong>
        {i.escalated_at ? <Badge status="disputed">{x.escalated}</Badge> : null}
        {overdue(i, now) ? (
          <span className="small incident-overdue">
            {x.overdue} {waited} {x.minutes}
          </span>
        ) : null}
        <span className="small muted">
          <LocalTime iso={i.created_at} lang={lang} withZone={false} /> · {x.from} @{i.opened_by}
          {i.side ? ` · ${(i.side === "a" ? i.a_name : i.b_name) ?? `${x.side} ${i.side.toUpperCase()}`}` : ""}
        </span>
      </div>
      {i.match_id ? (
        <p className="small">
          {x.match}:{" "}
          <Link href={`/${lang}/matches/${i.match_id}`} className="text-link">
            {i.a_name ?? "—"} — {i.b_name ?? "—"}
          </Link>
        </p>
      ) : null}
      <p className="prewrap">{i.message}</p>
      {i.escalation_note ? <p className="small muted prewrap">{i.escalation_note}</p> : null}
      <p className="small">
        {x.assignee}: {i.assigned_to ? <strong>@{i.assigned_to}</strong> : <span className="muted">{x.unassigned}</span>}
      </p>
      <div className="row">
        {i.assigned_to_id !== userId ? (
          <ActionForm action="incident.assign" lang={lang} back={back} hidden={{ incident: i.id, assignee: "me" }}>
            <button className="btn btn-ghost btn-sm">{x.takeIt}</button>
          </ActionForm>
        ) : null}
      </div>
      <ActionForm action="incident.resolve" lang={lang} back={back} hidden={{ incident: i.id }} className="inline-form">
        <input name="note" maxLength={500} placeholder={x.resolveNote} aria-label={x.resolveNote} />
        <button className="btn btn-primary btn-sm">{x.resolve}</button>
      </ActionForm>
      <details className="disclosure">
        <summary>{x.more}</summary>
        <div className="stack-sm">
          <ActionForm action="incident.assign" lang={lang} back={back} hidden={{ incident: i.id }} className="inline-form">
            <select name="assignee" defaultValue={i.assigned_to_id ?? ""} aria-label={x.assignee}>
              <option value="">{x.nobody}</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  @{s.username}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost btn-sm">{x.assign}</button>
          </ActionForm>
          <ActionForm action="incident.priority" lang={lang} back={back} hidden={{ incident: i.id }} className="inline-form">
            <select name="priority" defaultValue={i.priority} aria-label={x.priority}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {x.priorities[p]}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost btn-sm">{x.save}</button>
          </ActionForm>
          {!i.escalated_at ? (
            <ActionForm action="incident.escalate" lang={lang} back={back} hidden={{ incident: i.id }} className="inline-form">
              <input name="note" maxLength={500} placeholder={x.escalateNote} aria-label={x.escalateNote} />
              <button className="btn btn-danger btn-sm">{x.escalate}</button>
            </ActionForm>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/** The incident queue of a live event for its staff: open items with actions, a form to log one, recent closures. */
export function IncidentQueue({
  lang,
  tournamentId,
  queue,
  staff,
  matches,
  back,
  userId,
}: {
  lang: Locale;
  tournamentId: string;
  queue: { open: QueueItem[]; resolved: QueueItem[] };
  staff: { id: string; username: string }[];
  matches: { id: string; label: string }[];
  back: string;
  userId: string;
}) {
  const x = liveopsText[lang];
  const now = new Date();
  return (
    <section className="section-tight incident-queue" id="incidents">
      <div className="row-between">
        <h2 className="h3">
          {x.title} {queue.open.length ? <Badge status={queue.open.some((i) => i.priority === "urgent") ? "disputed" : "result_submitted"}>{queue.open.length}</Badge> : null}
        </h2>
      </div>
      <p className="small muted">{x.lead}</p>
      {queue.open.length ? (
        <ul className="list incident-list">
          {queue.open.map((i) => (
            <Item key={i.id} lang={lang} i={i} staff={staff} back={back} userId={userId} now={now} />
          ))}
        </ul>
      ) : (
        <p className="muted">{x.empty}</p>
      )}
      <details className="disclosure card">
        <summary>{x.newTitle}</summary>
        <ActionForm action="incident.open" lang={lang} back={back} hidden={{ tournament: tournamentId }} className="stack-sm">
          <div className="form-grid">
            <Field label={x.kind}>
              <select name="kind" defaultValue="technical">
                {STAFF_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {x.kinds[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={x.priority}>
              <select name="priority" defaultValue="normal">
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {x.priorities[p]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={x.match}>
            <select name="match" defaultValue="">
              <option value="">{x.noMatch}</option>
              {matches.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={x.message}>
            <textarea name="message" required minLength={3} maxLength={500} rows={2} />
          </Field>
          <button className="btn btn-primary btn-sm">{x.create}</button>
        </ActionForm>
      </details>
      {queue.resolved.length ? (
        <details className="disclosure">
          <summary>
            {x.resolvedTitle} ({queue.resolved.length})
          </summary>
          <ul className="list">
            {queue.resolved.map((i) => (
              <li key={i.id} className="stack-sm">
                <span className="small">
                  {x.kinds[i.kind]} · <LocalTime iso={i.resolved_at} lang={lang} withZone={false} /> · {x.resolvedBy} @{i.resolved_by}
                  {i.match_id ? (
                    <>
                      {" · "}
                      <Link href={`/${lang}/matches/${i.match_id}`} className="text-link">
                        {i.a_name ?? "—"} — {i.b_name ?? "—"}
                      </Link>
                    </>
                  ) : null}
                </span>
                <span className="small muted prewrap">
                  {i.message} → {i.resolution || x.noComment}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
