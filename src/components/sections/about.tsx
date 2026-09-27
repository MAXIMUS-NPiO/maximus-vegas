import type { Copy, Locale } from "@/lib/content";

export function About({ lang, c }: { lang: Locale; c: Copy }) {
  return (
    <section id="about" className="section about-section">
      <div className="container about-layout">
        <div>
          <p className="eyebrow">{c.aboutLabel}</p>
          <h2>{c.aboutTitle}</h2>
          <p className="about-description">{c.aboutDesc}</p>
        </div>
        <div className="company-card">
          <span className="eyebrow">MAXIMUS VEGAS LLC FZ</span>
          <span className="company-location">25°12′N 55°16′E</span>
          <p>{c.location}</p>
          <div className="founders">
            <span>{c.founders}</span>
            <strong>
              Kenan Duman
              <br />
              Maximus Kiriyakulov
            </strong>
          </div>
        </div>
      </div>
    </section>
  );
}
