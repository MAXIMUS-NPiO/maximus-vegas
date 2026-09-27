import type { Copy, Locale } from "@/lib/content";
import { ArrowUp, Brand } from "@/components/icons";
import Link from "next/link";

export function Footer({ lang, c }: { lang: Locale; c: Copy }) {
  return (
    <footer className="footer container">
      <div className="footer-top">
        <Link href={`/${lang}`} aria-label="MAXIMUS VEGAS">
          <Brand />
        </Link>
        <p>{c.footer}</p>
        <a className="text-link" href="#main">
          {c.back}
          <ArrowUp />
        </a>
      </div>
      <div className="footer-bottom">
        <span>
          © {new Date().getFullYear()} MAXIMUS VEGAS LLC FZ. {c.rights}
        </span>
        <Link href={`/${lang}/privacy`}>{c.form.privacy}</Link>
        <span>DUBAI, UAE</span>
      </div>
    </footer>
  );
}
