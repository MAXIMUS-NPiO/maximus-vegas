import Link from "next/link";
import type { Locale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { challengeStatus } from "@/lib/labels.ts";
import { ActionForm, Badge, Empty, Field } from "./ui";
import { LocalTime } from "./time";

type Item = {
  id: string;
  kind: string;
  game: string;
  status: string;
  message: string;
  challenger: string;
  opponent: string;
  challenger_id: string;
  opponent_id: string;
  challenger_name: string;
  opponent_name: string;
  reported_by: string | null;
  reported_winner: string | null;
  winner_id: string | null;
  score_challenger: number | null;
  score_opponent: number | null;
  evidence_url: string;
  expires_at: Date;
  created_at: Date;
  /** The viewer's side in a quick match with parties (`a` is the challenger's side) and the players per side. */
  my_side?: "a" | "b";
  side_size?: number;
};

export function ChallengeList({ lang, list, userId, back }: { lang: Locale; list: Item[]; userId: string; back: string }) {
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  if (!list.length) return <Empty title={T("Пока пусто", "Nothing yet")} />;
  return (
    <ul className="list challenge-list">
      {list.map((c) => {
        const mine = (c.my_side ?? (c.challenger_id === userId ? "a" : "b")) === "a";
        // Only the named players (the two leaders in a party match) report, confirm, dispute and cancel.
        const leader = c.challenger_id === userId || c.opponent_id === userId;
        const size = c.side_size ?? 1;
        const party = size > 1 ? T(" и группа", " and party") : "";
        const otherName = mine ? c.opponent_name : c.challenger_name;
        const otherUser = mine ? c.opponent : c.challenger;
        const hidden = { challenge: c.id };
        const winnerName = c.winner_id ? (c.winner_id === c.challenger_id ? c.challenger_name : c.opponent_name) + party : null;
        const reportedName = c.reported_winner ? (c.reported_winner === c.challenger_id ? c.challenger_name : c.opponent_name) + party : null;
        return (
          <li key={c.id} className="stack-sm">
            <div className="row-between">
              <span>
                <strong>{gameBySlug(c.game)?.name ?? c.game}</strong> · {T("против", "vs")}{" "}
                <Link href={`/${lang}/players/${otherUser}`} className="text-link">
                  {otherName}
                </Link>
                {party}
                {c.kind === "quick" ? <span className="badge badge-info">{T("Быстрый матч", "Quick match")}</span> : null}
                {size > 1 ? <span className="badge">{`${size} ${T("на", "v")} ${size}`}</span> : null}
              </span>
              <Badge status={c.status === "completed" ? "ok" : c.status === "disputed" ? "bad" : ["pending", "reported"].includes(c.status) ? "warn" : c.status === "accepted" ? "live" : "muted"}>
                {challengeStatus(c.status, lang)}
              </Badge>
            </div>
            {c.message ? <p className="small muted prewrap">{c.message}</p> : null}
            {c.status === "completed" && winnerName ? (
              <p className="small">
                {T("Победитель", "Winner")}: <strong>{winnerName}</strong>
                {c.score_challenger !== null && c.score_opponent !== null ? ` · ${c.score_challenger} : ${c.score_opponent}` : ""}
              </p>
            ) : null}
            {["pending", "accepted"].includes(c.status) ? (
              <p className="small muted">
                {T("Действует до", "Open until")} <LocalTime iso={c.expires_at} lang={lang} />
              </p>
            ) : null}
            {!leader && ["accepted", "reported", "disputed"].includes(c.status) ? (
              <p className="small muted">{T("Результат отправляет и подтверждает лидер группы.", "The party leader reports and confirms the result.")}</p>
            ) : null}
            <div className="row">
              {leader && c.status === "pending" && !mine ? (
                <>
                  <ActionForm action="challenge.respond" lang={lang} back={back} hidden={{ ...hidden, accept: "1" }}>
                    <button className="btn btn-primary btn-xs">{T("Принять", "Accept")}</button>
                  </ActionForm>
                  <ActionForm action="challenge.respond" lang={lang} back={back} hidden={{ ...hidden, accept: "0" }}>
                    <button className="btn btn-ghost btn-xs">{T("Отклонить", "Decline")}</button>
                  </ActionForm>
                </>
              ) : null}
              {leader && ((c.status === "pending" && mine) || (c.status === "accepted" && c.kind === "quick")) ? (
                <ActionForm action="challenge.cancel" lang={lang} back={back} hidden={hidden}>
                  <button className="btn btn-ghost btn-xs">{T("Отменить", "Cancel")}</button>
                </ActionForm>
              ) : null}
              {leader && c.status === "reported" && c.reported_by !== userId ? (
                <>
                  <span className="small">
                    {T("Соперник сообщил: победил", "Opponent reports the winner as")} <strong>{reportedName}</strong>
                  </span>
                  <ActionForm action="challenge.confirm" lang={lang} back={back} hidden={hidden}>
                    <button className="btn btn-primary btn-xs">{T("Подтвердить", "Confirm")}</button>
                  </ActionForm>
                  <details className="disclosure">
                    <summary>{T("Оспорить", "Dispute")}</summary>
                    <ActionForm action="challenge.dispute" lang={lang} back={back} hidden={hidden} className="inline-form">
                      <input name="reason" required minLength={5} maxLength={600} placeholder={T("Что не так", "What is wrong")} aria-label={T("Причина", "Reason")} />
                      <button className="btn btn-danger btn-xs">{T("Оспорить", "Dispute")}</button>
                    </ActionForm>
                  </details>
                </>
              ) : null}
              {leader && c.status === "reported" && c.reported_by === userId ? <span className="small muted">{T("Ждём подтверждения соперника.", "Waiting for the opponent to confirm.")}</span> : null}
            </div>
            {leader && c.status === "accepted" ? (
              <details className="disclosure">
                <summary>{T("Сообщить результат", "Report the result")}</summary>
                <ActionForm action="challenge.report" lang={lang} back={back} hidden={hidden} className="stack">
                  <Field label={T("Итог", "Outcome")}>
                    <select name="result" required>
                      <option value="won">{size > 1 ? T("Мы победили", "We won") : T("Я победил", "I won")}</option>
                      <option value="lost">{size > 1 ? T("Мы проиграли", "We lost") : T("Я проиграл", "I lost")}</option>
                    </select>
                  </Field>
                  <div className="score-inputs">
                    <Field label={T("Мой счёт", "My score")} hint={T("необязательно", "optional")}>
                      <input name="myScore" type="number" min={0} max={999} inputMode="numeric" />
                    </Field>
                    <Field label={T("Счёт соперника", "Opponent's score")} hint={T("необязательно", "optional")}>
                      <input name="theirScore" type="number" min={0} max={999} inputMode="numeric" />
                    </Field>
                  </div>
                  <Field label={T("Доказательство", "Evidence")} hint={T("ссылка, необязательно", "link, optional")}>
                    <input name="evidence" type="url" maxLength={500} placeholder="https://" />
                  </Field>
                  <button className="btn btn-primary btn-sm">{T("Отправить", "Submit")}</button>
                </ActionForm>
              </details>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
