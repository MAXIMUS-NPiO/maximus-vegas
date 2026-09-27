import Link from "next/link";
import type { ReactNode } from "react";
import { dict, type Locale } from "@/lib/i18n.ts";
import type { ModuleState } from "@/lib/directions.ts";

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export function Flash({ lang, params }: { lang: Locale; params: Record<string, string | string[] | undefined> }) {
  const d = dict(lang);
  const ok = one(params.ok);
  const e = one(params.e);
  if (!ok && !e) return null;
  const text = e ? d.errors[e] ?? d.errors.server_error : d.ok[ok];
  if (!text) return null;
  return (
    <div className={e ? "flash flash-err" : "flash flash-ok"} role={e ? "alert" : "status"}>
      {text}
    </div>
  );
}

export function PageHead({ eyebrow, title, lead, children }: { eyebrow?: string; title: string; lead?: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h1>{title}</h1>
      {lead ? <p className="lead">{lead}</p> : null}
      {children ? <div className="page-head-actions">{children}</div> : null}
    </header>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-text">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function DbDown({ lang }: { lang: Locale }) {
  const d = dict(lang);
  return (
    <div className="notice notice-warn" role="status">
      <strong>{d.common.dbDownTitle}</strong>
      <p>{d.common.dbDownText}</p>
      <Link className="text-link" href={`/${lang}/status`}>
        {d.common.statusPage}
      </Link>
    </div>
  );
}

const tone: Record<string, string> = {
  REGISTRATION_OPEN: "ok",
  IN_PROGRESS: "live",
  PAUSED: "warn",
  COMPLETED: "muted",
  CANCELLED: "bad",
  ARCHIVED: "muted",
  DRAFT: "muted",
  PUBLISHED: "info",
  REGISTRATION_CLOSED: "info",
  ready: "ok",
  in_progress: "live",
  result_submitted: "warn",
  disputed: "bad",
  completed: "muted",
  pending: "muted",
  cancelled: "bad",
  registered: "ok",
  waitlisted: "warn",
  disqualified: "bad",
  not_checked_in: "muted",
  withdrawn: "muted",
  works: "ok",
  connect: "info",
  dev: "warn",
  research: "muted",
  new: "warn",
  in_review: "info",
  closed: "muted",
  open: "bad",
  resolved: "ok",
  confirmed: "ok",
  superseded: "muted",
  rejected: "bad",
};

export function Badge({ status, children }: { status: string; children: ReactNode }) {
  return <span className={`badge badge-${tone[status] ?? "muted"}`}>{children}</span>;
}

export function StateBadge({ lang, state }: { lang: Locale; state: ModuleState }) {
  return <Badge status={state}>{dict(lang).moduleStatus[state]}</Badge>;
}

/** Hidden fields every action form carries. */
export function FormMeta({ lang, back }: { lang: Locale; back: string }) {
  return (
    <>
      <input type="hidden" name="lang" value={lang} />
      <input type="hidden" name="back" value={back} />
    </>
  );
}

export function ActionForm({
  action,
  lang,
  back,
  children,
  className,
  hidden,
}: {
  action: string;
  lang: Locale;
  back: string;
  children: ReactNode;
  className?: string;
  hidden?: Record<string, string>;
}) {
  return (
    <form method="post" action={`/api/a/${action}?lang=${lang}`} className={className}>
      <FormMeta lang={lang} back={back} />
      {hidden ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
      {children}
    </form>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Check({ name, label, defaultChecked, required }: { name: string; label: ReactNode; defaultChecked?: boolean; required?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} required={required} />
      <span>{label}</span>
    </label>
  );
}

export function SignInPrompt({ lang, back }: { lang: Locale; back: string }) {
  const d = dict(lang);
  return (
    <div className="notice">
      <p>{d.common.signInToContinue}</p>
      <div className="row">
        <Link className="btn btn-primary btn-sm" href={`/${lang}/signin?next=${encodeURIComponent(back)}`}>
          {d.nav.signIn}
        </Link>
        <Link className="btn btn-ghost btn-sm" href={`/${lang}/signup`}>
          {d.nav.signUp}
        </Link>
      </div>
    </div>
  );
}

export const gameName = async (slug: string) => {
  const { gameBySlug } = await import("@/lib/games.ts");
  return gameBySlug(slug)?.name ?? slug;
};
