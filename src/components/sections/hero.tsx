import type { Copy, Locale } from "@/lib/content";
import { Arrow, ArrowUp, ProductIcon } from "@/components/icons";

export function Hero({ lang, c }: { lang: Locale; c: Copy }) {
  return (
    <section className="hero container" aria-labelledby="hero-heading">
      <div className="hero-copy">
        <p className="eyebrow">
          <span className="small-cross">+</span>
          {c.eyebrow}
        </p>
        <h1 id="hero-heading">
          {c.headline[0]}
          <br />
          <span>{c.headline[1]}</span>
        </h1>
        <p className="hero-description">{c.intro}</p>
        <div className="hero-buttons">
          <a className="button" href="#contact">
            {c.primary}
            <ArrowUp />
          </a>
          <a href="#ecosystem" className="text-link">
            {c.secondary}
            <Arrow />
          </a>
        </div>
        <p className="hero-note">
          <span className="mini-rule" />
          {c.heroNote}
        </p>
      </div>
      <div
        className="architecture"
        role="img"
        aria-label={`${c.diagramBrand} — Tournament Suite: Organizer, Arena, Admin.`}
      >
        <div className="architecture-heading">
          <span>{c.diagramTop}</span>
          <span>MV—01</span>
        </div>
        <div className="architecture-brand">
          {c.diagramBrand}
          <span>WHITE-LABEL</span>
        </div>
        <div className="connector-line" />
        <div className="architecture-core">
          <span className="core-icon">✳</span>
          <div>
            <strong>Tournament Suite</strong>
            <span>{c.diagramSub}</span>
          </div>
          <span className="core-plus">+</span>
        </div>
        <div className="architecture-branches">
          {c.diagramItems.map(([name, text], i) => (
            <div key={name}>
              <ProductIcon kind={i} />
              <strong>{name}</strong>
              <span>{text}</span>
            </div>
          ))}
        </div>
        <div className="architecture-base">{c.diagramFoundation}</div>
        <div className="architecture-bottom">
          <span>MAXIMUS VEGAS</span>
          <span>CONNECTED BY DESIGN</span>
        </div>
      </div>
    </section>
  );
}
