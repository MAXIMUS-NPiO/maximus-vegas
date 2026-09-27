import Link from "next/link";
import { Brand } from "./icons";
import { dict, type Locale } from "@/lib/i18n.ts";
import { contactEmail } from "@/lib/site.ts";

export function Footer({ lang }: { lang: Locale }) {
  const d = dict(lang);
  const email = contactEmail();
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div className="footer-brand">
          <Brand />
          <p>{d.footer.tagline}</p>
          <p className="footer-note">{d.footer.noGambling}</p>
        </div>
        {d.footer.columns.map(([title, links]) => (
          <div key={title} className="footer-col">
            <p className="footer-title">{title}</p>
            <ul>
              {links.map(([slug, label]) => (
                <li key={slug}>
                  <Link href={`/${lang}/${slug}`}>{label}</Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="container footer-bottom">
        <span>© 2026 {d.footer.company}</span>
        <a href={`mailto:${email}`}>{email}</a>
      </div>
    </footer>
  );
}
