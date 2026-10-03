"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { dict, type Locale } from "@/lib/i18n.ts";
export function HostControl({ hostId, lang, approved }: { hostId: string; lang: Locale; approved: boolean }) {
  const T = (ru: string, en: string) => lang === "ru" ? ru : en, router = useRouter();
  const [online, setOnline] = useState(false), [message, setMessage] = useState(""), [key, setKey] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const call = async (action: string, extra: Record<string, unknown>) => { const r = await fetch("/api/p2p", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id: hostId, ...extra }) }); const data = await r.json(); if (!r.ok) throw new Error(dict(lang).errors[data.error] ?? T("Не удалось выполнить запрос", "Request failed")); return data; };
  useEffect(() => {
    if (!online) return;
    let active = true, pending = false;
    const beat = async () => { if (pending) return; pending = true; try { const r = await fetch("/api/p2p", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "host.beat", id: hostId, online: true }) }); if (!r.ok) throw new Error(); if (active) router.refresh(); } catch { if (active) { setOnline(false); setMessage(T("Связь с порталом потеряна. Включите доступность после восстановления связи.", "Portal connection lost. Enable availability again after reconnecting.")); } } finally { pending = false; } };
    void beat(); const timer = setInterval(beat, 10_000); return () => { active = false; clearInterval(timer); };
  }, [online, hostId, lang, router]);
  const toggle = async () => { setBusy(true); try { await call("host.beat", { online: !online }); setOnline(!online); router.refresh(); } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); } };
  const rotate = async (revoke: boolean) => { setBusy(true); try { const r = await call("host.key", { revoke }); setKey(r.token); setOnline(false); setMessage(revoke ? T("Ключ отозван", "Key revoked") : T("Ключ показан один раз. Сохраните его на своей машине; не передавайте игрокам.", "Key is shown once. Store it on your machine; never share it with players.")); } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); } };
  return <section className="card"><h2>{T("Браузерный хост", "Browser host")}</h2><p>{T("Держите эту вкладку открытой, пока принимаете запросы. При потере связи хост исчезнет из доступных в течение 45 секунд.", "Keep this tab open while accepting requests. After connection loss, the host leaves the available list within 45 seconds.")}</p><button className="btn btn-primary" disabled={!approved || busy} onClick={toggle}>{online ? T("Стать недоступным и завершить сеанс", "Go offline and end session") : T("Принимать подключения", "Accept connections")}</button>
    <details className="section-tight"><summary>{T("Подключить собственный хост-агент", "Connect a native host agent")}</summary><p>{T("Агент использует отдельный ключ этой машины. Перевыпуск отзывает предыдущий ключ. Запускайте агент только на выделенном игровом окружении.", "The agent uses a key scoped to this host. Rotation revokes the previous key. Run the agent only in a dedicated gaming environment.")}</p><div className="row"><button className="btn btn-ghost" disabled={!approved || busy} onClick={() => rotate(false)}>{T("Создать или заменить ключ", "Create or rotate key")}</button><button className="btn btn-ghost" disabled={!approved || busy} onClick={() => rotate(true)}>{T("Отозвать ключ", "Revoke key")}</button></div>{key && <label className="field"><span>{T("Ключ агента — скопируйте сейчас", "Agent key — copy now")}</span><input readOnly type="password" value={key} autoComplete="off" onFocus={e => e.currentTarget.select()} /></label>}</details>{message && <p className="notice" role="status">{message}</p>}
  </section>;
}
