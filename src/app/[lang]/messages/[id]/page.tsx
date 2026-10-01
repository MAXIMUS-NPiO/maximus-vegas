import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { messageText } from "@/lib/message-text.ts";
import { viewer } from "@/server/viewer.ts";
import { openMessage } from "@/server/messages.ts";
import { DbDown, SignInPrompt } from "@/components/ui";
import { LocalTime } from "@/components/time";

export async function generateMetadata({ params }: { params: Promise<{ lang: string; id: string }> }): Promise<Metadata> {
  const { lang, id } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, `messages/${id}`, messageText[lang].page.from, undefined, { noindex: true });
}

/** A portal-team message, shown only to an account it was delivered to; opening it is recorded once. */
export default async function MessagePage({ params }: { params: Promise<{ lang: string; id: string }> }) {
  const { lang, id } = await params;
  if (!isLocale(lang)) notFound();
  const x = messageText[lang].page;
  const { db, user, dbError } = await viewer();
  if (dbError || !db)
    return (
      <div className="container page">
        <DbDown lang={lang} />
      </div>
    );
  if (!user)
    return (
      <div className="container narrow page">
        <SignInPrompt lang={lang} back={`/${lang}/messages/${id}`} />
      </div>
    );
  const m = /^[0-9a-f-]{36}$/i.test(id) ? await openMessage(db, user.id, id) : null;
  if (!m) notFound();
  return (
    <div className="container narrow page">
      <p className="eyebrow">{x.from}</p>
      <h1>{m.title}</h1>
      <p className="small muted">
        <LocalTime iso={m.sent_at} lang={lang} />
      </p>
      <p className="prewrap">{m.body}</p>
      <p className="small muted section-tight">
        {m.kind === "marketing" ? (
          <>
            {x.marketingNote}{" "}
            <Link href={`/${lang}/settings#consents`} className="text-link">
              {x.settings}
            </Link>
          </>
        ) : (
          x.operationalNote
        )}
      </p>
    </div>
  );
}
