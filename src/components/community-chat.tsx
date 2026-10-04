"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { dict, type Locale } from "@/lib/i18n";
import type { CommunityMessage, RoomScope } from "@/server/community";
import { MemberAvatar } from "./member-avatar";
import { LocalTime } from "./time";
type Message = Omit<CommunityMessage, "created_at"> & { created_at: string };
export function CommunityChat({ lang, room, userId, initial }: { lang: Locale; room: RoomScope; userId: string; initial: Message[] }) {
  const T = (a: string, b: string) => lang === "ru" ? a : b;
  const [messages, setMessages] = useState(initial), [body, setBody] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [before, setBefore] = useState(0);
  const alive = useRef(true), revision = useRef(0), attempt = useRef<{ body: string; id: string } | null>(null);
  const request = useCallback(async (action: string, extra: Record<string, unknown> = {}) => {
    const sequence = ++revision.current;
    const r = await fetch("/api/community/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, scope: room.scope, id: room.id, before, ...extra }) });
    const data = await r.json();
    if (!r.ok) throw new Error((dict(lang).errors as Record<string, string>)[data.error] ?? dict(lang).errors.server_error);
    if (alive.current && sequence === revision.current) { setMessages(data.messages); setError(""); }
  }, [room.scope, room.id, before, lang]);
  useEffect(() => {
    alive.current = true; void request("read").catch(e => { if (alive.current) setError(e.message); });
    const interval = setInterval(() => { if (!document.hidden && !before) void request("read").catch(e => { if (alive.current) setError(e.message); }); }, 5000);
    return () => { alive.current = false; revision.current++; clearInterval(interval); };
  }, [request, before]);
  async function act(action: string, data: Record<string, unknown>) {
    if (busy) return; setBusy(true); setError("");
    try { await request(action, data); return true; } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : T("Не удалось выполнить действие", "Could not complete the action")); return false; }
    finally { if (alive.current) setBusy(false); }
  }
  return <div className="stack section-tight">
    {error && <p className="notice notice-warn" role="alert">{error}</p>}
    <div className="row wrap"><button className="btn btn-ghost btn-sm" onClick={() => void act("read", {})} disabled={busy}>{T("Обновить сообщения", "Refresh messages")}</button>{messages.length === 50 && <button className="btn btn-ghost btn-sm" onClick={() => setBefore(Number(messages[0].id))}>{T("Раньше", "Earlier")}</button>}{before > 0 && <button className="btn btn-secondary btn-sm" onClick={() => setBefore(0)}>{T("К новым сообщениям", "Latest messages")}</button>}</div>
    <ol className="list" aria-label={T("Сообщения комнаты", "Room messages")} aria-live="polite" style={{ minHeight: 120 }}>
      {messages.map(m => <li key={m.id} className="stack-sm" style={{ alignItems: "stretch" }}><div className="row"><MemberAvatar name={m.display_name} mediaId={m.avatar_media_id} /><Link href={`/${lang}/players/${m.username}`}><strong>{m.display_name}</strong> <small>@{m.username}</small></Link>{m.host_role && <span className="badge badge-info">{m.host_role === "host" ? T("Ведущая / ведущий", "Community host") : T("Специалист · профиль проверен", "Reviewed practitioner")}</span>}<small className="muted"><LocalTime iso={m.created_at} lang={lang} withZone={false} /></small></div><p className="prewrap" style={{ overflowWrap: "anywhere", margin: 0 }}>{m.body}</p>
        {m.sender_id === userId ? <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => void act("delete", { messageId: m.id })}>{T("Удалить своё сообщение", "Delete my message")}</button> : <details><summary>{T("Дружба и безопасность", "Connect & safety")}</summary><div className="row wrap"><Link className="btn btn-ghost btn-sm" href={`/${lang}/community?username=${m.username}#friends`}>{T("Добавить в друзья", "Add friend")}</Link><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act("block", { subject: m.sender_id })}>{T("Заблокировать участника", "Block member")}</button></div><form className="stack-sm" onSubmit={e => { e.preventDefault(); const form = e.currentTarget; void act("report", { messageId: m.id, reason: new FormData(form).get("reason") }).then(ok => { if (ok) form.reset(); }); }}><label className="field"><span>{T("Причина жалобы", "Report reason")}</span><textarea name="reason" required minLength={10} maxLength={1200} /></label><button className="btn btn-ghost btn-sm" disabled={busy}>{T("Передать сообщение модератору и заблокировать", "Report this message and block")}</button></form></details>}
      </li>)}
    </ol>
    {!messages.length && <p className="notice">{T("Пока тихо. Можно поздороваться и рассказать, во что хотите поиграть.", "It is quiet here. Say hello and share what you would like to play.")}</p>}
    <form className="card stack-sm" onSubmit={e => { e.preventDefault(); const text = body.trim(); if (!text) return; if (!attempt.current || attempt.current.body !== text) attempt.current = { body: text, id: crypto.randomUUID() }; void act("send", { body: text, clientId: attempt.current.id, before: 0 }).then(ok => { if (ok) { setBody(""); attempt.current = null; setBefore(0); } }); }}>
      <label className="field"><span>{T("Ваше сообщение", "Your message")}</span><textarea value={body} onChange={e => setBody(e.target.value)} required maxLength={1000} rows={3} disabled={busy} /></label><button className="btn btn-primary" disabled={busy || !body.trim()}>{busy ? T("Отправляем…", "Sending…") : T("Отправить в чат", "Send to chat")}</button><small className="muted">{T("До 1 000 символов. Личные и медицинские подробности лучше обсуждать в подходящем закрытом канале.", "Up to 1,000 characters. Use an appropriate private channel for personal or medical details.")}</small>
    </form>
  </div>;
}
