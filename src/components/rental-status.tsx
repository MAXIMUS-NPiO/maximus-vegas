"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
export function RentalStatusRefresh({active,lang}:{active:boolean;lang:string}){
  const router=useRouter();
  useEffect(()=>{if(!active)return;const timer=setInterval(()=>{if(document.visibilityState==="visible")router.refresh();},8000);return()=>clearInterval(timer);},[active,router]);
  return <button type="button" className="btn btn-ghost" onClick={()=>router.refresh()}>{lang==="ru"?"Обновить состояние":"Refresh status"}</button>;
}
