import Link from "next/link";
import { ActionForm, Field } from "./ui";
import type { Locale } from "@/lib/i18n.ts";
import type { ListingDraft, MarketOrder } from "@/server/marketplace.ts";

const states:Record<string,[string,string]>={requested:["Ожидает продавца","Awaiting seller"],awaiting_payment:["Ожидает тестовой оплаты","Awaiting test payment"],payment_simulated:["Оплата смоделирована","Payment simulated"],delivery_simulated:["Передача смоделирована","Delivery simulated"],completed:["Тестовая сделка завершена","Test transaction completed"],cancelled:["Отменена","Cancelled"],disputed:["Спор: действия приостановлены","Disputed: actions paused"]};
export function PublicMarket({lang,userId,listings,orders}:{lang:Locale;userId?:string;listings:(ListingDraft&{user_id:string;username:string})[];orders:MarketOrder[]}){
 const t=(ru:string,en:string)=>lang==="ru"?ru:en,back=`/${lang}/marketplace`;
 const money=(o:{price_minor:number;currency:string})=>new Intl.NumberFormat(lang,{style:"currency",currency:o.currency}).format(o.price_minor/100);
 return <>
 <section className="section-tight stack"><h2>{t("Публичный каталог","Public catalogue")}</h2>
 <p className="notice notice-warn">{t("ТЕСТОВЫЙ РЕЖИМ. Оплата и передача только моделируются. Настоящие деньги и скины не перемещаются. Владение предметами не проверено.","TEST MODE. Payment and delivery are simulated. No real money or skins move. Item ownership is unverified.")}</p>
 <form method="get" className="form-grid"><Field label={t("Игра","Game")}><select name="game" defaultValue=""><option value="">{t("Все игры","All games")}</option><option value="cs2">Counter-Strike 2</option><option value="dota2">Dota 2</option><option value="rust">Rust</option><option value="tf2">Team Fortress 2</option></select></Field><button className="btn btn-ghost">{t("Показать","Show")}</button></form>
 {!listings.length?<p className="muted">{t("Публичных объявлений пока нет. Создайте предмет и нажмите «Опубликовать».","No public listings yet. Create an item and choose Publish.")}</p>:<div className="form-grid">{listings.map(l=><article className="card stack-sm" key={l.id}>
 <p className="eyebrow">{l.game} · {t("Тестовое объявление","Test listing")}</p><h3>{l.title}</h3><strong>{money(l)}</strong><Link href={`/${lang}/players/${l.username}`}>@{l.username}</Link>
 <p className="small muted">{t("Владение не проверено","Ownership unverified")}</p>
 {userId===l.user_id?<p>{t("Ваше объявление","Your listing")}</p>:orders.some(o=>o.listing_id===l.id&&o.buyer_id===userId&&!["cancelled","completed"].includes(o.status))?<a className="btn btn-ghost" href="#orders">{t("Перейти к заявке","View request")}</a>:userId?<ActionForm action="marketplace.request" lang={lang} back={back+"#orders"} hidden={{id:l.id}}><button className="btn btn-primary">{t("Тестовая покупка","Test purchase")}</button></ActionForm>:<Link className="btn btn-primary" href={`/${lang}/signin?next=${back}`}>{t("Войти для тестовой покупки","Sign in for test purchase")}</Link>}
 </article>)}</div>}
 </section>
 {userId?<section id="orders" className="section-tight stack"><h2>{t("Мои тестовые сделки","My test transactions")}</h2>{!orders.length?<p className="muted">{t("Заявок пока нет.","No requests yet.")}</p>:orders.map(o=>{
 const seller=o.seller_id===userId;
 const actions:[string,string][]=[];
 if(o.status==="requested"&&seller)actions.push(["accept",t("Подтвердить заявку","Accept request")]);
 if(o.status==="awaiting_payment"&&!seller)actions.push(["pay",t("Смоделировать оплату","Simulate payment")]);
 if(o.status==="payment_simulated"&&seller)actions.push(["deliver",t("Смоделировать передачу","Simulate delivery")]);
 if(o.status==="delivery_simulated"&&!seller)actions.push(["confirm",t("Подтвердить тестовое получение","Confirm test receipt")]);
 if(["requested","awaiting_payment"].includes(o.status))actions.push(["cancel",t("Отменить","Cancel")]);
 return <article className="card stack" key={o.id}><p className="eyebrow">{t("ТЕСТ · БЕЗ СПИСАНИЯ ДЕНЕГ","TEST · NO REAL PAYMENT")}</p><h3>{o.title}</h3><p>{money(o)} · @{o.seller} → @{o.buyer}</p><strong>{states[o.status]?.[lang==="ru"?0:1]??o.status}</strong>
 <div className="row">{actions.map(([step,label])=><ActionForm key={step} action="marketplace.step" lang={lang} back={back+"#orders"} hidden={{id:o.id,step}}><button className="btn btn-primary">{label}</button></ActionForm>)}</div>
 {o.case_id?<Link className="btn btn-ghost" href={`/${lang}/arbitration?case=${o.case_id}`}>{t("Открыть арбитражное дело","View arbitration case")}</Link>:o.status!=="cancelled"?<details><summary>{t("Открыть спор","Open dispute")}</summary>
 <ActionForm action="arbitration.open" lang={lang} back={back+"#orders"} hidden={{orderId:o.id,category:"marketplace",username:seller?o.buyer:o.seller,title:t("Спор: ","Dispute: ")+o.title.slice(0,120)}} className="form-card">
 <Field label={t("Обстоятельства и требование","Facts and requested resolution")}><textarea name="body" required minLength={20} maxLength={4000} rows={4}/></Field><Field label={t("Ссылка на доказательство","Evidence link")}><input type="url" name="evidence" maxLength={500}/></Field>
 <button className="btn btn-ghost">{t("Передать в арбитраж","Submit dispute")}</button></ActionForm></details>:null}
 </article>})}</section>:null}
 </>;
}
