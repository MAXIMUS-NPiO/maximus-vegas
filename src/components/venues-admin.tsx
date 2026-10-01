import Link from "next/link";
import type { Locale } from "@/lib/i18n.ts";
import { countryName } from "@/lib/countries.ts";
import { venueText } from "@/lib/venue-text.ts";
import type { Database } from "@/server/db.ts";
import { venueReviewQueue } from "@/server/venues.ts";
import { ActionForm, Badge, Empty, Field } from "@/components/ui";
import { LocalTime } from "@/components/time";

const T = {
  ru: {
    title: "Площадки",
    lead: "Подтверждайте только проверенные адрес и статус: опубликованная площадка видна всем, турниры на ней выдают QR-пропуска. Общий стол по корпоративному договору — не игровой клуб.",
    queue: "На проверке",
    live: "Подтверждённые и приостановленные",
    none: "Площадок на проверке нет.",
    note: "Ответ (для отклонения и приостановки — от 10 символов)",
    confirm: "Подтвердить",
    reject: "Отклонить",
    suspend: "Приостановить",
    space: "Пространство",
  },
  en: {
    title: "Venues",
    lead: "Confirm only a checked address and status: a published venue is visible to everyone and its tournaments issue QR passes. A shared desk under a corporate contract is not a gaming club.",
    queue: "In review",
    live: "Confirmed and suspended",
    none: "No venues in review.",
    note: "Answer (10 characters or more to reject or suspend)",
    confirm: "Confirm",
    reject: "Reject",
    suspend: "Suspend",
    space: "Space",
  },
};

/** Control-centre tab: venue confirmation queue and published venues. */
export async function VenuesTab({ db, lang, back }: { db: Database; lang: Locale; back: string }) {
  const x = T[lang];
  const v = venueText[lang];
  const rows = await venueReviewQueue(db);
  const queue = rows.filter((r) => r.status === "submitted");
  const live = rows.filter((r) => r.status !== "submitted");
  const card = (r: (typeof rows)[number]) => (
    <li key={r.id} className="stack-sm">
      <span>
        <Link href={`/${lang}/venues/${r.slug}`}>{r.name}</Link> · {v.kinds[r.kind]} ·{" "}
        <Badge status={r.status === "confirmed" ? "ok" : r.status === "submitted" ? "info" : "bad"}>{v.statuses[r.status]}</Badge>
      </span>
      <span className="small">
        {r.address}, {r.city}
        {r.country_code ? `, ${countryName(r.country_code, lang)}` : ""} · {x.space}: {r.org_name} · <LocalTime iso={r.updated_at} lang={lang} />
      </span>
      {r.website ? (
        <a href={r.website} target="_blank" rel="noopener nofollow" className="small break-all">
          {r.website}
        </a>
      ) : null}
      {r.description ? <p className="small muted prewrap">{r.description}</p> : null}
      <ActionForm action="venue.review" lang={lang} back={back} hidden={{ venue: r.id }} className="stack-sm">
        <Field label={x.note}>
          <textarea name="note" maxLength={500} rows={2} />
        </Field>
        <div className="row">
          {r.status === "submitted" ? (
            <>
              <button className="btn btn-primary btn-sm" name="decision" value="confirm">
                {x.confirm}
              </button>
              <button className="btn btn-ghost btn-sm" name="decision" value="reject">
                {x.reject}
              </button>
            </>
          ) : r.status === "confirmed" ? (
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
      <h2 className="h3">{x.title}</h2>
      <p className="small muted">{x.lead}</p>
      <section className="stack-sm">
        <h3 className="h4">{x.queue}</h3>
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
