import type { Locale } from "@/lib/i18n.ts";
import { INPUT_LIMITS, STATS, type StatLine } from "@/server/scoring.ts";
import { ActionForm, Field } from "./ui";

type CorrectionEntry = StatLine & {
  id: string;
  registration_id: string;
  revision: number;
  review: string;
  match_ref: string;
  evidence_url: string;
};

/** Organisers can correct a rejected entry while the tournament runs, even after self-service closes. */
export function ScoreCorrectionForm({ lang, back, tournament, entry }: {
  lang: Locale;
  back: string;
  tournament: { id: string; status: string };
  entry: CorrectionEntry;
}) {
  if (tournament.status !== "IN_PROGRESS" || entry.review !== "rejected") return null;
  const ru = lang === "ru";
  const matchRef = entry.match_ref.trim();
  return (
    <details className="disclosure">
      <summary>{ru ? "Исправить результат" : "Correct result"}</summary>
      <ActionForm action="score.log" lang={lang} back={back} className="stack-sm" hidden={{
        tournament: tournament.id,
        registration: entry.registration_id,
        correction: `${entry.id}:${entry.revision}`,
      }}>
        <p className="small muted">{ru ? "Исправленный результат будет отправлен на повторную проверку." : "The corrected result will be submitted for review again."}</p>
        <div className="form-grid">
          {STATS.map((stat) => (
            <Field key={stat} label={stat}>
              <input name={stat} type="number" min={0} max={INPUT_LIMITS[stat]} defaultValue={entry[stat]} required />
            </Field>
          ))}
          <Field label={ru ? "Место" : "Placement"}>
            <select name="placement" defaultValue={entry.placement ?? ""}>
              <option value="">—</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </select>
          </Field>
          <Field label={ru ? "ID матча" : "Match ID"}>
            <input name="matchRef" maxLength={80} defaultValue={matchRef} readOnly={Boolean(matchRef)} required />
          </Field>
        </div>
        <Field label={ru ? "Ссылка на доказательство" : "Evidence URL"} hint={ru ? "Для новых ссылок используйте HTTPS." : "Use HTTPS for new links."}>
          <input name="evidence" type="url" maxLength={500} defaultValue={entry.evidence_url} />
        </Field>
        <Field label={ru ? "Причина исправления" : "Correction reason"}>
          <input name="correctionReason" required minLength={5} maxLength={500} />
        </Field>
        <button className="btn btn-primary btn-sm">{ru ? "Отправить исправление" : "Submit correction"}</button>
      </ActionForm>
    </details>
  );
}
