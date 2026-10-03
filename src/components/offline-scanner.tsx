"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { dict, type Locale } from "@/lib/i18n.ts";
type Manifest = { id: string; created_at: string; expires_at: string; passes: Array<{ id: string; token_hash: string; valid_from: string; valid_until: string }> };
type Scan = { id: string; token: string; observedAt: string; result?: string };
type Detector = { detect(video: HTMLVideoElement): Promise<Array<{ rawValue: string }>> };
export function OfflineScanner({ venueId, userId, lang }: { venueId: string; userId: string; lang: Locale }) {
  const T = (ru: string, en: string) => lang === "ru" ? ru : en;
  const key = `mv-checkin:${userId}:${venueId}`, [manifest, setManifest] = useState<Manifest | null>(null), [scans, setScans] = useState<Scan[]>([]), [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [online, setOnline] = useState(true), [camera, setCamera] = useState(false);
  const video = useRef<HTMLVideoElement>(null), stream = useRef<MediaStream | null>(null), cameraTimer = useRef<ReturnType<typeof setInterval> | null>(null), captureBusy = useRef(false);
  const stopCamera = () => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; if (cameraTimer.current) clearInterval(cameraTimer.current); cameraTimer.current = null; setCamera(false); };
  useEffect(() => {
    setOnline(navigator.onLine);
    const update = () => setOnline(navigator.onLine); window.addEventListener("online", update); window.addEventListener("offline", update);
    try { const saved = JSON.parse(localStorage.getItem(key) || "null"); if (saved && Date.now() < new Date(saved.manifest.expires_at).getTime() + 24 * 3600_000) { setManifest(saved.manifest); setScans(saved.scans); } else localStorage.removeItem(key); } catch { localStorage.removeItem(key); }
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); stream.current?.getTracks().forEach(t => t.stop()); if (cameraTimer.current) clearInterval(cameraTimer.current); };
  }, [key]);
  const save = (m: Manifest | null, s: Scan[]) => { setManifest(m); setScans(s); if (m) localStorage.setItem(key, JSON.stringify({ manifest: m, scans: s })); else localStorage.removeItem(key); };
  const api = async (body: Record<string, unknown>) => { const r = await fetch("/api/clubhouse/offline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(dict(lang).errors[data.error] ?? T("Не удалось выполнить запрос", "Request failed")); return data; };
  const download = async () => { setBusy(true); try { if (scans.some(s => !s.result)) throw new Error(T("Сначала синхронизируйте очередь", "Synchronise queued scans first")); const m = await api({ action: "manifest", venue: venueId }); save(m, []); setMessage(T("Данные для автономной работы загружены на 4 часа.", "Offline admission data loaded for 4 hours.")); } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); } };
  const record = async (raw: string) => {
    const saved = JSON.parse(localStorage.getItem(key) || "null") as { manifest: Manifest; scans: Scan[] } | null;
    const m = saved?.manifest, queue = saved?.scans ?? [];
    if (!m || Date.now() > new Date(m.expires_at).getTime()) throw new Error(T("Обновите данные площадки при наличии связи.", "Refresh venue data while online."));
    const token = raw.trim().match(/(?:^|\/pass\/)([A-Za-z0-9_-]{32})(?:$|[?#])/)?.[1]; if (!token) throw new Error(T("Неверный QR-код или ссылка", "Invalid QR code or link"));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))).map(b => b.toString(16).padStart(2, "0")).join("");
    const pass = m.passes.find(p => p.token_hash === digest), now = Date.now();
    if (!pass || now < new Date(pass.valid_from).getTime() || now > new Date(pass.valid_until).getTime()) throw new Error(T("Пропуск не найден или сейчас недействителен", "Pass not found or not valid now"));
    if (queue.some(s => s.token === token)) throw new Error(T("Этот пропуск уже есть в очереди устройства", "This device has already recorded the pass"));
    if (queue.length >= 1000) throw new Error(T("Синхронизируйте очередь и обновите данные", "Synchronise the queue and refresh data"));
    save(m, [...queue, { id: crypto.randomUUID(), token, observedAt: new Date().toISOString() }]);
    setMessage(T("Предварительная отметка сохранена. Подтверждение — после синхронизации.", "Provisional arrival saved. Confirmation follows synchronisation."));
  };
  const submit = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = e.currentTarget; try { await record(String(new FormData(form).get("token") ?? "")); form.reset(); } catch (e) { setMessage((e as Error).message); } };
  const sync = async () => { if (!manifest) return; setBusy(true); stopCamera(); let next = [...scans]; try { for (let i = 0; i < next.length; i++) { if (next[i].result) continue; const r = await api({ action: "sync", manifest: manifest.id, ...next[i] }); next = next.map((s, j) => i === j ? { ...s, result: r.result } : s); save(manifest, next); } setMessage(T("Очередь сверена с сервером. Проверьте результаты ниже.", "Queue checked against the server. Review results below.")); } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); } };
  const startCamera = async () => {
    const ctor = (window as unknown as { BarcodeDetector?: new (opts: { formats: string[] }) => Detector }).BarcodeDetector;
    if (!ctor) { setMessage(T("Камера для QR недоступна в этом браузере. Отсканируйте системной камерой и вставьте ссылку.", "QR camera is unavailable in this browser. Scan with your device camera and paste the link.")); return; }
    try { const detector = new ctor({ formats: ["qr_code"] }); stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }); if (video.current) { video.current.srcObject = stream.current; await video.current.play(); } setCamera(true); cameraTimer.current = setInterval(async () => { if (!video.current || captureBusy.current) return; captureBusy.current = true; try { const found = await detector.detect(video.current); if (found[0]) { await record(found[0].rawValue); stopCamera(); } } catch (e) { setMessage((e as Error).message); } finally { captureBusy.current = false; } }, 500); } catch { stopCamera(); setMessage(T("Доступ к камере не получен. Можно вставить ссылку вручную.", "Camera access was not granted. You can paste a link instead.")); }
  };
  const labels: Record<string, string> = { admitted: T("Подтверждён", "Confirmed"), used: T("Повтор: уже использован", "Duplicate: already used"), expired: T("Истёк", "Expired"), revoked: T("Отозван", "Revoked"), withdrawn: T("Допуск отменён", "Admission withdrawn"), not_yet: T("Слишком рано", "Too early") };
  return <section className="card section-tight"><h2>{T("Автономный контроль входа", "Offline check-in")}</h2><p>{online ? T("Есть связь", "Online") : T("Нет связи", "Offline")}</p><p className="muted">{T("Загрузите данные перед работой и держите эту страницу открытой. Без связи отметки предварительные: другие устройства и отзывы пропусков проверяются при синхронизации. Синхронизируйте в течение суток после окончания автономного окна.", "Load data before starting and keep this page open. Offline arrivals are provisional: other devices and revoked passes are checked on synchronisation. Synchronise within 24 hours of the offline window ending.")}</p>
    <div className="row"><button type="button" className="btn btn-ghost" disabled={busy || !online} onClick={download}>{T("Загрузить данные", "Load venue data")}</button><button type="button" className="btn btn-primary" disabled={busy || !online || !scans.some(s => !s.result)} onClick={sync}>{T("Синхронизировать", "Synchronise")}</button><button type="button" className="btn btn-ghost" disabled={busy || scans.some(s => !s.result)} onClick={() => { stopCamera(); save(null, []); }}>{T("Очистить устройство", "Clear device")}</button></div>
    {manifest && <><p>{T("Данные действуют до", "Data valid until")}: {new Date(manifest.expires_at).toLocaleString(lang)}</p><form onSubmit={submit}><label className="field"><span>{T("Ссылка или токен из QR-пропуска", "QR pass link or token")}</span><input name="token" required maxLength={500} autoComplete="off" /></label><button className="btn btn-primary" disabled={busy}>{T("Предварительно отметить вход", "Record provisional arrival")}</button></form><button type="button" className="btn btn-ghost" disabled={busy} onClick={camera ? stopCamera : startCamera}>{camera ? T("Остановить камеру", "Stop camera") : T("Сканировать камерой", "Scan with camera")}</button></>}
    <video ref={video} muted playsInline hidden={!camera} style={{ maxWidth: "100%", width: 360 }} />
    {message && <p className="notice" role="status">{message}</p>}<ol>{scans.map(s => <li key={s.id}>{new Date(s.observedAt).toLocaleTimeString(lang)} · {s.result ? labels[s.result] ?? s.result : T("Ожидает сверки", "Pending confirmation")}</li>)}</ol>
  </section>;
}
