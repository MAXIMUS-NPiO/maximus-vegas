import { notFound } from "next/navigation";
import { connection } from "next/server";
import { dict, isLocale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { getDb } from "@/server/db.ts";
import { bracket, getTournament } from "@/server/queries.ts";
import { registrationOpen } from "@/server/tournaments.ts";
import { isRoundFormat, settingsOf } from "@/server/format-settings.ts";
import { standingsFor } from "@/server/partner-api.ts";
import { BracketView, formatLabel } from "@/components/tournament";
import { EmbedFoot, EmbedHead, EmbedStandings } from "@/components/embed";
import { Badge } from "@/components/ui";
import { LocalTime } from "@/components/time";

const WIDGETS = ["bracket", "registration", "standings"] as const;
type Widget = (typeof WIDGETS)[number];

/** Embeddable tournament widgets: bracket, registration and standings of a published tournament. */
export default async function TournamentWidget({ params }: { params: Promise<{ lang: string; slug: string; widget: string }> }) {
  await connection();
  const { lang, slug, widget } = await params;
  if (!isLocale(lang) || !(WIDGETS as readonly string[]).includes(widget)) notFound();
  const ru = lang === "ru";
  const d = dict(lang);
  const db = await getDb().catch(() => null);
  if (!db) return <p className="muted">{d.common.dbDownTitle}</p>;
  const t = await getTournament(db, slug);
  if (!t || t.status === "DRAFT") notFound();
  const href = `/${lang}/tournaments/${t.slug}`;
  const game = gameBySlug(t.game)?.name ?? t.game;
  const subtitle = (
    <>
      {game} · {formatLabel(t.format, lang)} · <Badge status={t.status}>{d.statuses.tournament[t.status] ?? t.status}</Badge>
    </>
  );
  const kind = widget as Widget;
  let body: React.ReactNode = null;
  if (kind === "bracket") {
    if (t.format === "leaderboard" || t.format === "ffa") {
      body = (
        <p className="small muted">
          {ru ? "У этого формата нет сетки — смотрите таблицу на портале." : "This format has no bracket — see the table on the portal."}
        </p>
      );
    } else {
      const matches = await bracket(db, t.id);
      const rounds = isRoundFormat(t.format);
      const playoff = rounds ? (settingsOf(t).playoff ?? null) : null;
      const main = matches.filter((m) => (m.stage ?? 1) === 1);
      const second = matches.filter((m) => m.stage === 2);
      body = matches.length ? (
        <div className="stack">
          <BracketView lang={lang} matches={rounds ? main : matches} format={t.format} linkMatches={false} />
          {playoff && second.length ? (
            <div className="bracket-group">
              <h2 className="h4">{ru ? "Плей-офф" : "Playoff"}</h2>
              <BracketView lang={lang} matches={second} format={playoff.format} linkMatches={false} scope="p" />
            </div>
          ) : null}
        </div>
      ) : (
        <p className="small muted">{ru ? "Сетка появится после старта турнира." : "The bracket appears when the tournament starts."}</p>
      );
    }
  } else if (kind === "standings") {
    body = <EmbedStandings lang={lang} standings={await standingsFor(db, t)} />;
  } else {
    const open = registrationOpen(t);
    const full = t.registered >= t.max_participants;
    body = (
      <div className="stack-sm">
        <dl className="embed-facts">
          <div>
            <dt>{ru ? "Старт" : "Start"}</dt>
            <dd>{t.starts_at ? <LocalTime iso={t.starts_at} lang={lang} /> : "—"}</dd>
          </div>
          <div>
            <dt>{ru ? "Участники" : "Participants"}</dt>
            <dd>
              {t.registered} / {t.max_participants}
            </dd>
          </div>
          {t.registration_closes_at ? (
            <div>
              <dt>{ru ? "Регистрация до" : "Registration until"}</dt>
              <dd>
                <LocalTime iso={t.registration_closes_at} lang={lang} />
              </dd>
            </div>
          ) : null}
        </dl>
        {open ? (
          <a href={href} target="_blank" rel="noopener" className="btn btn-primary btn-sm">
            {full
              ? ru
                ? "В лист ожидания на портале ↗"
                : "Join the waitlist on the portal ↗"
              : ru
                ? "Зарегистрироваться на портале ↗"
                : "Register on the portal ↗"}
          </a>
        ) : (
          <p className="small muted">
            {t.status === "PUBLISHED"
              ? ru
                ? "Регистрация ещё не открыта."
                : "Registration is not open yet."
              : ru
                ? "Регистрация закрыта."
                : "Registration is closed."}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="stack">
      <EmbedHead lang={lang} title={t.name} subtitle={subtitle} href={href} />
      {body}
      <EmbedFoot href={href} />
    </div>
  );
}
