import Link from "next/link";
import type { Locale } from "@/lib/i18n.ts";
import { actionText, gameDayText } from "@/lib/gameday-text.ts";
import type { RefereeCall } from "@/server/gameday.ts";
import { ANSWER_MINUTES } from "@/server/liveops.ts";
import { liveopsText } from "@/lib/liveops-text.ts";
import { ActionForm, Badge, Field } from "@/components/ui";
import { LocalTime } from "@/components/time";

/** A side's view of its referee calls for one match: the open call, the last reply, and the form to call. */
export function CallBlock({ lang, matchId, calls, open, canCall, back }: { lang: Locale; matchId: string; calls: RefereeCall[]; open: boolean; canCall: boolean; back: string }) {
  const g = gameDayText[lang];
  const pending = calls.find((c) => c.status === "open");
  const answered = calls.find((c) => c.status === "resolved");
  return (
    <div className="stack-sm" id={`call-${matchId}`}>
      <p className="field-label">{g.referee}</p>
      {pending ? (
        <p className="small">
          <Badge status="pending">{g.callOpen}</Badge> <LocalTime iso={pending.created_at} lang={lang} />
        </p>
      ) : null}
      {pending ? <p className="small muted prewrap">{pending.message}</p> : null}
      {pending && pending.escalated_at ? <p className="small">{liveopsText[lang].escalatedNote}</p> : null}
      {pending && !pending.escalated_at && canCall && Date.now() - new Date(pending.created_at).getTime() > ANSWER_MINUTES * 60_000 ? (
        <ActionForm action="match.call" lang={lang} back={back} hidden={{ match: matchId, message: pending.message }}>
          <p className="small muted">{liveopsText[lang].remindNote}</p>
          <button className="btn btn-ghost btn-sm">{liveopsText[lang].remind}</button>
        </ActionForm>
      ) : null}
      {answered && (!pending || answered.resolved_at! > pending.created_at) ? (
        <p className="small prewrap">
          <strong>{g.callReply}:</strong> {answered.resolution || g.callNoComment}
        </p>
      ) : null}
      {!pending && canCall ? (
        <details className="disclosure" open={open}>
          <summary>{actionText("call_referee", lang)}</summary>
          <ActionForm action="match.call" lang={lang} back={back} hidden={{ match: matchId }} className="stack-sm">
            <Field label={g.callLabel} hint={g.callHint}>
              <textarea name="message" required minLength={3} maxLength={500} rows={2} />
            </Field>
            <button className="btn btn-primary btn-sm">{actionText("call_referee", lang)}</button>
          </ActionForm>
        </details>
      ) : null}
    </div>
  );
}

/** Staff view: open calls of a match with a reply that closes each one. */
export function OpenCalls({
  lang,
  calls,
  back,
  sideNames = {},
  gameDayLink = false,
}: {
  lang: Locale;
  calls: RefereeCall[];
  back: string;
  sideNames?: { a?: string; b?: string };
  gameDayLink?: boolean;
}) {
  const g = gameDayText[lang];
  const open = calls.filter((c) => c.status === "open");
  return (
    <div className="stack-sm">
      <p className="field-label">{g.staffCalls}</p>
      {open.length ? (
        open.map((c) => (
          <div key={c.id} className="stack-sm">
            <p className="small">
              <Badge status="pending">{g.callOpen}</Badge> @{c.opened_by}
              {c.side ? ` · ${sideNames[c.side] ?? `${g.side} ${c.side.toUpperCase()}`}` : ""} · <LocalTime iso={c.created_at} lang={lang} />
            </p>
            <p className="prewrap">{c.message}</p>
            <ActionForm action="match.call_close" lang={lang} back={back} hidden={{ call: c.id }} className="stack-sm">
              <Field label={g.staffReply}>
                <textarea name="note" maxLength={500} rows={2} />
              </Field>
              <button className="btn btn-ghost btn-sm">{g.staffClose}</button>
            </ActionForm>
          </div>
        ))
      ) : (
        <p className="small muted">{g.staffEmpty}</p>
      )}
      {gameDayLink ? (
        <Link href={`/${lang}/gameday`} className="text-link small">
          {g.title}
        </Link>
      ) : null}
    </div>
  );
}
