import type { Copy, Locale } from "@/lib/content";
import { ProductIcon } from "@/components/icons";

export function Ecosystem({ lang, c }: { lang: Locale; c: Copy }) {
  return (
    <section id="ecosystem" className="section container">
      <div className="section-heading">
        <div>
          <p className="eyebrow">{c.ecoLabel}</p>
          <h2>{c.ecoTitle}</h2>
        </div>
        <p>{c.ecoDesc}</p>
      </div>
      <div className="products">
        {c.products.map((product, i) => (
          <article className={`product product-${i}`} key={product.name}>
            <div className="product-top">
              <ProductIcon kind={i} />
              <span>{product.tag}</span>
            </div>
            <h3>
              {product.name}
              <span>↗</span>
            </h3>
            <h4>{product.title}</h4>
            <p>{product.description}</p>
            <ul>
              {product.features.map((f) => (
                <li key={f}>
                  <span aria-hidden="true">+</span>
                  {f}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
      <div className="foundation">
        <span>{c.foundation}</span>
        <ul>
          {c.foundations.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
