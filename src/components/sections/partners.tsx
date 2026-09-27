import type { Copy, Locale } from "@/lib/content";
import { ArrowUp } from "@/components/icons";

export function Partners({ lang, c }: { lang: Locale; c: Copy }) {
  return (
    <section id="partners" className="section partner-section">
      <div className="container partner-layout">
        <div className="partner-heading">
          <p className="eyebrow">{c.partnerLabel}</p>
          <h2>{c.partnerTitle}</h2>
          <p>{c.partnerDesc}</p>
          <a href="#contact" className="text-link">
            {c.primary}
            <ArrowUp />
          </a>
        </div>
        <div className="partner-list">
          {c.partners.map(([title, text], i) => (
            <article key={title}>
              <span className="list-number">0{i + 1}</span>
              <div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
              <ArrowUp />
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
