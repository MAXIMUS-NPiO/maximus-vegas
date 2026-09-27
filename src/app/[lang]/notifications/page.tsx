import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { notificationLink, notificationText } from "@/lib/notify-text.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { notifications } from "@/server/queries.ts";
import { ActionForm, DbDown, Empty, Flash, type SearchParams } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "notifications", dict(lang).notifications.title, undefined, { noindex: true });
}

export default async function Notifications({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const sp = await searchParams;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user) redirect(`/${lang}/signin?next=/${lang}/notifications`);
  const list = await notifications(db, user.id, 100);
  const unread = list.some((n) => !n.read_at);
  return (
    <div className="container narrow page">
      <div className="row-between">
        <h1>{d.notifications.title}</h1>
        {unread ? (
          <ActionForm action="notifications.read" lang={lang} back={`/${lang}/notifications`}>
            <button className="btn btn-ghost btn-sm">{d.hub.markRead}</button>
          </ActionForm>
        ) : null}
      </div>
      <Flash lang={lang} params={sp} />
      {list.length ? (
        <ul className="list">
          {list.map((n) => (
            <li key={n.id} className={n.read_at ? undefined : "is-unread"}>
              <Link href={notificationLink(lang, n.data)} className="grow">
                {notificationText(lang, n.kind, n.data)}
              </Link>
              <span className="small muted">
                <LocalTime iso={n.created_at} lang={lang} withZone={false} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title={d.notifications.empty} />
      )}
    </div>
  );
}
