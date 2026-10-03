"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "@/lib/i18n.ts";
import type { CallResponse, CallView } from "@/server/social-calls.ts";

type MediaSession = { generation: number; device: string; callId: string | null; stream: MediaStream | null; pc: RTCPeerConnection | null; cursor: number; pendingIce: RTCIceCandidateInit[]; queue: Promise<void>; lastOkay: number; started: number; processing: boolean };
export function SocialCall({ lang, matchId, available }: { lang: Locale; matchId: string; available: boolean }) {
  const T = useCallback((ru: string, en: string) => lang === "ru" ? ru : en, [lang]);
  const [call, setCall] = useState<CallView | null>(null), [ready, setReady] = useState(available), [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(""), [muted, setMuted] = useState(false), [cameraOff, setCameraOff] = useState(false), [connected, setConnected] = useState(false), [playBlocked, setPlayBlocked] = useState(false);
  const local = useRef<HTMLVideoElement>(null), remote = useRef<HTMLVideoElement>(null), alive = useRef(false), busyRef = useRef(false);
  const s = useRef<MediaSession>({ generation: 0, device: "", callId: null, stream: null, pc: null, cursor: 0, pendingIce: [], queue: Promise.resolve(), lastOkay: 0, started: 0, processing: false });
  const api = useCallback(async (data: Record<string, unknown>, keepalive = false): Promise<CallResponse> => {
    const response = await fetch("/api/social/calls", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ matchId, ...data }), signal: AbortSignal.timeout(8000), keepalive });
    const value = await response.json(); if (!response.ok) throw new Error(value.error ?? "server_error"); return value;
  }, [matchId]);
  const stop = useCallback((notify = true) => {
    const state = s.current, id = state.callId, device = state.device;
    state.generation++; state.callId = null; state.pc?.close(); state.pc = null;
    state.stream?.getTracks().forEach(t => t.stop()); state.stream = null;
    state.cursor = 0; state.pendingIce = []; state.queue = Promise.resolve(); state.started = 0;
    if (local.current) local.current.srcObject = null;
    if (remote.current) remote.current.srcObject = null;
    busyRef.current = false;
    if (alive.current) { setBusy(false); setMuted(false); setCameraOff(false); setConnected(false); setPlayBlocked(false); }
    if (notify && id) void api({ action: "end", callId: id, device }, true).catch(() => {});
  }, [api]);
  const failed = useCallback((error: unknown) => {
    stop();
    if (!alive.current) return;
    const code = error instanceof Error ? error.message : "";
    setStatus(code === "session_overlap" ? T("Участник уже в другом звонке. Попробуйте позже.", "A participant is already in another call. Try later.") : code === "NotAllowedError" ? T("Разрешение на микрофон или камеру не получено.", "Microphone or camera permission was not granted.") : T("Звонок остановлен. Проверьте соединение и разрешения устройств, затем повторите.", "Call stopped. Check your connection and device permissions, then try again."));
  }, [stop, T]);
  const process = useCallback(async (result: CallResponse, generation: number) => {
    const state = s.current;
    if (!alive.current || state.generation !== generation) return;
    state.lastOkay = Date.now(); setReady(result.available); setCall(result.call);
    const c = result.call;
    if (!c || c.state === "ended") {
      if (state.stream || state.pc) stop(false);
      if (c?.state === "ended") setStatus(c.reason === "declined" ? T("Звонок отклонён.", "Call declined.") : T("Звонок завершён.", "Call ended."));
      return;
    }
    if (c.state === "ringing" && !c.caller && !state.stream) setStatus(c.mode === "video" ? T("Входящий видеозвонок.", "Incoming video call.") : T("Входящий голосовой звонок.", "Incoming voice call."));
    if (state.stream && state.callId && (state.callId !== c.id || !c.owned)) { stop(false); return; }
    if (c.state !== "accepted" || !c.owned || !state.stream || !result.ice) return;
    if (state.processing) return;
    state.processing = true;
    const current = () => alive.current && state.generation === generation;
    try {
      if (!state.pc) {
        const pc = new RTCPeerConnection(result.ice); state.pc = pc;
        const stream = state.stream;
        const send = (kind: string, payload: unknown) => {
          const packet = { action: "signal", callId: c.id, device: state.device, clientId: crypto.randomUUID(), kind, payload };
          state.queue = state.queue.then(async () => {
            if (!current()) return;
            // Retry once using the same key; an acknowledged signal is never duplicated.
            try { await api(packet); } catch { if (current()) await api(packet); }
          }).catch(error => { if (current()) failed(error); });
        };
        pc.onicecandidate = event => { if (current() && event.candidate?.type === "relay") send("ice", event.candidate.toJSON()); };
        pc.ontrack = event => {
          if (!current() || !remote.current) return;
          const media = remote.current.srcObject instanceof MediaStream ? remote.current.srcObject : new MediaStream();
          media.addTrack(event.track); remote.current.srcObject = media;
          void remote.current.play().then(() => { if (current()) setPlayBlocked(false); }).catch(() => { if (current()) setPlayBlocked(true); });
        };
        pc.onconnectionstatechange = () => {
          if (!current()) return;
          if (pc.connectionState === "connected") { setConnected(true); setStatus(T("Соединение установлено.", "Connected.")); }
          if (["failed", "closed"].includes(pc.connectionState)) failed(new Error("connection_failed"));
        };
        for (const track of stream.getTracks()) pc.addTrack(track, stream);
        if (c.caller) {
          const offer = await pc.createOffer(); if (!current()) return;
          await pc.setLocalDescription(offer); if (!current()) return;
          send("offer", { type: offer.type, sdp: offer.sdp });
        }
      }
      const pc = state.pc;
      for (const signal of result.signals) {
        if (!current()) return;
        if (Number(signal.id) <= state.cursor) continue;
        if (signal.kind === "ice") state.pendingIce.push(signal.payload as RTCIceCandidateInit);
        else {
          await pc.setRemoteDescription(signal.payload as RTCSessionDescriptionInit); if (!current()) return;
          if (signal.kind === "offer") {
            const answer = await pc.createAnswer(); if (!current()) return;
            await pc.setLocalDescription(answer); if (!current()) return;
            const packet = { action: "signal", callId: c.id, device: state.device, clientId: crypto.randomUUID(), kind: "answer", payload: { type: answer.type, sdp: answer.sdp } };
            try { await api(packet); } catch { if (current()) await api(packet); }
          }
        }
        state.cursor = Number(signal.id);
      }
      if (pc.remoteDescription) while (state.pendingIce.length) {
        const candidate = state.pendingIce.shift()!;
        await pc.addIceCandidate(candidate); if (!current()) return;
      }
    } finally { state.processing = false; }
  }, [api, failed, stop, T]);
  useEffect(() => {
    alive.current = true; s.current.device = crypto.randomUUID(); let polling = false;
    const poll = async () => {
      if (polling || busyRef.current || !alive.current) return; polling = true;
      const generation = s.current.generation;
      try {
        const response = await api({ action: "poll", device: s.current.device, after: s.current.cursor });
        try { await process(response, generation); }
        catch (error) { if (generation === s.current.generation) failed(error); }
      }
      catch { if (s.current.stream && generation === s.current.generation && Date.now() - s.current.lastOkay > 10_000) failed(new Error("control_lost")); }
      finally { polling = false; }
    };
    void poll(); const timer = setInterval(poll, 2000);
    const watchdog = setInterval(() => {
      if (s.current.stream && (Date.now() - s.current.lastOkay > 12_000 || s.current.pc?.connectionState !== "connected" && Date.now() - s.current.started > 90_000)) failed(new Error("control_lost"));
    }, 1000);
    const leave = () => stop();
    const form = (e: Event) => { const target = e.target; if (target instanceof HTMLFormElement && /\/api\/a\/social\.(block|close|report|withdraw)$/.test(new URL(target.action).pathname)) stop(); };
    window.addEventListener("pagehide", leave); document.addEventListener("submit", form, true);
    return () => { alive.current = false; clearInterval(timer); clearInterval(watchdog); window.removeEventListener("pagehide", leave); document.removeEventListener("submit", form, true); stop(); };
  }, [api, process, failed, stop]);
  async function begin(mode: "audio" | "video", incoming?: CallView) {
    if (busyRef.current || s.current.stream) return;
    busyRef.current = true; setBusy(true); setStatus(T("Ожидаю разрешение устройства…", "Waiting for device permission…"));
    const state = s.current, generation = ++state.generation;
    state.device = crypto.randomUUID(); state.callId = incoming?.id ?? null; state.lastOkay = Date.now(); state.started = Date.now();
    const current = () => alive.current && state.generation === generation;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") throw new Error("unsupported");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: mode === "video" ? { width: { ideal: 640 }, height: { ideal: 360 } } : false });
      if (!current()) { stream.getTracks().forEach(t => t.stop()); return; }
      state.stream = stream; state.lastOkay = Date.now();
      if (local.current) local.current.srcObject = stream;
      stream.getTracks().forEach(track => { track.onended = () => { if (current()) failed(new Error("device_ended")); }; });
      const device = state.device;
      const result = await api({ action: incoming ? "accept" : "start", ...(incoming ? { callId: incoming.id } : { mode }), device });
      if (!current()) { if (result.call?.owned) void api({ action: "end", callId: result.call.id, device }, true).catch(() => {}); return; }
      if (!result.call || result.call.state === "ended" || !result.call.owned) throw new Error("request_state");
      state.callId = result.call.id;
      setStatus(incoming ? T("Соединение…", "Connecting…") : T("Ожидаю ответа собеседника…", "Waiting for the other participant…"));
      await process(result, generation);
    } catch (error) { if (current()) failed(error instanceof DOMException ? new Error(error.name) : error); }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  }
  async function decline() {
    if (!call || busyRef.current) return;
    try { const result = await api({ action: "decline", callId: call.id, device: s.current.device }); setCall(result.call); setStatus(T("Звонок отклонён.", "Call declined.")); } catch (e) { failed(e); }
  }
  const active = call && call.state !== "ended" ? call : null, incoming = active && !active.caller && active.state === "ringing" ? active : null;
  return <section className="card section-tight social-call" aria-label={T("Звонок", "Call")}>
    <h2>{T("Голос и видео", "Voice and video")}</h2>
    <p className="small muted">{T("Микрофон и камера включаются только после вашего нажатия. Звонок — до 30 минут, только после согласия собеседника. Портал не записывает звонки; собеседник может использовать свои средства записи.", "Microphone and camera start only after your click. Calls last up to 30 minutes and require the other participant’s acceptance. The portal does not record calls; participants may use their own recording tools.")}</p>
    {!ready && <p className="notice">{T("Звонки пока недоступны: защищённый ретранслятор не подключён или общение закрыто.", "Calls are unavailable: the secure relay is not connected or this conversation is closed.")}</p>}
    <p role="status" aria-live="polite" data-call-status>{status || (incoming ? T("Входящий звонок.", "Incoming call.") : T("Нет активного звонка.", "No active call."))}</p>
    <div className="row">
      {!active && !busy && <><button type="button" className="btn btn-primary" disabled={!ready} onClick={() => void begin("audio")}>{T("Позвонить с микрофоном", "Start voice call")}</button><button type="button" className="btn btn-ghost" disabled={!ready} onClick={() => void begin("video")}>{T("Позвонить с видео", "Start video call")}</button></>}
      {incoming && <><button type="button" className="btn btn-primary" disabled={busy || !ready} onClick={() => void begin(incoming.mode, incoming)}>{incoming.mode === "video" ? T("Принять с камерой и микрофоном", "Accept with camera and microphone") : T("Принять с микрофоном", "Accept with microphone")}</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void decline()}>{T("Отклонить", "Decline")}</button></>}
      {(busy || active && !incoming) && <button type="button" className="btn btn-ghost" onClick={() => { if (call && !s.current.callId) s.current.callId = call.id; stop(); setCall(null); setStatus(T("Звонок завершён.", "Call ended.")); }}>{T("Завершить звонок", "End call")}</button>}
      {active?.state === "accepted" && !active.owned && <span>{T("Звонок принят в другой вкладке.", "The call is active in another tab.")}</span>}
    </div>
    <div className="grid grid-2 call-media" hidden={!active || !active.owned || active.mode === "audio"}>
      <figure><video ref={local} autoPlay muted playsInline aria-label={T("Ваше видео", "Your video")} /><figcaption>{T("Вы", "You")}{cameraOff ? T(" · камера выключена", " · camera off") : ""}</figcaption></figure>
      <figure><video ref={remote} autoPlay playsInline aria-label={T("Видео собеседника", "Participant video")} /><figcaption>{T("Собеседник", "Participant")}{connected ? T(" · подключён", " · connected") : ""}</figcaption></figure>
    </div>
    {active?.owned && <div className="row">
      <button type="button" className="btn btn-ghost" aria-pressed={muted} onClick={() => { s.current.stream?.getAudioTracks().forEach(t => { t.enabled = muted; }); setMuted(!muted); }}>{muted ? T("Включить микрофон", "Unmute microphone") : T("Выключить микрофон", "Mute microphone")}</button>
      {active.mode === "video" && <button type="button" className="btn btn-ghost" aria-pressed={cameraOff} onClick={() => { s.current.stream?.getVideoTracks().forEach(t => { t.enabled = cameraOff; }); setCameraOff(!cameraOff); }}>{cameraOff ? T("Включить камеру", "Turn camera on") : T("Выключить камеру", "Turn camera off")}</button>}
      {playBlocked && <button type="button" className="btn btn-ghost" onClick={() => void remote.current?.play().then(() => setPlayBlocked(false)).catch(() => setStatus(T("Браузер не разрешил воспроизведение.", "The browser did not allow playback.")))}>{T("Включить звук и видео собеседника", "Play participant audio and video")}</button>}
    </div>}
  </section>;
}
