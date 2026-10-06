import { componentReadiness } from "@/lib/component-readiness.ts";
import { voiceAvailable } from "@/server/community-voice.ts";
import { broadcastAvailability } from "@/server/broadcast-config.ts";
import { featureEnabled, maintenanceState } from "@/server/system.ts";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { MODULES, t, type ModuleState } from "@/lib/directions.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { ping } from "@/server/queries.ts";
import { mailConfigured } from "@/server/mail.ts";
import { paymentReadiness, publicOffer } from "@/server/billing.ts";
import { emailFirstMode } from "@/server/accounts.ts";
import { Badge, PageHead, StateBadge } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "status", dict(lang).status.title, dict(lang).status.lead);
}

export default async function Status({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const { db } = await viewer();
  let latency: number | null = null;
  if (db) latency = await ping(db).catch(() => null);
  const ru = lang === "ru";
  const T = (a: string, b: string) => (ru ? a : b);
  const mail = mailConfigured();
  const offer = db && latency !== null ? await publicOffer(db).catch(() => null) : null;
  const pay = paymentReadiness(offer);
  const components = componentReadiness(
    !!db && latency !== null && await featureEnabled(db,"connections") && !(await maintenanceState(db)).on,
    !!db && latency !== null && await voiceAvailable(db).catch(()=>false),
    !!db && latency !== null && (await broadcastAvailability(db).catch(()=>({ready:false}))).ready,
  );
  const order: ModuleState[] = ["works", "connect", "dev", "research"];
  return (
    <div className="container page">
      <PageHead title={d.status.title} lead={d.status.lead} />
      <section className="card">
        <p className="field-label">{d.status.live}</p>
        <div className="row-between">
          <span>{d.status.database}</span>
          {latency !== null ? (
            <Badge status="works">
              {d.status.ok} · {d.status.latency} {latency} ms
            </Badge>
          ) : (
            <Badge status="rejected">{d.status.down}</Badge>
          )}
        </div>
        <div className="row-between">
          <span>{T("Регистрация", "Sign-up")}</span>
          {latency !== null ? (
            <Badge status="works">{emailFirstMode() ? T("Открыта · с подтверждением email", "Open · with email confirmation") : T("Открыта", "Open")}</Badge>
          ) : (
            <Badge status="rejected">{d.status.down}</Badge>
          )}
        </div>
        <div className="row-between">
          <span>{T("Служебные письма", "Service emails")}</span>
          {mail ? <Badge status="works">{T("Настроены · доставка не подтверждена", "Configured · delivery unverified")}</Badge> : <Badge status="dev">{T("Не подключены", "Not connected")}</Badge>}
        </div>
        <div className="row-between">
          <span>{T("Онлайн-оплата членства", "Online membership payment")}</span>
          {pay.ready ? (
            <Badge status="works">{pay.mode === "live" ? T("Настроена · приёмка не подтверждена", "Configured · acceptance unverified") : T("Тестовый режим", "Test mode")}</Badge>
          ) : (
            <Badge status="dev">{T("Не включена", "Not enabled")}</Badge>
          )}
        </div>
        <p className="small muted">
          <LocalTime iso={new Date()} lang={lang} />
        </p>
      </section>
      <section className="section-tight">
        <h2 className="h3">{T("Готовность компонентов", "Component readiness")}</h2>
        <p>{T("Временный сбор оплаты членства через MPGS Maximus Sports по утверждённому внутреннему соглашению; получатель — MAXIMUS VEGAS L.L.C-FZ. Турниры без платного входа и денежных призов. Маркетплейс скинов — симуляция TEST MODE.", "Temporary membership collection through Maximus Sports MPGS under the approved internal arrangement; beneficiary: MAXIMUS VEGAS L.L.C-FZ. No paid tournament entry or cash prizes. Skins marketplace: simulated TEST MODE.")}</p>
        <div className="table-wrap"><table className="table"><tbody>{components.map(row=><tr key={row.id}><td><strong>{t(row.name,lang)}</strong><p className="small muted">{t(row.note,lang)}</p></td><td><StateBadge lang={lang} state={row.state}/></td></tr>)}</tbody></table></div>
      </section>
      <section className="section-tight">
        <h2 className="h3">{d.status.registry}</h2>
        <p className="muted">{d.status.registryLead}</p>
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {order.flatMap((state) =>
                MODULES.filter((m) => m.state === state).map((m) => (
                  <tr key={m.name.en}>
                    <td>
                      <strong>{t(m.name, lang)}</strong>
                      <div className="small muted">{t(m.note, lang)}</div>
                    </td>
                    <td className="nowrap">
                      <StateBadge lang={lang} state={m.state} />
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
