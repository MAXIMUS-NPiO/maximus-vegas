import Link from "next/link";
import type { Locale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { academyText } from "@/lib/academy-text.ts";
import type { Database } from "@/server/db.ts";
import { coachReviewQueue } from "@/server/academy.ts";
import { ActionForm, Badge, Empty, Field } from "@/components/ui";
import { LocalTime } from "@/components/time";

/** Control-centre tab (academy section): coaches waiting for verification, and verified or suspended ones. */
export async function AcademyTab({ db, lang, back }: { db: Database; lang: Locale; back: string }) {
  const x = academyText[lang];
  const rows = await coachReviewQueue(db);
  const queue = rows.filter((r) => r.status === "submitted");
  const live = rows.filter((r) => r.status !== "submitted");
  const card = (c: (typeof rows)[number]) => (
    <li key={c.user_id} className="stack-sm">
      <span className="row">
        <Link href={`/${lang}/coaches/${c.username}`} className="msg-title">
          {c.display_name} @{c.username}
        </Link>
        <Badge status={c.status === "verified" ? "ok" : c.status === "submitted" ? "info" : "bad"}>{x.statuses[c.status]}</Badge>
      </span>
      <span className="small">
        {c.headline} · {c.games.map((g) => gameBySlug(g)?.name ?? g).join(", ")} · <LocalTime iso={c.updated_at} lang={lang} />
      </span>
      <p className="small prewrap">
        <strong>{x.experience}:</strong> {c.experience}
      </p>
      <ActionForm action="coach.review" lang={lang} back={back} hidden={{ coach: c.user_id }} className="stack-sm">
        <Field label={x.staffNote}>
          <textarea name="note" maxLength={500} rows={2} />
        </Field>
        <div className="row">
          {c.status === "submitted" ? (
            <>
              <button className="btn btn-primary btn-sm" name="decision" value="verify">
                {x.verify}
              </button>
              <button className="btn btn-ghost btn-sm" name="decision" value="reject">
                {x.reject}
              </button>
            </>
          ) : c.status === "verified" ? (
            <button className="btn btn-danger btn-sm" name="decision" value="suspend">
              {x.suspend}
            </button>
          ) : null}
        </div>
      </ActionForm>
    </li>
  );
  return (
    <div className="stack">
      <h2 className="h3">{x.queueTab}</h2>
      <p className="small muted">{x.queueLead}</p>
      <section className="stack-sm">
        <h3 className="h4">{x.review}</h3>
        {queue.length ? <ul className="list">{queue.map(card)}</ul> : <Empty title={x.none} />}
      </section>
      {live.length ? (
        <section className="stack-sm">
          <h3 className="h4">{x.live}</h3>
          <ul className="list">{live.map(card)}</ul>
        </section>
      ) : null}
    </div>
  );
}
