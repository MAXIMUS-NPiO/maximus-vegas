import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { MODULES, t, type ModuleState } from "@/lib/directions.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { ping } from "@/server/queries.ts";
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
        <p className="small muted">
          <LocalTime iso={new Date()} lang={lang} />
        </p>
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
