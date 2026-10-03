import { PublicMarket } from "@/components/marketplace-public";
import Link from "next/link";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { SKIN_GAMES, MARKET_CURRENCIES, listingDrafts, publicListings, myMarketOrders } from "@/server/marketplace.ts";
import { ActionForm, DbDown, Field, Flash, PageHead, SignInPrompt, type SearchParams } from "@/components/ui";
export async function generateMetadata({params}:{params:Promise<{lang:string}>}) {
 const {lang}=await params;return isLocale(lang)?pageMeta(lang,"marketplace","Skins Marketplace",undefined,{noindex:true}):{};
}
export default async function Marketplace({params,searchParams}:{params:Promise<{lang:string}>;searchParams:SearchParams}) {
 const {lang}=await params;if(!isLocale(lang))notFound();
 const t=(ru:string,en:string)=>lang==="ru"?ru:en,back=`/${lang}/marketplace`;
 const {db,user,dbError}=await viewer();
 if(dbError||!db)return <div className="container page"><DbDown lang={lang}/></div>;
 const drafts=user?await listingDrafts(db,user.id):[];
 const sp=await searchParams,game=typeof sp.game==="string"?sp.game:"";
 const listings=await publicListings(db,game),orders=user?await myMarketOrders(db,user.id):[];
 return <div className="container narrow page">
 <PageHead title="Skins Marketplace" lead={t("Публичные объявления · тестовые сделки","Public listings · test transactions")}><Link className="btn btn-ghost" href={`/${lang}/arbitration`}>{t("Арбитраж","Arbitration")}</Link></PageHead>
 <Flash lang={lang} params={await searchParams}/>
 <PublicMarket lang={lang} userId={user?.id} listings={listings} orders={orders}/>
 {!user?<SignInPrompt lang={lang} back={back}/>:<>
 <section className="section-tight stack"><h2 className="h3">{t("Мои объявления","My listings")}</h2>
 {!drafts.length?<p>{t("Сохранённых предметов пока нет.","No saved items yet.")}</p>:drafts.map(d=><article className="card stack-sm" key={d.id}>
 <strong>{d.title}</strong><p>{SKIN_GAMES[d.game as keyof typeof SKIN_GAMES]} · {new Intl.NumberFormat(lang,{style:"currency",currency:d.currency}).format(d.price_minor/100)}</p><p className="small muted">{d.published?t("Опубликовано · тестовое объявление","Published · test listing"):t("Черновик","Draft")}</p>
 <ActionForm action="marketplace.publish" lang={lang} back={back} hidden={{id:d.id,publish:d.published?"0":"1"}}><button className="btn btn-primary">{d.published?t("Снять с публикации","Unpublish"):t("Опубликовать","Publish")}</button></ActionForm>
 <ActionForm action="marketplace.delete" lang={lang} back={back} hidden={{id:d.id}}><button className="btn btn-ghost btn-sm">{t("Удалить черновик","Delete draft")}</button></ActionForm></article>)}</section>
 <section className="section-tight"><h2 className="h3">{t("Подготовить предмет","Prepare an item")}</h2>
 <ActionForm action="marketplace.save" lang={lang} back={back} className="card form-card">
 <Field label={t("Игра","Game")}><select name="game">{Object.entries(SKIN_GAMES).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></Field>
 <Field label={t("Название предмета","Item name")}><input name="title" required minLength={3} maxLength={150}/></Field>
 <Field label={t("Идентификатор предмета в инвентаре","Inventory item identifier")}><input name="asset" required maxLength={100} pattern="(?:[a-zA-Z0-9:_]|-)+"/></Field>
 <div className="form-grid"><Field label={t("Желаемая цена","Asking price")}><input name="price" type="number" inputMode="decimal" min="0.01" max="1000000" step="0.01" required/></Field><Field label={t("Валюта","Currency")}><select name="currency">{MARKET_CURRENCIES.map(c=><option key={c}>{c}</option>)}</select></Field></div>
 <button className="btn btn-primary" disabled={Boolean(user.restricted)}>{t("Сохранить черновик","Save draft")}</button></ActionForm></section></>}
 </div>;
}
