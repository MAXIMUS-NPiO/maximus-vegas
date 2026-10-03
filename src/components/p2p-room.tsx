"use client";
import { useEffect, useRef, useState } from "react";
import { dict, type Locale } from "@/lib/i18n.ts";
type Session = { id: string; status: string; role: "host" | "client"; game: string; connected_seconds: number; host_confirmed: boolean; client_confirmed: boolean };
type Signal = { id: string; kind: string; payload: RTCSessionDescriptionInit & RTCIceCandidateInit };
export function P2pRoom({ initial, configuration, lang }: { initial: Session; configuration: RTCConfiguration; lang: Locale }) {
  const T = (ru: string, en: string) => lang === "ru" ? ru : en, host = initial.role === "host", arena = initial.game === "maximus-arena";
  const [session, setSession] = useState(initial), [started, setStarted] = useState(false), [state, setState] = useState("new"), [message, setMessage] = useState(""), [rtt, setRtt] = useState<number | null>(null), [quality, setQuality] = useState(""), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  const [rating, setRating] = useState(""), [problem, setProblem] = useState("");
  const video = useRef<HTMLVideoElement>(null), canvas = useRef<HTMLCanvasElement>(null), pc = useRef<RTCPeerConnection | null>(null), dc = useRef<RTCDataChannel | null>(null), media = useRef<MediaStream | null>(null), poller = useRef<ReturnType<typeof setTimeout> | null>(null), animation = useRef(0), alive = useRef(true), cursor = useRef(0), input = useRef({ left: false, right: false, target: .5 }), pendingIce = useRef<RTCIceCandidateInit[]>([]), pointerAt = useRef(0);
  const call = async (action: string, extra: Record<string, unknown> = {}) => {
    const r = await fetch("/api/p2p", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, id: initial.id, ...extra }) });
    const data = await r.json(); if (!r.ok) throw new Error(dict(lang).errors[data.error] ?? T("Не удалось выполнить запрос", "Request failed")); return data;
  };
  const cleanup = () => { if (poller.current) clearTimeout(poller.current); poller.current = null; cancelAnimationFrame(animation.current); media.current?.getTracks().forEach(t => t.stop()); media.current = null; dc.current?.close(); dc.current = null; pc.current?.close(); pc.current = null; };
  useEffect(() => { alive.current = true; return () => { alive.current = false; cleanup(); }; }, []);
  const send = (data: Record<string, unknown>) => { const channel = dc.current; if (channel?.readyState === "open" && channel.bufferedAmount < 64_000) channel.send(JSON.stringify(data)); };
  const wireChannel = (channel: RTCDataChannel) => {
    dc.current = channel; channel.onmessage = e => {
      if (typeof e.data !== "string" || e.data.length > 1000) return;
      try { const data = JSON.parse(e.data); if (data.type === "ping" && Number.isFinite(data.at)) channel.send(JSON.stringify({ type: "pong", at: data.at })); else if (data.type === "pong" && Number.isFinite(data.at)) setRtt(Math.max(0, Math.round(performance.now() - data.at))); else if (host && arena) { if (data.type === "key" && ["ArrowLeft", "KeyA", "ArrowRight", "KeyD"].includes(data.code)) input.current[data.code === "ArrowLeft" || data.code === "KeyA" ? "left" : "right"] = data.down === true; if (data.type === "pointer" && Number.isFinite(data.x)) input.current.target = Math.max(0, Math.min(1, data.x)); } } catch { /* Ignore malformed peer input. */ }
    };
  };
  const arenaStream = () => {
    const c = canvas.current!, ctx = c.getContext("2d")!; let x = 480, y = 200, vx = 4, vy = 3, paddle = 480, score = 0, last = performance.now();
    const frame = () => {
      const now = performance.now(), dt = Math.min(2, (now - last) / 16.67); last = now;
      if (input.current.left || input.current.right) { paddle += (Number(input.current.right) - Number(input.current.left)) * 9 * dt; input.current.target = paddle / 960; } else paddle += (input.current.target * 960 - paddle) * .3;
      paddle = Math.max(70, Math.min(890, paddle)); x += vx * dt; y += vy * dt;
      if (x < 12 || x > 948) vx *= -1; if (y < 72) vy = Math.abs(vy);
      if (y > 475 && y < 500 && vy > 0 && Math.abs(x - paddle) < 85) { vy = -Math.abs(vy) - .15; vx += (x - paddle) / 50; score++; }
      if (y > 550) { x = 480; y = 160; vx = 4; vy = 3; score = 0; }
      ctx.fillStyle = "#0d111a"; ctx.fillRect(0, 0, 960, 540); ctx.fillStyle = "#ded1ab"; ctx.font = "24px sans-serif"; ctx.fillText("MAXIMUS ARENA", 28, 40); ctx.fillText(`${T("Счёт", "Score")}: ${score}`, 760, 40);
      ctx.fillStyle = "#8b6ff8"; ctx.fillRect(paddle - 75, 495, 150, 14); ctx.fillStyle = "#f5e8c8"; ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill();
      animation.current = requestAnimationFrame(frame);
    }; frame(); return c.captureStream(30);
  };
  const signal = (kind: string, payload: unknown) => call("signal", { kind, payload, clientId: crypto.randomUUID() });
  const applySignal = async (s: Signal) => {
    const peer = pc.current; if (!peer) return;
    if (s.kind === "offer" && !host) { await peer.setRemoteDescription(s.payload); for (const candidate of pendingIce.current.splice(0)) await peer.addIceCandidate(candidate); const answer = await peer.createAnswer(); await peer.setLocalDescription(answer); await signal("answer", peer.localDescription?.toJSON()); }
    else if (s.kind === "answer" && host) { await peer.setRemoteDescription(s.payload); for (const candidate of pendingIce.current.splice(0)) await peer.addIceCandidate(candidate); }
    else if (s.kind === "ice") { if (peer.remoteDescription) await peer.addIceCandidate(s.payload); else pendingIce.current.push(s.payload); }
  };
  const poll = async () => {
    if (!alive.current || !pc.current) return;
    try {
      const r = await call("poll", { cursor: cursor.current, connected: pc.current.connectionState === "connected" });
      if (!alive.current) return; setSession(r.session);
      if (!["requested", "connecting", "active"].includes(r.session.status)) { cleanup(); setState("closed"); return; }
      for (const s of r.signals as Signal[]) { await applySignal(s); cursor.current = Number(s.id); }
      send({ type: "ping", at: performance.now() });
      if (pc.current?.connectionState === "connected") { const stats = await pc.current.getStats(); stats.forEach(stat => { if (stat.type === "inbound-rtp" && stat.kind === "video") setQuality(`${Math.round(stat.framesPerSecond ?? 0)} FPS · ${stat.frameWidth ?? 0}×${stat.frameHeight ?? 0} · ${T("Потеряно пакетов", "Packets lost")}: ${stat.packetsLost ?? 0}`); }); }
    } catch (e) { if (alive.current) setMessage((e as Error).message); }
    if (alive.current && pc.current) poller.current = setTimeout(poll, 1500);
  };
  const start = async () => {
    setBusy(true); setMessage("");
    try {
      if (!window.RTCPeerConnection) throw new Error(T("WebRTC не поддерживается браузером", "WebRTC is not supported by this browser"));
      if (host) media.current = arena ? arenaStream() : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: true });
      if (host && session.status === "requested") await call("accept", { accept: true });
      const peer = new RTCPeerConnection(configuration); pc.current = peer;
      peer.onicecandidate = e => { if (e.candidate) void signal("ice", e.candidate.toJSON()).catch(e => setMessage(e.message)); };
      peer.onconnectionstatechange = () => { if (alive.current) setState(peer.connectionState); if (peer.connectionState === "failed") setMessage(T("Соединение не установлено. Завершите сеанс и проверьте сеть хоста.", "Connection failed. End the session and check the host network.")); };
      peer.ontrack = e => { if (video.current) { video.current.srcObject = e.streams[0] ?? new MediaStream([e.track]); void video.current.play().catch(() => setMessage(T("Нажмите воспроизведение на видео", "Press play on the video"))); } };
      if (host) {
        media.current!.getTracks().forEach(track => { peer.addTrack(track, media.current!); track.onended = () => { if (alive.current) void finish(false); }; });
        if (video.current) video.current.srcObject = media.current;
        wireChannel(peer.createDataChannel("input", { ordered: true }));
        const offer = await peer.createOffer(); await peer.setLocalDescription(offer); await signal("offer", peer.localDescription?.toJSON());
      } else peer.ondatachannel = e => wireChannel(e.channel);
      setStarted(true); await poll();
    } catch (e) { cleanup(); setMessage((e as Error).message); } finally { setBusy(false); }
  };
  const finish = async (delivered: boolean) => { setBusy(true); cleanup(); try { await call("finish", { confirm: delivered, rating: rating || undefined, problem }); setSession(s => ({ ...s, status: "ended" })); setState("closed"); setConfirm(delivered); } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); } };
  const key = (e: React.KeyboardEvent<HTMLDivElement>, down: boolean) => { if (host || !started || e.metaKey || e.altKey) return; if (/^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|Space|Enter|Escape|Tab|Shift(Left|Right)|Control(Left|Right))$/.test(e.code)) { e.preventDefault(); send({ type: "key", code: e.code, down }); } };
  const labels: Record<string, string> = { requested: T("Ожидаем хоста", "Waiting for host"), connecting: T("Подключение", "Connecting"), active: T("Идёт сеанс", "Session active"), ended: T("Сеанс завершён", "Session ended"), failed: T("Сеанс прерван", "Session failed"), rejected: T("Хост отклонил запрос", "Host declined"), new: T("Готов к подключению", "Ready to connect"), connected: T("Связь установлена", "Connected"), disconnected: T("Связь потеряна", "Disconnected"), closed: T("Соединение закрыто", "Connection closed") };
  return <section className="card"><p role="status">{labels[session.status] ?? session.status} · {labels[state] ?? state}</p><p>{T("Подтверждённое время связи", "Confirmed connected time")}: {session.connected_seconds}s {rtt !== null && <>· RTT {rtt} ms</>}</p>{quality && <p>{quality}</p>}
    <p className="muted">{host ? arena ? T("Игра исполняется на этой машине; игрок получает видео и управляет ракеткой удалённо.", "The game runs on this machine; the player receives video and controls the paddle remotely.") : T("Браузер передаёт выбранный вами экран. Управление установленной игрой доступно через отдельный хост-агент.", "The browser shares a screen you choose. Installed-game control requires the native host agent.") : T("После подключения нажмите на видео для управления. Стрелки/A/D или касание — для Arena; клавиатура и мышь — для игр хост-агента.", "After connecting, click the video to control. Use arrows/A/D or touch for Arena; keyboard and mouse for host-agent games.")}</p>
    {!started && ["requested", "connecting", "active"].includes(session.status) && <button className="btn btn-primary" onClick={start} disabled={busy}>{host ? T("Принять и начать передачу", "Accept and start streaming") : T("Подключиться к хосту", "Connect to host")}</button>}
    <div role="group" tabIndex={host ? -1 : 0} aria-label={T("Экран игры; нажмите для управления", "Game screen; click to control")} onKeyDown={e => key(e, true)} onKeyUp={e => key(e, false)} onBlur={() => send({ type: "release" })}
      onPointerMove={e => { if (host || performance.now() - pointerAt.current < 16) return; pointerAt.current = performance.now(); const r = e.currentTarget.getBoundingClientRect(); send({ type: "pointer", x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, buttons: e.buttons }); }}
      onPointerDown={e => { e.currentTarget.focus(); const r = e.currentTarget.getBoundingClientRect(); if (!host) send({ type: "pointer", x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, buttons: e.buttons }); }}
      onPointerUp={() => { if (!host) send({ type: "release" }); }} style={{ marginTop: 16, border: "1px solid var(--line)", borderRadius: 12, overflow: "hidden" }}>
      <video ref={video} autoPlay playsInline muted={host} controls={!host} style={{ width: "100%", aspectRatio: "16 / 9", background: "#0d111a" }} />
    </div><canvas ref={canvas} width={960} height={540} hidden />
    {message && <p className="notice" role="alert">{message}</p>}
    {!host && <div className="section-tight"><label>{T("Качество сеанса (необязательно)", "Session quality (optional)")}<select value={rating} onChange={e => setRating(e.target.value)}><option value="">{T("Без оценки", "No rating")}</option>{[1,2,3,4,5].map(n => <option key={n} value={n}>{n}/5</option>)}</select></label></div>}<label>{T("Проблема с сеансом (необязательно)", "Session issue (optional)")}<textarea value={problem} onChange={e => setProblem(e.target.value)} maxLength={1000} /></label>
    <div className="row section-tight"><button className="btn btn-ghost" onClick={() => finish(false)} disabled={busy || ["ended", "failed", "rejected"].includes(session.status)}>{T("Завершить сеанс", "End session")}</button><button className="btn btn-primary" onClick={() => finish(true)} disabled={busy || confirm || ["failed", "rejected"].includes(session.status)}>{T("Сеанс предоставлен — подтвердить завершение", "Session delivered — confirm completion")}</button></div>
    <p className="small muted">{T("Нет оплаты и гарантированного дохода. Хост получает 5 внутренних монет только за связь от 5 минут, подтверждённую обеими сторонами, с дневными ограничениями.", "No payment or guaranteed income. A host receives 5 internal coins only after at least 5 connected minutes confirmed by both parties, subject to daily limits.")}</p>
  </section>;
}
