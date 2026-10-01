import { notFound } from "next/navigation";
import { connection } from "next/server";
import { isLocale } from "@/lib/i18n.ts";
import { mediaText } from "@/lib/media-text.ts";
import { getDb } from "@/server/db.ts";
import { overlayData } from "@/server/streams.ts";
import { matchLabel } from "@/components/tournament";
import { AutoRefresh } from "@/components/stream-player";

/**
 * Broadcast overlay of a public match for a browser source (OBS and similar): transparent background,
 * names and score from the match record, refreshed every 10 seconds (MV-MEDIA-1).
 */
export default async function MatchOverlay({ params }: { params: Promise<{ lang: string; id: string }> }) {
  await connection();
  const { lang, id } = await params;
  if (!isLocale(lang) || !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const x = mediaText[lang];
  const db = await getDb().catch(() => null);
  const o = db ? await overlayData(db, id) : null;
  if (!o) notFound();
  const m = o.match;
  const label = matchLabel(m, { format: m.t_format, playoffFormat: o.playoffFormat, wRounds: m.w_rounds, lRounds: m.l_rounds, gRounds: m.bracket === "G" ? m.rounds : 0 }, lang);
  const side = (name: string | null, won: boolean) => <span className={won ? "overlay-name is-winner" : "overlay-name"}>{name ?? x.tbd}</span>;
  return (
    <div className="overlay-root">
      <style>{"html,body{background:transparent!important}"}</style>
      <AutoRefresh seconds={10} />
      <div className="overlay-bar">
        <p className="overlay-meta">
          {m.t_name} · {label}
          {o.bestOf > 1 ? ` · Bo${o.bestOf}` : ""}
        </p>
        <div className="overlay-score">
          {side(o.a, o.winner === "a")}
          <span className="overlay-num">{o.score.a ?? x.noScore}</span>
          <span className="overlay-sep">:</span>
          <span className="overlay-num">{o.score.b ?? x.noScore}</span>
          {side(o.b, o.winner === "b")}
        </div>
        {o.score.state === "reported" ? <p className="overlay-note">{x.reported}</p> : o.score.state === "official" ? <p className="overlay-note">{x.final}</p> : null}
      </div>
    </div>
  );
}
