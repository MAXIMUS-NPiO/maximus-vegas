import Link from "next/link";
import type { Locale } from "@/lib/i18n.ts";
import { transferText } from "@/lib/transfer-text.ts";
import type { HistoryRow, TransferRow } from "@/server/transfers.ts";
import { ActionForm, Badge, Field } from "@/components/ui";
import { LocalTime } from "@/components/time";

/** A team's transfers (proposals, consents, disputes) and its roster history. */
export function TeamTransfers({
  lang,
  teamId,
  transfers,
  history,
  viewerId,
  leader,
  leadsTeam,
  back,
}: {
  lang: Locale;
  teamId: string;
  transfers: TransferRow[];
  history: HistoryRow[];
  viewerId: string | null;
  /** The viewer is this team's owner or captain. */
  leader: boolean;
  /** Team ids the viewer leads (for the other side of a transfer). */
  leadsTeam: string[];
  back: string;
}) {
  const x = transferText[lang];
  const answer = (t: TransferRow, a: "accept" | "decline" | "cancel", label: string, primary = false) => (
    <ActionForm action="transfer.answer" lang={lang} back={back} hidden={{ transfer: t.id, answer: a }}>
      <button className={`btn ${primary ? "btn-primary" : "btn-ghost"} btn-xs`}>{label}</button>
    </ActionForm>
  );
  const party = (t: TransferRow) => viewerId === t.player_id || leadsTeam.includes(t.from_team) || leadsTeam.includes(t.to_team);
  // Negotiations stay between the parties; a transfer that happened is public roster history.
  const shown = transfers.filter((t) => t.status === "completed" || t.status === "reversed" || party(t));
  return (
    <section className="section-tight" id="transfers">
      <h2 className="h3">{x.transfers}</h2>
      <p className="small muted">{x.lead}</p>
      {shown.length ? (
        <ul className="list">
          {shown.map((t) => {
            const incoming = t.to_team === teamId;
            const mineAsPlayer = viewerId === t.player_id;
            const iRelease = leadsTeam.includes(t.from_team) && !mineAsPlayer;
            const iReceive = leadsTeam.includes(t.to_team);
            return (
              <li key={t.id} className="stack-sm">
                <div className="row-between">
                  <span>
                    <Link href={`/${lang}/players/${t.player}`}>{t.player_name}</Link> <span className="small muted">@{t.player}</span> · {x.from}{" "}
                    <Link href={`/${lang}/teams/${t.from_slug}`}>{t.from_name}</Link> {x.to} <Link href={`/${lang}/teams/${t.to_slug}`}>{t.to_name}</Link>
                  </span>
                  <Badge status={t.status === "completed" ? "ok" : t.status === "proposed" ? "warn" : "muted"}>{x.statuses[t.status]}</Badge>
                </div>
                {t.note && party(t) ? <p className="small muted prewrap">{t.note}</p> : null}
                {t.status === "proposed" ? (
                  <p className="small muted">
                    {t.player_ok_at ? x.playerOk : null}
                    {t.player_ok_at && t.from_ok_at ? " · " : null}
                    {t.from_ok_at ? x.teamOk : null}
                    {!t.player_ok_at && !t.from_ok_at ? x.waiting : null} · {x.until} <LocalTime iso={t.expires_at} lang={lang} />
                  </p>
                ) : t.completed_at ? (
                  <p className="small muted">
                    <LocalTime iso={t.completed_at} lang={lang} />
                  </p>
                ) : null}
                {t.status === "proposed" ? (
                  <div className="row">
                    {mineAsPlayer && !t.player_ok_at ? (
                      <>
                        <span className="small">{x.offerToYou}</span>
                        {answer(t, "accept", x.accept, true)}
                        {answer(t, "decline", x.decline)}
                      </>
                    ) : null}
                    {iRelease && !t.from_ok_at ? (
                      <>
                        <span className="small">{x.needYou}</span>
                        {answer(t, "accept", x.accept, true)}
                        {answer(t, "decline", x.decline)}
                      </>
                    ) : null}
                    {iReceive && incoming ? answer(t, "cancel", x.cancel) : null}
                  </div>
                ) : null}
                {t.dispute_status ? (
                  <p className="small">
                    <Badge status={t.dispute_status === "open" ? "warn" : "muted"}>
                      {t.dispute_status === "open" ? x.disputeOpen : t.dispute_status === "reversed" ? x.disputeReversed : x.disputeUpheld}
                    </Badge>
                  </p>
                ) : t.disputable && party(t) ? (
                  <details className="disclosure">
                    <summary>{x.dispute}</summary>
                    <ActionForm action="transfer.dispute" lang={lang} back={back} hidden={{ transfer: t.id }} className="stack-sm">
                      <Field label={x.disputeReason}>
                        <textarea name="reason" required minLength={20} maxLength={2000} rows={2} />
                      </Field>
                      <button className="btn btn-ghost btn-sm">{x.dispute}</button>
                    </ActionForm>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="small muted">{x.none}</p>
      )}
      {leader ? (
        <details className="disclosure card">
          <summary>{x.propose}</summary>
          <ActionForm action="transfer.propose" lang={lang} back={back} hidden={{ team: teamId }} className="stack-sm">
            <div className="form-grid">
              <Field label={x.player}>
                <input name="username" required minLength={3} maxLength={24} />
              </Field>
              <Field label={x.note}>
                <input name="note" maxLength={300} />
              </Field>
            </div>
            <button className="btn btn-primary btn-sm">{x.send}</button>
          </ActionForm>
        </details>
      ) : null}

      <h3 className="h4" id="history">
        {x.history}
      </h3>
      {history.length ? (
        <ul className="list small">
          {history.slice(0, 30).map((h, i) => (
            <li key={i}>
              <span className="grow">
                <Link href={`/${lang}/players/${h.username}`}>{h.display_name}</Link> — {x.events[h.event] ?? h.event}
              </span>
              <span className="muted">
                <LocalTime iso={h.at} lang={lang} dateOnly />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">{x.noHistory}</p>
      )}
    </section>
  );
}
