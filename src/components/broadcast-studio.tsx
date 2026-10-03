"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Room } from "livekit-client";
import type { Locale } from "@/lib/i18n.ts";
import type { BroadcastTariff, BroadcastMode } from "@/server/broadcast-config.ts";
import type { BroadcastView } from "@/server/broadcasts.ts";
import styles from "./broadcast-studio.module.css";

type View = Omit<BroadcastView, "startedAt" | "expiresAt" | "retainUntil" | "createdAt"> & { startedAt: string | null; expiresAt: string | null; retainUntil: string | null; createdAt: string };
type StudioData = { ready: boolean; tariff: BroadcastTariff | null; paymentMode: "test" | "live" | null; broadcasts: View[] };
export async function broadcastApi<T>(action: string, body: Record<string, unknown> = {}, keepalive = false): Promise<T> {
  const r = await fetch(`/api/broadcasts/${action}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(45000), keepalive });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error ?? "server_error");
  return result;
}

export function BroadcastStudio({ lang, initial }: { lang: Locale; initial: StudioData }) {
  const T = useCallback((ru: string, en: string) => lang === "ru" ? ru : en, [lang]);
  const [data, setData] = useState(initial), [title, setTitle] = useState("");
  const [mode, setMode] = useState<BroadcastMode>("live_record"), [minutes, setMinutes] = useState(60), [days, setDays] = useState(7);
  const [mic, setMic] = useState(true), [rights, setRights] = useState(false), [terms, setTerms] = useState(false);
  const [preview, setPreview] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [active, setActive] = useState<string | null>(null), [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const video = useRef<HTMLVideoElement>(null), media = useRef<MediaStream[]>([]), room = useRef<Room | null>(null);
  const session = useRef<{ id: string; expires: number } | null>(null), purchaseId = useRef<string | null>(null);
  const operation = useRef(false), mounted = useRef(true), generation = useRef(0);
  const tariff = data.tariff;
  const amount = tariff ? minutes * (tariff.minuteMinor + (mode === "live" ? 0 : days * tariff.storageMinuteDayMinor)) : null;
  const open = data.broadcasts.find(b => ["unpaid", "paid", "starting", "live", "stopping"].includes(b.state));

  const refresh = useCallback(async () => { const result = await broadcastApi<StudioData>("status"); if (mounted.current) setData(result); }, []);
  const stopCapture = useCallback(() => {
    media.current.forEach(s => s.getTracks().forEach(t => { t.onended = null; t.stop(); })); media.current = [];
    if (video.current) video.current.srcObject = null;
    if (mounted.current) setPreview(false);
  }, []);
  const end = useCallback((notify = true) => {
    generation.current++;
    const current = session.current; session.current = null;
    const r = room.current; room.current = null; if (r) void r.disconnect();
    stopCapture();
    if (mounted.current) { setActive(null); setSeconds(0); }
    if (notify && current) void broadcastApi("stop", { id: current.id }, true).then(() => refresh()).catch(() => {
      if (mounted.current) setError(T("Захват остановлен. Подтверждение сервера задерживается; обновите статус эфира.", "Capture stopped. Server confirmation is delayed; refresh the broadcast status."));
    });
  }, [refresh, stopCapture, T]);
  const failure = useCallback((e: unknown) => {
    const code = e instanceof Error ? e.message : "";
    setError(code === "NotAllowedError" || (e instanceof DOMException && e.name === "NotAllowedError")
      ? T("Разрешение на захват не получено. Выберите экран и разрешите доступ к микрофону либо отключите его.", "Capture permission was not granted. Choose a screen and allow microphone access, or turn the microphone off.")
      : code === "unsupported" ? T("Этот браузер не поддерживает захват экрана. Откройте студию в совместимом браузере на компьютере.", "This browser cannot capture your screen. Open the studio in a supported desktop browser.")
      : code === "checkout_in_progress" ? T("У вас уже есть незавершённый заказ или эфир. Он показан ниже.", "You already have an open order or broadcast. It appears below.")
      : code === "stream_limit" ? T("Сейчас все места заняты. Повторите запуск позже; новая оплата не нужна.", "Capacity is currently full. Try starting again later; another payment is not needed.")
      : code === "feature_disabled" || code === "payments_unavailable" ? T("Сервис сейчас недоступен. Оплата и новые эфиры временно закрыты.", "The service is unavailable. Payments and new broadcasts are temporarily closed.")
      : T("Действие не завершено. Обновите статус перед повторной попыткой. Если оплата уже прошла, не создавайте новый заказ.", "The action did not complete. Refresh status before retrying. If you already paid, do not create another order."));
  }, [T]);

  const capture = async () => {
    stopCapture();
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("unsupported");
    // Called directly from a click, before any network request or SDK import.
    const g = generation.current;
    const screen = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }, audio: true });
    if (!mounted.current || generation.current !== g) { screen.getTracks().forEach(t => t.stop()); return false; }
    media.current = [screen];
    try {
      if (mic) {
        const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        if (!mounted.current || generation.current !== g) { microphone.getTracks().forEach(t => t.stop()); stopCapture(); return false; }
        media.current.push(microphone);
      }
      screen.getVideoTracks()[0].onended = () => end();
      if (video.current) video.current.srcObject = screen;
      setPreview(true);
      setMuted(false);
      return true;
    } catch (e) { stopCapture(); throw e; }
  };

  const run = async (fn: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError("");
    try { await fn(); } catch (e) { failure(e); await refresh().catch(() => {}); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };

  const start = async (b: View, reconnect = false) => {
    if (!media.current[0]?.getVideoTracks().some(t => t.readyState === "live") && !(await capture())) return;
    const g = generation.current;
    const sdk = await import("livekit-client");
    if (!mounted.current || generation.current !== g || !media.current[0]?.getVideoTracks().some(t => t.readyState === "live")) return;
    const connection = await broadcastApi<{ token: string; url: string; expiresAt: string }>(reconnect ? "token" : "start", { id: b.id });
    session.current = { id: b.id, expires: new Date(connection.expiresAt).getTime() };
    if (!mounted.current || generation.current !== g) { end(); return; }
    const r = new sdk.Room({ adaptiveStream: true, dynacast: true }); room.current = r;
    try {
      await r.connect(connection.url, connection.token);
      if (generation.current !== g) { await r.disconnect(); return; }
      for (const [index, stream] of media.current.entries()) {
        for (const track of stream.getTracks()) {
          await r.localParticipant.publishTrack(track, { source: track.kind === "video" ? sdk.Track.Source.ScreenShare : index === 0 ? sdk.Track.Source.ScreenShareAudio : sdk.Track.Source.Microphone,
            simulcast: false, videoCodec: "h264", screenShareEncoding: { maxBitrate: 2500000, maxFramerate: 30 } });
        }
      }
      setActive(b.id);
      setSeconds(Math.max(0, Math.ceil((session.current!.expires - Date.now()) / 1000)));
      r.on(sdk.RoomEvent.Disconnected, () => { if (room.current === r) end(); });
      await broadcastApi("heartbeat", { id: b.id });
      await refresh();
    } catch (e) { end(); throw e; }
  };

  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => {});
    const refreshTimer = setInterval(() => { if (!operation.current) void refresh().catch(() => {}); }, 30000);
    let heartbeatBusy = false;
    const heartbeatTimer = setInterval(() => {
      const s = session.current;
      if (!s || heartbeatBusy) return;
      heartbeatBusy = true;
      void broadcastApi("heartbeat", { id: s.id }).catch(e => { failure(e); end(); }).finally(() => { heartbeatBusy = false; });
    }, 15000);
    const clock = setInterval(() => {
      const s = session.current; if (!s) return;
      const remaining = Math.max(0, Math.ceil((s.expires - Date.now()) / 1000)); setSeconds(remaining);
      if (!remaining) end();
    }, 1000);
    const leave = () => end(); window.addEventListener("pagehide", leave);
    return () => { mounted.current = false; clearInterval(refreshTimer); clearInterval(heartbeatTimer); clearInterval(clock); window.removeEventListener("pagehide", leave); end(); };
  }, [end, failure, refresh]);

  const status = (b: View) => ({ unpaid: T("Ожидает оплаты", "Awaiting payment"), paid: T("Оплачено · можно начать", "Paid · ready to start"),
    starting: T("Подключение", "Connecting"), live: b.mode === "record" ? T("Идёт запись", "Recording") : T("В эфире", "Live"),
    stopping: T("Завершение", "Stopping"), ended: T("Завершено", "Ended"), deleting: T("Удаление", "Deleting"), deleted: T("Удалено", "Deleted") })[b.state];

  return <div className={styles.studio}>
    {!data.ready ? <p className={styles.notice} role="status">{T("Платные эфиры пока не включены. Проверить захват экрана можно уже сейчас — предпросмотр остаётся на вашем устройстве.", "Paid broadcasts are not enabled yet. You can test screen capture now — the preview stays on your device.")}</p> : null}
    {data.paymentMode === "test" ? <p className={styles.notice}>{T("Тестовый режим оплаты: используйте только тестовые платёжные данные.", "Test payment mode: use test payment details only.")}</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <div className={styles.workspace}>
      <div>
        <div className={styles.preview}>
          <video ref={video} autoPlay muted playsInline aria-label={T("Предпросмотр выбранного экрана", "Selected screen preview")} />
          {!preview ? <p className={styles.empty}>{T("Ваш экран — ваш эфир. Выберите окно игры, вкладку или весь экран.", "Your screen, your broadcast. Choose a game window, a tab, or your entire screen.")}</p> : null}
          {active ? <span className={styles.live}>{T("ПЕРЕДАЧА", "ON AIR")} · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span> : null}
        </div>
        <div className={styles.controls}>
          <button className="btn btn-secondary" disabled={busy || !!active} onClick={() => void run(async () => { await capture(); })}>{preview ? T("Сменить экран", "Change screen") : T("Проверить захват экрана", "Test screen capture")}</button>
          {preview ? <button className="btn btn-ghost" disabled={busy} onClick={() => end()}>{active ? T("Завершить эфир / запись", "End broadcast / recording") : T("Остановить предпросмотр", "Stop preview")}</button> : null}
          <label><input type="checkbox" checked={mic} disabled={preview || busy} onChange={e => setMic(e.target.checked)} /> {T("Микрофон", "Microphone")}</label>
          {preview && mic ? <button className="btn btn-ghost btn-sm" type="button" onClick={() => {
            media.current[1]?.getAudioTracks().forEach(t => { t.enabled = muted; }); setMuted(!muted);
          }}>{muted ? T("Включить микрофон", "Unmute microphone") : T("Выключить микрофон", "Mute microphone")}</button> : null}
        </div>
        <p className="small muted">{T("Захват экрана доступен в совместимом браузере на компьютере. Звук игры зависит от браузера и выбранного источника; для вкладки включите передачу её звука. Закрытие этой страницы завершает эфир.", "Screen capture needs a supported desktop browser. Game audio depends on the browser and selected source; enable tab audio when sharing a tab. Closing this page ends the broadcast.")}</p>
      </div>
      <form className={styles.settings} onSubmit={e => { e.preventDefault(); void run(async () => {
        purchaseId.current ??= crypto.randomUUID();
        const result = await broadcastApi<{ url: string | null }>("checkout", { requestId: purchaseId.current, title, mode, minutes, retentionDays: days, terms, rights, version: tariff?.version, expectedMinor: amount, lang });
        purchaseId.current = null;
        if (result.url) { stopCapture(); window.location.assign(result.url); } else await refresh();
      }); }}>
        <h2 className="h3">{T("Настройки эфира", "Broadcast settings")}</h2>
        <label>{T("Название", "Title")}<input value={title} onChange={e => setTitle(e.target.value)} required maxLength={120} placeholder={T("Например, мой POV · CS2", "For example, my POV · CS2")} disabled={!!open || busy} /></label>
        <label>{T("Режим", "Mode")}<select value={mode} onChange={e => setMode(e.target.value as BroadcastMode)} disabled={!!open || busy}>
          <option value="live_record">{T("Прямой эфир + запись POV", "Live + POV recording")}</option><option value="live">{T("Только прямой эфир", "Live only")}</option><option value="record">{T("Только запись POV", "POV recording only")}</option>
        </select></label>
        <label>{T("Длительность, минут", "Duration, minutes")}<input type="number" min={5} max={480} step={1} required value={minutes} onChange={e => setMinutes(Number(e.target.value))} disabled={!!open || busy} /></label>
        {mode !== "live" ? <label>{T("Хранить запись, дней", "Keep recording, days")}<input type="number" min={1} max={tariff?.maxDays ?? 3650} step={1} required value={days} onChange={e => setDays(Number(e.target.value))} disabled={!!open || busy} /></label> : null}
        <p className="small muted">{mode === "record" ? T("Запись видна только вам.", "Only you can access the recording.") : T("Эфир появится в медиатеке; его смогут смотреть вошедшие пользователи. Архив виден только вам.", "Your broadcast appears in Media for signed-in viewers. Only you can access its archive.")} {tariff && mode !== "record" ? T(`До ${tariff.maxViewers} зрителей одновременно.`, `Up to ${tariff.maxViewers} concurrent viewers.`) : ""}</p>
        {mode !== "live" ? <p className="small muted">{T("Срок начнётся после подготовки записи. По окончании запись станет недоступна и будет удалена. Скачайте её заранее, если хотите оставить копию.", "Retention begins when the recording is ready. It becomes unavailable at expiry and is deleted. Download it beforehand if you want to keep a copy.")}</p> : null}
        <div className={styles.quote}>
          <span>{T("Стоимость выбранных параметров", "Price for your selection")}</span>
          <strong className={styles.price}>{amount !== null && tariff ? new Intl.NumberFormat(lang, { style: "currency", currency: tariff.currency }).format(amount / 10 ** tariff.exponent) : T("Тариф готовится", "Pricing pending")}</strong>
          <p className="small muted">{T("Разовая предоплата. Автоматического продления и доплат сверх заказа нет.", "One prepaid purchase. No automatic renewals or additional charges.")}</p>
        </div>
        {tariff ? <details><summary>{T("Условия, налоги и возвраты", "Terms, taxes and refunds")}</summary><div className={styles.details}><p>{tariff.terms[lang]}</p><p>{tariff.refunds[lang]}</p><p>{tariff.tax[lang]}</p><p>MAXIMUS VEGAS L.L.C-FZ · {tariff.version}</p></div></details> : null}
        <label className={styles.check}><input type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)} required disabled={!!open || busy} />{T("У меня есть право транслировать и записывать выбранное содержимое и согласие людей, чьи голоса или изображения попадают в запись.", "I have the right to broadcast and record this content and consent from people whose voices or images are captured.")}</label>
        <label className={styles.check}><input type="checkbox" checked={terms} onChange={e => setTerms(e.target.checked)} required disabled={!tariff || !!open || busy} />{T("Принимаю показанные условия, стоимость и выбранный срок хранения.", "I accept the displayed terms, price and selected retention period.")}</label>
        <button className="btn btn-primary" disabled={!data.ready || busy || !!open || !tariff}>{busy ? T("Обработка…", "Processing…") : open ? T("Текущий заказ — ниже", "Current order below") : T("Перейти к оплате", "Proceed to payment")}</button>
      </form>
    </div>
    <section className={styles.list}>
      <div className="row-between"><h2>{T("Мои эфиры и записи", "My broadcasts and recordings")}</h2><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(refresh)}>{T("Обновить статус", "Refresh status")}</button></div>
      {!data.broadcasts.length ? <p className="muted">{T("Здесь появятся ваши оплаченные эфиры и личный архив.", "Your purchased broadcasts and private recordings will appear here.")}</p> : null}
      {data.broadcasts.map(b => <article key={b.id} className={styles.record}>
        <div className="row-between"><h3>{b.title || T("Запись", "Recording")}</h3><span>{status(b)}</span></div>
        <div className={styles.meta}><span>{b.minutes} {T("минут", "minutes")}</span><span>{b.retentionDays ? `${b.retentionDays} ${T("дней хранения", "days of storage")}` : T("Без архива", "No archive")}</span>
          {b.retainUntil ? <span>{T("Доступна до", "Available until")} <time dateTime={b.retainUntil}>{new Date(b.retainUntil).toLocaleString(lang)}</time></span> : null}</div>
        {b.failure ? <p className={styles.notice}>{b.failure === "payment_expired" ? T("Срок оплаты истёк. Можно создать новый заказ.", "Checkout expired. You can create a new order.") : b.failure === "payment_revoked" ? T("Доступ отозван после возврата или спора по оплате.", "Access was revoked after a payment refund or dispute.") : T("Сервис не смог завершить эфир или запись. Сохраните номер заказа для обращения в поддержку.", "The service could not complete the broadcast or recording. Keep the order reference for support.")}</p> : null}
        {b.archiveState === "pending" ? <p className="small muted">{T("Архив станет доступен после завершения и обработки записи.", "The archive will be available after the recording ends and finishes processing.")}</p> : null}
        {b.archiveState === "deleted" ? <p className="small muted">{T("Архив удалён.", "Archive deleted.")}</p> : null}
        <div className={styles.controls}>
          {b.state === "unpaid" ? <button className="btn btn-primary" disabled={busy || !data.ready} onClick={() => void run(async () => { const r = await broadcastApi<{ url: string | null }>("resume", { id: b.id }); if (r.url) { stopCapture(); window.location.assign(r.url); } else await refresh(); })}>{T("Продолжить оплату", "Continue checkout")}</button> : null}
          {b.state === "paid" ? <button className="btn btn-primary" disabled={busy || !!active || !data.ready} onClick={() => void run(() => start(b))}>{T("Выбрать экран и начать", "Choose screen and start")}</button> : null}
          {["live", "starting"].includes(b.state) && !active ? <button className="btn btn-secondary" disabled={busy} onClick={() => void run(() => start(b, true))}>{T("Вернуться в эфир", "Rejoin broadcast")}</button> : null}
          {b.state === "live" && b.mode !== "record" ? <Link className="btn btn-secondary" href={`/${lang}/watch/${b.id}`} target="_blank" rel="noopener">{T("Страница зрителя ↗", "Viewer page ↗")}</Link> : null}
          {["live", "starting", "stopping"].includes(b.state) ? <button className="btn btn-ghost" disabled={busy} onClick={() => void run(async () => { if (session.current?.id === b.id) end(false); await broadcastApi("stop", { id: b.id }); await refresh(); })}>{T("Завершить", "End")}</button> : null}
          {b.archiveState === "ready" && b.state === "ended" && b.retainUntil && new Date(b.retainUntil).getTime() > Date.now() ? <button className="btn btn-primary" disabled={busy} onClick={() => void run(async () => { const r = await broadcastApi<{ url: string }>("download", { id: b.id }); window.location.assign(r.url); })}>{T("Скачать MP4", "Download MP4")}</button> : null}
          {!["unpaid", "deleting", "deleted", "starting", "live", "stopping"].includes(b.state) ? <button className="btn btn-ghost" disabled={busy} onClick={() => { if (window.confirm(T("Удалить эфир и его запись? Восстановление невозможно. Условия возврата остаются условиями вашего заказа.", "Delete this broadcast and recording? This cannot be undone. Your order's refund terms still apply."))) void run(async () => { await broadcastApi("delete", { id: b.id }); await refresh(); }); }}>{T("Удалить", "Delete")}</button> : null}
        </div>
        <small className="muted">{T("Номер эфира", "Broadcast reference")}: {b.id}</small>
      </article>)}
    </section>
  </div>;
}
