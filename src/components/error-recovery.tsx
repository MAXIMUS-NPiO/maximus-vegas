"use client";
import {useState,useEffect} from "react";
import {errorRecovery} from "../lib/error-recovery.ts";
export function ErrorRecovery({error,retry}:{error:Error&{digest?:string};retry:()=>void}) {
  const [path,setPath]=useState("/en");
  useEffect(()=>setPath(window.location.pathname),[]);
  const view=errorRecovery(path,error);
  return <main lang={view.lang} className="container page" role="alert" style={{maxWidth:640,margin:"64px auto",padding:24,fontFamily:"Arial, sans-serif"}}>
    <h1>{view.title}</h1><p>{view.detail}</p>
    <button type="button" className="btn btn-primary" onClick={retry}>{view.retry}</button>
    <p><a href={view.home}>{view.back}</a> · <a href={`${view.home}/status`}>{view.status}</a></p>
    {view.reference?<p>Reference: <code>{view.reference}</code></p>:null}
  </main>;
}
