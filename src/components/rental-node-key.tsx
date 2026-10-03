"use client";
import { useRef, useState } from "react";
export function RentalNodeKey({ id, lang }: { id: string; lang: string }) {
  const [token,setToken]=useState<string|null>(null),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
  const input=useRef<HTMLInputElement>(null),T=(ru:string,en:string)=>lang==="ru"?ru:en;
  async function change(revoke:boolean){
    setBusy(true);setToken(null);setMessage("");
    try{
      const response=await fetch("/api/rentals/key",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id,revoke})});
      const data=await response.json();if(!response.ok)throw Error(data.error??"server_error");
      setToken(data.token);setMessage(revoke?T("Ключ отозван. Ресурсы освободятся после подтверждённой очистки узла.","Key revoked. Resources remain reserved until node cleanup is confirmed."):T("Ключ показан один раз. Сохраните его в окружении агента; затем включите приём новых сеансов.","This key is shown once. Store it in the agent environment, then enable new sessions."));
    }catch(error){setMessage(T("Не удалось изменить ключ: ","Could not change the key: ")+(error as Error).message);}finally{setBusy(false);}
  }
  async function copy(){try{await navigator.clipboard.writeText(token!);setMessage(T("Ключ скопирован.","Key copied."));}catch{input.current?.select();setMessage(T("Скопируйте выделенный ключ вручную.","Copy the selected key manually."));}}
  return <section className="card section-tight"><h2>{T("Подключение агента узла","Node agent connection")}</h2><p>{T("Создание нового ключа останавливает текущие сеансы и выключает приём новых. Управляющий порт на узле открывать не нужно.","Creating a new key stops existing sessions and disables new reservations. The agent needs no inbound management port.")}</p><div className="row"><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>change(false)}>{T("Создать или заменить ключ","Create or rotate key")}</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>change(true)}>{T("Отозвать ключ","Revoke key")}</button></div>{token&&<div className="section-tight"><label>{T("Ключ агента","Agent key")}<input ref={input} type="password" readOnly value={token} autoComplete="off" /></label><button type="button" className="btn btn-ghost" onClick={copy}>{T("Скопировать ключ","Copy key")}</button><button type="button" className="btn btn-ghost" onClick={()=>setToken(null)}>{T("Скрыть","Hide")}</button></div>}<p role="status">{message}</p></section>;
}
