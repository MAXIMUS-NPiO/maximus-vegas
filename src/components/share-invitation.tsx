"use client";
import { useState } from "react";
export function ShareInvitation({ url, username, team, ru }: {url:string;username:string;team:string;ru:boolean}) {
 const [copied,setCopied]=useState(false);
 const [email,setEmail]=useState("");
 const [phone,setPhone]=useState("");
 const text=ru ? `Приглашаю тебя в команду «${team}». Для тебя зарезервировано имя @${username}. Зарегистрируйся по персональной ссылке: ${url}` : `Join my team “${team}”. The username @${username} is reserved for you. Register with your personal link: ${url}`;
 return <div className="stack-sm">
 <p className="small muted">{ru?"Ссылка готова. Выберите получателя и подтвердите отправку в своём приложении.":"Link ready. Choose the recipient and confirm sending in your app."}</p>
 <input readOnly value={url} aria-label={ru?"Персональная ссылка":"Personal link"} onFocus={e=>e.target.select()} />
 <div className="row">
 <button type="button" className="btn btn-ghost btn-sm" onClick={async()=>{try{await navigator.clipboard.writeText(text);setCopied(true);}catch{setCopied(false);}}}>{copied?(ru?"Скопировано":"Copied"):(ru?"Копировать приглашение":"Copy invitation")}</button>
 <button type="button" className="btn btn-ghost btn-sm" onClick={async()=>{try{if(navigator.share) await navigator.share({text});else {await navigator.clipboard.writeText(text);setCopied(true);}}catch{}}}>{ru?"Поделиться…":"Share…"}</button>
 </div>
 <label className="field"><span>Email</span><input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder={ru?"Email получателя":"Recipient email"} /></label>
 <label className="field"><span>{ru?"Телефон для WhatsApp / SMS":"Phone for WhatsApp / SMS"}</span><input type="tel" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+971…" /></label>
 <div className="row">
 <a className="btn btn-ghost btn-sm" href={`mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(ru?"Приглашение в команду "+team:"Team invitation: "+team)}&body=${encodeURIComponent(text)}`}>Email</a>
 <a className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer" href={`https://wa.me/${phone.replace(/\D/g,"")}?text=${encodeURIComponent(text)}`}>WhatsApp</a>
 <a className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer" href={`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(ru?"Для тебя зарезервировано имя @"+username+" в команде «"+team+"»":"Your reserved name: @"+username+" in team "+team)}`}>Telegram</a>
 <a className="btn btn-ghost btn-sm" href={`sms:${phone.replace(/[^+0-9]/g,"")}?body=${encodeURIComponent(text)}`}>SMS</a>
 </div>
 </div>;
}
