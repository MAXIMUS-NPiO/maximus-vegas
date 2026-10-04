"use client";

import Link from "next/link";
import { useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { dict, type Locale } from "@/lib/i18n.ts";

type Team = { id: string; name: string };
type Result = { id: string; email: string | null; username: string | null; deliveryStatus: string; status: string; mailConfigured: boolean; reused: boolean };

/** One recipient, one explicit send; failed requests retain every field and the retry identity. */
export function InvitationComposer({ lang, teams, initialTeam, initialUsername = "", initialChannel, emailConfigured }: {
  lang: Locale; teams: Team[]; initialTeam?: string; initialUsername?: string; initialChannel?: "email" | "site"; emailConfigured: boolean;
}) {
  const ru = lang === "ru", T = (a: string, b: string) => ru ? a : b, router = useRouter();
  const emailHintId = useId();
  const [teamId, setTeamId] = useState(initialTeam ?? teams[0]?.id ?? "");
  const [mode, setMode] = useState<"email" | "site">(initialChannel ?? (initialUsername ? "site" : "email"));
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState(initialUsername);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const request = useRef<{ key: string; id: string } | null>(null);
  const team = teams.find(t => t.id === teamId);
  const edited = () => { setError(""); setResult(null); };
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || result) return;
    const payload = { teamId, username: username.trim(), email: mode === "email" ? email.trim() : "", lang };
    const key = JSON.stringify(payload);
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/team-invitations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, requestId: request.current.id }) });
      const data = await response.json();
      if (!response.ok) {
        const errors = dict(lang).errors as Record<string, string>;
        setError(errors[String(data.error)] ?? T("Приглашение не отправлено. Проверьте данные и попробуйте ещё раз.", "Invitation not sent. Check the details and try again."));
        return;
      }
      if (!data.invitation || typeof data.invitation.id !== "string") throw new Error("Invalid response");
      setResult(data.invitation); router.refresh();
    } catch {
      setError(T("Не удалось получить ответ. Данные сохранены в форме. Повторите отправку: повторное приглашение не создастся.", "The response was interrupted. Your details remain here. Retry safely: a duplicate invitation will not be created."));
    } finally { setBusy(false); }
  }
  if (!teams.length) return <div className="stack-sm"><p>{T("Для приглашения выберите свою команду. Приглашать могут владелец и капитан.", "Choose a team you lead to invite players. Owners and captains can send invitations.")}</p><Link className="btn btn-primary" href={`/${lang}/teams/new`}>{T("Создать свою команду", "Create your team")}</Link></div>;
  return <form method="post" action={`/api/a/team.invite?lang=${lang}`} onSubmit={send} className="stack" data-invitation-composer="true">
    <input type="hidden" name="lang" value={lang} /><input type="hidden" name="back" value={`/${lang}/my-teams`} />
    <fieldset disabled={busy} className="invitation-fields stack">
      <label className="field"><span className="field-label">{T("В какую команду", "Choose your team")}</span><select name="team" required value={teamId} onChange={e => { setTeamId(e.target.value); edited(); }}>{teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <fieldset className="invitation-fields stack-sm"><legend className="field-label">{T("Куда отправить приглашение", "Where to send the invitation")}</legend><div className="row wrap">
        <label className="row"><input type="radio" name="delivery" value="email" checked={mode === "email"} onChange={() => { setMode("email"); edited(); }} />{T("На email", "By email")}</label>
        <label className="row"><input type="radio" name="delivery" value="site" checked={mode === "site"} onChange={() => { setMode("site"); edited(); }} />{T("Игроку на сайте", "To a player on this site")}</label>
      </div></fieldset>
      {mode === "email" && <label className="field"><span className="field-label">{T("Email получателя", "Recipient email")}</span><input name="email" type="email" aria-label={T("Email получателя", "Recipient email")} aria-describedby={emailHintId} autoComplete="off" required maxLength={254} value={email} onChange={e => { setEmail(e.target.value); edited(); }} placeholder="player@example.com" /><span className="field-hint" id={emailHintId}>{T("Приглашение адресовано только этому человеку. Для вступления он подтвердит этот email.", "This invitation is addressed to this person. They will verify this email before joining.")}</span></label>}
      <label className="field"><span className="field-label">{mode === "site" ? T("Имя игрока на MAXIMUS VEGAS", "Player username on MAXIMUS VEGAS") : T("Ник для игрока · необязательно", "Player username · optional")}</span><input name="username" value={username} onChange={e => { setUsername(e.target.value); edited(); }} required={mode === "site"} pattern="@?[A-Za-z0-9_]{3,24}" maxLength={25} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="@player_name" /><span className="field-hint">{mode === "site" ? T("Существующий игрок увидит приглашение в своём кабинете. Для нового игрока выберите email.", "An existing player will see the invitation in their hub. Choose email for a new player.") : T("Свободный ник зарезервируем на 7 дней одновременно с приглашением. Можно оставить пустым — игрок выберет сам.", "An available username is reserved for 7 days together with the invitation. Leave it blank to let the player choose.")}</span></label>
    </fieldset>
    <div className="notice invitation-preview" aria-live="polite"><strong>{T("Проверка перед отправкой", "Review before sending")}</strong><p>{T("Команда", "Team")}: <b>{team?.name}</b><br />{T("Получатель", "Recipient")}: <b>{mode === "email" ? email.trim() || T("укажите email выше", "enter an email above") : username.trim() || T("укажите имя выше", "enter a username above")}</b>{mode === "email" && username.trim() ? <><br />{T("Ник", "Username")}: {username.trim()}</> : null}</p></div>
    {mode === "email" && !emailConfigured && <p className="notice notice-warn" role="status">{T("Почтовая отправка пока не подключена. Приглашение сохранится в очереди с указанным адресом; письмо ещё не уйдёт. Статус будет виден в списке приглашений.", "Email delivery is not connected yet. The invitation will be queued for this address; no email will be sent yet. You can see its status in your invitation list.")}</p>}
    {error && <p className="notice notice-warn" role="alert">{error}</p>}
    {result ? <div className="notice stack-sm" role="status"><strong>{result.status !== "pending" ? ({ accepted: T("Игрок уже принял приглашение", "The player already accepted"), declined: T("Игрок отклонил приглашение", "The player declined"), revoked: T("Приглашение отозвано", "Invitation revoked"), expired: T("Срок приглашения истёк", "Invitation expired") } as Record<string,string>)[result.status] ?? T("Приглашение закрыто", "Invitation closed") : result.deliveryStatus === "failed" ? T("Ошибка отправки: приглашение сохранено", "Sending failed: the invitation is saved") : result.deliveryStatus === "site_notification" ? T("Приглашение появилось в кабинете игрока", "Invitation added to the player's hub") : result.deliveryStatus === "service_accepted" ? T("Почтовый сервис принял письмо", "Email service accepted the message") : T("Приглашение сохранено в очереди отправки", "Invitation saved in the sending queue")}</strong><p>{result.email ?? `@${result.username}`} · {team?.name}</p>{result.email && <p className="small">{T("Получение письма человеком пока не подтверждено. Отдельно покажем, когда игрок примет приглашение.", "The recipient has not confirmed receipt. The list will show when the player accepts the invitation.")}</p>}<Link className="text-link" href={`/${lang}/my-teams#delivery-${result.id}`}>{T("Открыть статус приглашения", "View invitation status")} <span aria-hidden="true">→</span></Link><button type="button" className="btn btn-ghost btn-sm" onClick={() => { setResult(null); setEmail(""); setUsername(""); request.current = null; }}>{T("Пригласить ещё игрока", "Invite another player")}</button></div> : <button className="btn btn-primary" disabled={busy} type="submit">{busy ? T("Сохраняем приглашение…", "Saving invitation…") : mode === "email" ? emailConfigured ? T("Отправить приглашение на email", "Send invitation by email") : T("Сохранить приглашение в очередь", "Queue this invitation") : T("Отправить приглашение игроку", "Send invitation to player")}</button>}
  </form>;
}
