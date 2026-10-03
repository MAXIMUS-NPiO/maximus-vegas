"use client";
import { useState } from "react";
export function ShareInvitation({url,username,team,ru}:{url:string;username:string;team:string;ru:boolean}){
 const [channel,setChannel]=useState("email"),[recipient,setRecipient]=useState(""),[status,setStatus]=useState("");
 const t=(a:string,b:string)=>ru?a:b;
 const text=t(`Приглашаю тебя в команду «${team}». Для тебя зарезервировано имя @${username}. Зарегистрируйся по персональной ссылке: ${url}`,`Join my team “${team}”. The username @${username} is reserved for you. Register with your personal link: ${url}`);
 const phone=recipient.replace(/[^0-9]/g,"");
 const valid=channel==="email"?/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient):channel==="whatsapp"||channel==="sms"?/^[1-9][0-9]{6,14}$/.test(phone):true;
 const href=channel==="email"?`mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(t("Приглашение в команду ","Team invitation: ")+team)}&body=${encodeURIComponent(text)}`:channel==="whatsapp"?`https://wa.me/${phone}?text=${encodeURIComponent(text)}`:channel==="sms"?`sms:+${phone}?body=${encodeURIComponent(text)}`:`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(t("Имя @","Username @")+username+" · "+team)}`;
 return <div className="stack" style={{scrollMarginTop:"100px"}}>
 <h4>{t("Следующий шаг — отправить приглашение","Next step — send the invitation")}</h4>
 <p className="notice notice-warn">{t("Имя зарезервировано. Приглашение ещё никому не отправлено.","Username reserved. The invitation has not been sent to anyone yet.")}</p>
 <label className="field"><span>{t("Способ отправки","Delivery method")}</span><select value={channel} onChange={e=>{setChannel(e.target.value);setRecipient("");setStatus("");}}><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="telegram">Telegram</option><option value="sms">SMS</option><option value="copy">{t("Копировать ссылку","Copy link")}</option></select></label>
 {["email","whatsapp","sms"].includes(channel)?<label className="field"><span>{channel==="email"?t("Email получателя","Recipient email"):t("Номер получателя с кодом страны","Recipient phone with country code")}</span><input type={channel==="email"?"email":"tel"} value={recipient} onChange={e=>setRecipient(e.target.value)} placeholder={channel==="email"?"player@example.com":"+971…"} autoComplete="off"/></label>:null}
 {channel==="telegram"?<p>{t("Telegram откроет выбор получателя. Выберите игрока и нажмите «Отправить».","Telegram opens its recipient chooser. Select the player and press Send.")}</p>:null}
 <input readOnly value={url} aria-label={t("Персональная ссылка","Personal link")} onFocus={e=>e.target.select()}/>
 {channel==="copy"?<button className="btn btn-primary" type="button" onClick={async()=>{try{await navigator.clipboard.writeText(text);setStatus(t("Приглашение скопировано. Вставьте его в сообщение игроку.","Invitation copied. Paste it into a message to the player."));}catch{setStatus(t("Не удалось скопировать автоматически. Выделите ссылку выше.","Automatic copy failed. Select the link above."));}}}>{t("Копировать приглашение","Copy invitation")}</button>:valid?<a className="btn btn-primary" href={href} target={["telegram","whatsapp"].includes(channel)?"_blank":undefined} rel="noopener noreferrer" onClick={()=>setStatus(t("Открыто приложение для отправки. Подтвердите отправку там. Доставка здесь не подтверждена.","Opened the sending app. Confirm sending there. Delivery is not confirmed here."))}>{channel==="email"?t("Открыть письмо для отправки","Open invitation email"):t("Открыть ","Open ")+({whatsapp:"WhatsApp",telegram:"Telegram",sms:"SMS"}[channel]??"")}</a>:<p className="small muted">{t("Введите корректный адрес получателя, чтобы перейти к отправке.","Enter a valid recipient to continue to sending.")}</p>}
 {status?<p role="status">{status}</p>:null}
 <p className="small muted">{t("Отправку подтверждаете вы в выбранном приложении. Резерв имени сам по себе не отправляет сообщение.","You confirm sending in the selected app. Reserving a name does not send a message.")}</p>
 </div>;
}
