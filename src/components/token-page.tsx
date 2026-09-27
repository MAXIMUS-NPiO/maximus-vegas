import Link from "next/link";
import type { ReactNode } from "react";
import type { Locale } from "@/lib/i18n.ts";

/** A token from an email link is only ever sent as a form field; this checks its shape before rendering it. */
export const cleanToken = (value: string) => (/^[A-Za-z0-9_-]{20,100}$/.test(value) ? value : "");

/**
 * Shell for pages opened from an email link. The link itself changes nothing: the person confirms with a
 * button (POST), so mail scanners that pre-open links cannot use up a single-use token.
 */
export function TokenShell({
  lang,
  path,
  token,
  title,
  lead,
  children,
}: {
  lang: Locale;
  path: string;
  token: string;
  title: string;
  lead?: string;
  children: ReactNode;
}) {
  const other: Locale = lang === "ru" ? "en" : "ru";
  return (
    <div className="container narrow page">
      <div className="row-between">
        <h1>{title}</h1>
        {token ? (
          <Link href={`/${other}/${path}?token=${token}`} hrefLang={other} className="text-link small">
            {other === "en" ? "English" : "Русский"}
          </Link>
        ) : null}
      </div>
      {lead ? <p className="lead">{lead}</p> : null}
      {children}
    </div>
  );
}
