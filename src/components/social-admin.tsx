import type { Database } from "@/server/db.ts";
import type { SessionUser } from "@/server/auth.ts";
import type { Locale } from "@/lib/i18n.ts";
import { socialReports } from "@/server/social.ts";
import { ActionForm, Check, Field } from "./ui";
export async function SocialAdmin({ db, user, lang, back }: { db: Database; user: SessionUser; lang: Locale; back: string }) {
  const T = (ru: string, en: string) => lang === "ru" ? ru : en;
  const reports = await socialReports(db, user);
  return <section className="section-tight"><h2>{T("Жалобы: знакомства 18+", "Reports: connections 18+")}</h2>{!reports.length && <p>{T("Открытых жалоб нет.", "No open reports.")}</p>}{reports.map(r => <article className="card" key={r.id}><h3>@{r.subject}</h3><p>{T("От", "From")} @{r.reporter}</p><p className="prewrap">{r.reason}</p>{r.excerpt && <blockquote>{r.excerpt}</blockquote>}<ActionForm action="social.resolve" lang={lang} back={back} hidden={{ report: r.id }}><Field label={T("Решение и основание", "Decision and reason")}><textarea name="decision" minLength={10} maxLength={1000} required /></Field><Check name="hide" label={T("Приостановить профиль и закрыть общение", "Suspend profile and close conversations")} /><button className="btn btn-primary">{T("Закрыть жалобу", "Resolve report")}</button></ActionForm></article>)}</section>;
}
