import type { Copy, Locale } from "@/lib/content";

export function Metrics({ lang, c }: { lang: Locale; c: Copy }) {
  return (
    <section
      className="metric-strip"
      aria-label={lang === "ru" ? "О платформе" : "Platform at a glance"}
    >
      <div className="container metrics">
        {c.metrics.map(([value, label]) => (
          <div key={value}>
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
