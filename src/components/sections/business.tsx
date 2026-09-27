import type { Copy, Locale } from "@/lib/content";
import { ArrowUp } from "@/components/icons";

export function Business({ lang, c }: { lang: Locale; c: Copy }) {
  return (
    <section id="business" className="section container">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{c.modelLabel}</p>
          <h2>{c.modelTitle}</h2>
        </div>
        <p>{c.modelIntro}</p>
      </div>
      <div className="business-cards">
        {c.modelCards.map(([number, title, text]) => (
          <article key={number}>
            <span>{number}</span>
            <h3>{title}</h3>
            <p>{text}</p>
          </article>
        ))}
      </div>
      <div className="investor-callout">
        <div>
          <span className="eyebrow">INVESTOR RELATIONS</span>
          <h3>{c.investorTitle}</h3>
          <p>{c.investorDesc}</p>
        </div>
        <div>
          <a href="#contact" className="button button-dark">
            {c.investorCta}
            <ArrowUp />
          </a>
          <p className="callout-note">{c.investorNote}</p>
        </div>
      </div>
    </section>
  );
}
