"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Locale } from "@/lib/i18n.ts";
import { coarseCell, NEARBY_CONSENT, type NearbyStatus } from "@/lib/nearby.ts";

export function SocialNearby({ lang, initial }: { lang: Locale; initial: NearbyStatus }) {
  const T = (ru: string, en: string) => lang === "ru" ? ru : en;
  const router = useRouter(), [status, setStatus] = useState(initial), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), generation = useRef(0), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => { setStatus(initial); }, [initial]);

  async function api(data: Record<string, unknown>): Promise<NearbyStatus> {
    const response = await fetch("/api/social/nearby", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), signal: AbortSignal.timeout(12000) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error ?? "server_error"); return value;
  }
  function failed(error: unknown) {
    const code = error instanceof Error ? error.message : "";
    setMessage(code === "permission_denied" ? T("Доступ к местоположению запрещён. Можно продолжить поиск по городу или разрешить доступ в настройках браузера.", "Location permission was denied. Search by city or allow access in your browser settings.")
      : code === "request_state" ? T("Настройки изменились в другой вкладке. Обновите страницу перед повторным включением.", "Settings changed in another tab. Reload before enabling again.")
      : code === "request_limit" ? T("Местоположение можно обновлять раз в час. Отключить его можно сейчас.", "Location can be updated once an hour. You can disable it now.")
      : code === "maintenance" || code === "feature_disabled" ? T("Новый подбор временно недоступен. Удаление местоположения продолжает работать.", "New discovery is temporarily unavailable. You can still delete your location.")
      : T("Не удалось подтвердить изменение. Проверьте соединение и повторите или обновите страницу. Поиск по городу остаётся доступен.", "Could not confirm the change. Check your connection and retry or reload. City search remains available."));
  }
  async function enable() {
    if (!consent || busy) return;
    if (!navigator.geolocation || !window.isSecureContext) { setMessage(T("Этот браузер не предоставляет местоположение. Используйте поиск по городу.", "Location is unavailable in this browser. Use city search.")); return; }
    const attempt = ++generation.current, revision = status.revision;
    setBusy(true); setMessage(T("Запрашиваем местоположение…", "Requesting location…"));
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, e => reject(new Error(e.code === 1 ? "permission_denied" : "location_unavailable")), { enableHighAccuracy: false, timeout: 15000, maximumAge: 0 }));
      if (!alive.current || generation.current !== attempt) return;
      if (!Number.isFinite(position.coords.accuracy) || position.coords.accuracy > 20000) throw new Error("location_unavailable");
      const cell = coarseCell(position.coords.latitude, position.coords.longitude);
      const value = await api({ action: "enable", consent: NEARBY_CONSENT, revision, ...cell });
      if (!alive.current || generation.current !== attempt) return;
      setStatus(value); setConsent(false); setMessage(T("Поиск поблизости включён на семь дней. Выберите радиус ниже.", "Nearby discovery is enabled for seven days. Choose a radius below.")); router.refresh();
    } catch (error) { if (alive.current && generation.current === attempt) failed(error); }
    finally { if (alive.current && generation.current === attempt) setBusy(false); }
  }
  async function disable() {
    // Invalidate pending geolocation callbacks and server uploads, including those in another tab.
    const attempt = ++generation.current; setBusy(true); setMessage(T("Удаляем местоположение…", "Deleting location…"));
    try {
      const value = await api({ action: "disable" });
      if (!alive.current || generation.current !== attempt) return;
      setStatus(value); setConsent(false); setMessage(T("Местоположение удалено. Поиск поблизости отключён.", "Location deleted. Nearby discovery is off.")); router.refresh();
    } catch (error) { if (alive.current && generation.current === attempt) failed(error); }
    finally { if (alive.current && generation.current === attempt) setBusy(false); }
  }
  return <section className="card section-tight" aria-labelledby="nearby-title" data-nearby>
    <h2 id="nearby-title">{T("Игроки поблизости", "Players nearby")}</h2>
    <p>{status.active ? T("Подбор включён", "Discovery is enabled") : T("Подбор отключён", "Discovery is off")}{status.active && status.expiresAt ? ` · ${T("до", "until")} ${new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(status.expiresAt))} (UTC)` : ""}.</p>
    <p className="small muted">{T("Браузер округляет координаты до 0,1° перед отправкой (около 11 км по широте). Для подбора используем одну текущую область в течение семи дней, без истории перемещений. Другим участникам показывается подходящий профиль, без координат и расстояния. Радиус приблизительный; у границы результаты могут отличаться. Обновление — раз в час, удаление — в любой момент.", "Your browser rounds coordinates to 0.1° before sending them (about 11 km in latitude). Only the current area is used for matching for seven days, without movement history. Others see a matching profile, without coordinates or distance. Radius matching is approximate and may differ near its boundary. Update once an hour; delete at any time.")}</p>
    <label className="check"><input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} /> <span>{T("Разрешаю использовать округлённое местоположение для взаимного поиска поблизости", "Allow my rounded location to be used for mutual nearby discovery")} ({NEARBY_CONSENT})</span></label>
    <div className="row section-tight"><button type="button" className="btn btn-primary" disabled={!consent || busy} onClick={() => void enable()}>{status.active ? T("Обновить местоположение", "Update location") : T("Включить поиск поблизости", "Enable nearby discovery")}</button>
      <button type="button" className="btn btn-ghost" onClick={() => void disable()}>{T("Удалить местоположение и отключить", "Delete location and disable")}</button></div>
    <p className="small" role="status" aria-live="polite">{message}</p>
  </section>;
}
