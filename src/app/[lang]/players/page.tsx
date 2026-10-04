import { publicExperienceBadges } from "@/server/player-experience.ts";
import { MemberAvatar } from "@/components/member-avatar";
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { dict, isLocale } from "@/lib/i18n.ts";
import { pageMeta } from "@/lib/meta.ts";
import { viewer } from "@/server/viewer.ts";
import { listPlayers } from "@/server/queries.ts";
import { DbDown, Empty, one, PageHead, type SearchParams } from "@/components/ui";

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return pageMeta(lang, "players", dict(lang).players.title, dict(lang).players.lead);
}

export default async function Players({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: SearchParams }) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();
  const d = dict(lang);
  const q = one((await searchParams).q).slice(0, 40);
  const { db, dbError } = await viewer();
  const list = db ? await listPlayers(db, q).catch(() => []) : [];
  const experienceBadges = db ? await publicExperienceBadges(db, list.map(p => p.username)) : new Map<string, string[]>();
  return (
    <div className="container page">
      <PageHead title={d.players.title} lead={d.players.lead} />
      <form method="get" className="inline-form toolbar">
        <input name="q" defaultValue={q} placeholder={d.players.searchPlaceholder} aria-label={d.players.searchPlaceholder} maxLength={40} />
        <button className="btn btn-ghost btn-sm">{d.common.search}</button>
      </form>
      {dbError ? (
        <DbDown lang={lang} />
      ) : list.length ? (
        <div className="grid grid-4">
          {list.map((p) => (
            <Link key={p.username} href={`/${lang}/players/${p.username}`} className="card card-link player-card">
              <MemberAvatar name={p.display_name} mediaId={p.avatar_media_id} size="lg" />
              <strong>{p.display_name}</strong>
              <span className="small muted">@{p.username}</span>
              {experienceBadges.get(p.username)?.length ? <span className="badge badge-info">{lang === "ru" ? "Опыт" : "Experience"}: {experienceBadges.get(p.username)!.join(" · ")}</span> : null}
              <span className="small">
                {p.wins} {lang === "ru" ? "побед в MAXIMUS" : "MAXIMUS wins"}
                {p.country ? ` · ${p.country}` : ""}
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <Empty title={d.players.empty} />
      )}
    </div>
  );
}
