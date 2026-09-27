import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { IP_DIRECTIONS, MODULES, t, type ModuleState } from "@/lib/directions.ts";
import { pageMeta } from "@/lib/meta.ts";
import { PageHead, StateBadge } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "innovations", dict(lang).innovations.title, dict(lang).innovations.lead);
}

export default async function Innovations({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const order: ModuleState[] = ["works", "connect", "dev", "research"];
  return (
    <div className="container page">
      <PageHead title={d.innovations.title} lead={d.innovations.lead} />
      {order.map((state) => (
        <section key={state} className="section-tight">
          <h2 className="h3">
            <StateBadge lang={lang} state={state} />
          </h2>
          <div className="grid grid-3">
            {MODULES.filter((m) => m.state === state).map((m) => (
              <div key={m.name.en} className="card">
                <h3>{t(m.name, lang)}</h3>
                <p className="muted small">{t(m.note, lang)}</p>
              </div>
            ))}
          </div>
        </section>
      ))}
      <section className="section-tight">
        <h2 className="h3">{d.innovations.ipTitle}</h2>
        <ul className="bullets">
          {IP_DIRECTIONS.map((x) => (
            <li key={x.en}>{t(x, lang)}</li>
          ))}
        </ul>
        <p className="small muted">{d.innovations.ipNote}</p>
      </section>
    </div>
  );
}
