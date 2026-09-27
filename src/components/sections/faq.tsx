import type { Copy, Locale } from "@/lib/content";

export function Faq({ lang, c }: { lang: Locale; c: Copy }) {
  return (
    <section className="section container faq-section">
      <p className="eyebrow">{c.faqLabel}</p>
      <div className="faq-list">
        {c.faqs.map(([q, a]) => (
          <details key={q}>
            <summary>
              {q}
              <span aria-hidden="true">+</span>
            </summary>
            <p>{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
