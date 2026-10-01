import type { Locale } from "@/lib/i18n.ts";
import { gameBySlug } from "@/lib/games.ts";
import { ratingText } from "@/lib/quick-text.ts";
import type { RatingEvent, RatingRow } from "@/server/rating.ts";
import { LocalTime } from "@/components/time";

/** Rating line of one game: the value before the first shown change, then after each change. */
function Sparkline({ values, label }: { values: number[]; label: string }) {
  if (values.length < 2) return null;
  const w = 140;
  const h = 36;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1, max - min);
  const points = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`).join(" ");
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A player's quick-match ratings per game with the rating line and the latest changes. */
export function RatingBlock({ lang, ratings, history }: { lang: Locale; ratings: RatingRow[]; history: RatingEvent[] }) {
  const x = ratingText[lang];
  return (
    <section className="section-tight" id="rating">
      <h2 className="h3">{x.title}</h2>
      <p className="small muted">{x.note}</p>
      {ratings.length ? (
        <div className="grid grid-2">
          {ratings.map((r) => {
            const events = history.filter((e) => e.game === r.game).reverse();
            const values = events.length ? [events[0].before, ...events.map((e) => e.after)] : [];
            const name = gameBySlug(r.game)?.name ?? r.game;
            return (
              <article key={r.game} className="card stack-sm rating-card">
                <div className="row-between">
                  <strong>{name}</strong>
                  <span className="rating-value">{r.rating}</span>
                </div>
                <p className="small muted">
                  {x.matches}: {r.matches} · {x.wins}: {r.wins} · {x.peak}: {r.peak}
                </p>
                <Sparkline values={values} label={`${name}: ${values.join(" → ")}`} />
                {events.length ? (
                  <details className="disclosure">
                    <summary>{x.recent}</summary>
                    <ul className="rating-events small">
                      {[...events].reverse().slice(0, 10).map((e) => (
                        <li key={e.challenge_id}>
                          <span className="grow">
                            <LocalTime iso={e.created_at} lang={lang} dateOnly /> · {e.result === "win" ? x.win : x.loss}
                          </span>
                          <span className={e.delta >= 0 ? "delta-up" : "delta-down"}>
                            {e.delta >= 0 ? "+" : ""}
                            {e.delta}
                          </span>
                          <span className="muted">{e.after}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="small muted">{x.empty}</p>
      )}
    </section>
  );
}
