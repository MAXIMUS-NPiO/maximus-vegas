"use client";
import { useEffect, useRef, useState } from "react";
import type { Room } from "livekit-client";
import type { Locale } from "@/lib/i18n";
import { dict } from "@/lib/i18n";
import type { RoomScope } from "@/server/community";
import { MemberAvatar } from "./member-avatar";
type Member = { username: string; display_name: string; avatar_media_id: string | null };
export function CommunityVoice({ lang, scope, available: initialAvailable }: { lang: Locale; scope: RoomScope; available: boolean }) {
  const T = (ru: string,en: string) => lang==="ru"?ru:en;
  const [available,setAvailable]=useState(initialAvailable),[joined,setJoined]=useState(false),[busy,setBusy]=useState(false),[muted,setMuted]=useState(true),[error,setError]=useState(""),[members,setMembers]=useState<Member[]>([]);
  const room=useRef<Room|null>(null),device=useRef(""),audio=useRef<HTMLDivElement>(null),alive=useRef(true),generation=useRef(0),starting=useRef(false);
  function api(action: string) {
    if(!device.current) device.current=crypto.randomUUID();
    return fetch("/api/community/voice",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action,scope:scope.scope,id:scope.id,device:device.current}),keepalive:action==="leave"}).then(async r=>{const data=await r.json();if(!r.ok)throw new Error((dict(lang).errors as Record<string,string>)[data.error]??dict(lang).errors.server_error);return data;});
  }
  async function leave() {
    generation.current++; starting.current=false; const r=room.current;room.current=null;
    await r?.disconnect();audio.current?.replaceChildren();
    if(alive.current){setJoined(false);setMuted(true);setBusy(false);}
    await api("leave").catch(()=>undefined);
  }
  useEffect(()=>{
    alive.current=true;
    async function poll(){
      try { const data=await api("status");if(!alive.current)return;setAvailable(data.available);setMembers(data.members);if(room.current && !starting.current && (!data.joined || !data.available))await leave(); }
      catch(e){if(alive.current){setError(e instanceof Error?e.message:"Connection lost");if(room.current && !starting.current)await leave();}}
    }
    void poll(); const timer=setInterval(()=>void poll(),15000);
    const hide=()=>void leave();window.addEventListener("pagehide",hide);
    return()=>{alive.current=false;clearInterval(timer);window.removeEventListener("pagehide",hide);void leave();};
    // Scope changes remount this component; callbacks intentionally read current refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);
  async function join(){
    if(starting.current || room.current)return;starting.current=true;setBusy(true);setError("");const version=++generation.current;
    try {
      const [sdk,data]=await Promise.all([import("livekit-client"),api("join")]);
      if(!alive.current || generation.current!==version){await api("leave").catch(()=>undefined);return;}
      const r=new sdk.Room();room.current=r;
      r.on(sdk.RoomEvent.TrackSubscribed,track=>{if(track.kind===sdk.Track.Kind.Audio){const el=track.attach();el.autoplay=true;audio.current?.appendChild(el);}});
      r.on(sdk.RoomEvent.TrackUnsubscribed,track=>track.detach().forEach(el=>el.remove()));
      r.on(sdk.RoomEvent.Disconnected,()=>{if(room.current===r)void leave();});
      await r.connect(data.url,data.token,{autoSubscribe:true});
      if(!alive.current || generation.current!==version){await r.disconnect();return;}
      // Join as a listener. Microphone capture requires a second, explicit click.
      await r.startAudio().catch(()=>undefined);setJoined(true);setMuted(true);
      const status=await api("status");if(alive.current)setMembers(status.members);
    }catch(e){if(alive.current)setError(e instanceof Error?e.message:T("Не удалось войти", "Could not join"));await leave();}
    finally{starting.current=false;if(alive.current)setBusy(false);}
  }
  async function microphone(){const r=room.current;if(!r || busy)return;setBusy(true);setError("");try{await r.localParticipant.setMicrophoneEnabled(muted);if(!alive.current || room.current!==r){await r.localParticipant.setMicrophoneEnabled(false);return;}setMuted(!muted);}catch{if(alive.current)setError(T("Доступ к микрофону не получен. Можно остаться слушателем или разрешить доступ и попробовать снова.","Microphone permission was not granted. You can keep listening or allow access and try again."));}finally{if(alive.current)setBusy(false);}}
  return <section className="card stack-sm section-tight" aria-label={T("Голосовая комната", "Voice room")}><h2 className="h3">{T("Голосовая комната", "Voice room")}</h2><p className="small muted">{T("До 8 участников, до 30 минут за встречу. Входите слушателем; микрофон включаете сами. Сайт не записывает разговор.","Up to 8 people, up to 30 minutes per meeting. Join as a listener and enable your microphone when ready. The site does not record the conversation.")}</p>
    {!available && <p className="notice">{T("Групповой голос сейчас недоступен. Можно общаться в текстовом чате.","Group voice is currently unavailable. You can use text chat.")}</p>}
    {error && <p className="notice notice-warn" role="alert">{error}</p>}
    <ul className="list" aria-label={T("Участники голосовой комнаты", "Voice room members")}>{members.map(m=><li key={m.username} className="row"><MemberAvatar name={m.display_name} mediaId={m.avatar_media_id}/><span>{m.display_name} · @{m.username}</span></li>)}</ul>
    <div className="row wrap">{joined?<><button className="btn btn-primary" onClick={()=>void microphone()} disabled={busy}>{muted?T("Включить микрофон", "Enable microphone"):T("Выключить микрофон", "Mute microphone")}</button><button className="btn btn-ghost" onClick={()=>void room.current?.startAudio().catch(()=>setError(T("Браузер не включил звук", "Browser could not enable audio")))}>{T("Включить звук", "Enable audio")}</button><button className="btn btn-ghost" onClick={()=>void leave()}>{T("Выйти из войса", "Leave voice")}</button></>:<button className="btn btn-primary" disabled={!available || busy} onClick={()=>void join()}>{busy?T("Подключаем…", "Connecting…"):T("Войти в голосовую комнату", "Join voice room")}</button>}</div><div ref={audio} hidden /></section>;
}
