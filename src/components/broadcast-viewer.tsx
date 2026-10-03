"use client";
import { useEffect, useRef, useState } from "react";
import type { Room } from "livekit-client";
import type { Locale } from "@/lib/i18n.ts";
import { broadcastApi } from "./broadcast-studio";
import styles from "./broadcast-studio.module.css";

export function BroadcastViewer({ id, lang }: { id: string; lang: Locale }) {
  const T = (ru: string, en: string) => lang === "ru" ? ru : en;
  const element = useRef<HTMLDivElement>(null), room = useRef<Room | null>(null), alive = useRef(true), connecting = useRef(false);
  const [joined, setJoined] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  useEffect(() => { alive.current = true; return () => { alive.current = false; void room.current?.disconnect(); room.current = null; }; }, []);
  const connect = async () => {
    if (connecting.current) return;
    connecting.current = true; setBusy(true); setMessage("");
    let r: Room | undefined;
    try {
      const sdk = await import("livekit-client");
      const connection = await broadcastApi<{ token: string; url: string; expiresAt: string }>("watch", { id });
      if (!alive.current) return;
      r = new sdk.Room({ adaptiveStream: true }); room.current = r;
      r.on(sdk.RoomEvent.TrackSubscribed, track => {
        const media = track.attach(); media.autoplay = true;
        if (media instanceof HTMLVideoElement) { media.playsInline = true; media.controls = true; }
        element.current?.appendChild(media);
      });
      r.on(sdk.RoomEvent.TrackUnsubscribed, track => track.detach().forEach(e => e.remove()));
      r.on(sdk.RoomEvent.Disconnected, () => {
        element.current?.replaceChildren();
        if (alive.current) { setJoined(false); setMessage(T("Соединение завершено. Если эфир продолжается, подключитесь снова.", "Connection ended. If the broadcast is still live, reconnect.")); }
      });
      await r.connect(connection.url, connection.token);
      if (!alive.current) { await r.disconnect(); return; }
      setJoined(true);
      await r.startAudio().catch(() => {});
    } catch {
      await r?.disconnect();
      if (alive.current) setMessage(T("Эфир недоступен или все места заняты. Попробуйте подключиться позже.", "The broadcast is unavailable or full. Try connecting later."));
    } finally { connecting.current = false; if (alive.current) setBusy(false); }
  };
  return <div className="stack">
    <div ref={element} className={styles.player} aria-label={T("Прямой эфир", "Live broadcast")} />
    {message ? <p role="status">{message}</p> : null}
    <div className={styles.controls}>
      {!joined ? <button className="btn btn-primary" disabled={busy} onClick={() => void connect()}>{busy ? T("Подключение…", "Connecting…") : T("Смотреть эфир", "Watch live")}</button> : <>
        <button className="btn btn-secondary" onClick={() => void room.current?.startAudio()}>{T("Включить звук", "Enable audio")}</button>
        <button className="btn btn-ghost" onClick={() => void room.current?.disconnect()}>{T("Отключиться", "Disconnect")}</button>
      </>}
    </div>
  </div>;
}
