import Link from "next/link";
import { dict, type Locale } from "@/lib/i18n.ts";
import type { SessionUser } from "@/server/auth.ts";
import { ActionForm, Check, Field } from "./ui";

export function ApplicationForm({
  lang,
  back,
  kinds,
  user,
  title,
}: {
  lang: Locale;
  back: string;
  kinds: string[];
  user?: SessionUser | null;
  title?: string;
}) {
  const d = dict(lang);
  return (
    <ActionForm action="application.create" lang={lang} back={back} className="card form-card">
      {title ? <h3>{title}</h3> : null}
      {kinds.length > 1 ? (
        <Field label={d.forms.topic}>
          <select name="kind" required defaultValue={kinds[0]}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {d.forms.kinds[k] ?? k}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <input type="hidden" name="kind" value={kinds[0]} />
      )}
      <div className="form-grid">
        <Field label={d.forms.name}>
          <input name="name" required maxLength={100} autoComplete="name" defaultValue={user?.displayName ?? ""} />
        </Field>
        <Field label={d.forms.email}>
          <input name="email" type="email" required maxLength={254} autoComplete="email" defaultValue={user?.email ?? ""} />
        </Field>
      </div>
      <Field label={d.forms.company} hint={d.common.optional}>
        <input name="company" maxLength={150} autoComplete="organization" />
      </Field>
      <Field label={d.forms.message}>
        <textarea name="message" rows={4} maxLength={3000} />
      </Field>
      <div className="hp" aria-hidden="true">
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <Check
        name="consent"
        required
        label={
          <>
            {d.forms.consent} — <Link href={`/${lang}/privacy`}>{lang === "ru" ? "уведомление" : "notice"}</Link>
          </>
        }
      />
      <button className="btn btn-primary" type="submit">
        {d.forms.submit}
      </button>
    </ActionForm>
  );
}
