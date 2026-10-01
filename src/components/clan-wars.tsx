import Link from "next/link";
import type { Locale } from "@/lib/i18n.ts";
import { fill } from "@/lib/i18n.ts";
import { GAMES, gameBySlug } from "@/lib/games.ts";
import { clanText } from "@/lib/clan-text.ts";
import type { WarRow } from "@/server/clans.ts";
import { WAR_CONFIRM_HOURS, WAR_REPORT_HOURS } from "@/server/ladder-rules.ts";
import { ActionForm, Badge, Check, Field } from "@/components/ui";
import { LocalTime, TimeZoneField } from "@/components/time";

type Member = { id: string; username: string; display_name: string };

function LineupChecks({ lang, members, chosen }: { lang: Locale; members: Member[]; chosen?: string[] }) {
  const x = clanText[lang];
  return (
    <div className="stack-sm" role="group" aria-label={x.lineup}>
      <span className="field-label">{x.lineup}</span>
      <div className="check-grid">
        {members.map((m) => (
          <Check key={m.id} name="lineup" value={m.id} defaultChecked={chosen?.includes(m.id)} label={`${m.display_name} @${m.username}`} />
        ))}
      </div>
      <span className="field-hint">{x.lineupHint}</span>
    </div>
  );
}

/** The challenge form: from the clan's own page (opponent by tag) or from the opponent's page. */
export function WarProposeForm({
  lang,
  clanId,
  members,
  back,
  opponent,
}: {
  lang: Locale;
  clanId: string;
  members: Member[];
  back: string;
  opponent?: { id: string; name: string };
}) {
  const x = clanText[lang];
  return (
    <details className="disclosure card" id="challenge">
      <summary>{opponent ? fill(x.proposeTo, { name: opponent.name }) : x.propose}</summary>
      <ActionForm action="war.propose" lang={lang} back={back} hidden={{ clan: clanId, ...(opponent ? { opponent: opponent.id } : {}) }} className="stack-sm">
        <div className="form-grid">
          {opponent ? null : (
            <Field label={x.opponent}>
              <input name="opponent" required minLength={2} maxLength={5} pattern="[A-Za-z0-9]{2,5}" autoCapitalize="characters" />
            </Field>
          )}
          <Field label={x.game}>
            <select name="game" required defaultValue="cs2">
              {GAMES.filter((g) => g.bracket).map((g) => (
                <option key={g.slug} value={g.slug}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={x.size}>
            <select name="size" defaultValue="5">
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}v{n}
                </option>
              ))}
            </select>
          </Field>
          <Field label={x.bestOf}>
            <select name="bestOf" defaultValue="3">
              {[1, 3, 5].map((n) => (
                <option key={n} value={n}>
                  {fill(x.boShort, { n: String(n) })} — {fill(x.bo, { n: String(Math.floor(n / 2) + 1) })}
                </option>
              ))}
            </select>
          </Field>
          <Field label={x.start}>
            <input type="datetime-local" name="at" required />
          </Field>
          <Field label={x.message}>
            <input name="message" maxLength={300} />
          </Field>
        </div>
        <TimeZoneField />
        <LineupChecks lang={lang} members={members} />
        <button className="btn btn-primary btn-sm">{x.sendChallenge}</button>
      </ActionForm>
    </details>
  );
}

const addHours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

/** A clan's wars with the actions open to this clan's leaders. */
export function WarList({
  lang,
  wars,
  clanId,
  leader,
  members,
  back,
}: {
  lang: Locale;
  wars: WarRow[];
  clanId: string;
  /** The viewer is this clan's owner or an officer. */
  leader: boolean;
  members: Member[];
  back: string;
}) {
  const x = clanText[lang];
  if (!wars.length) return <p className="small muted">{x.noWars}</p>;
  const now = Date.now();
  return (
    <ul className="list war-list">
      {wars.map((w) => {
        const side = w.challenger_id === clanId ? "challenger" : "opponent";
        const mineId = clanId;
        const otherId = side === "challenger" ? w.opponent_id : w.challenger_id;
        const started = w.scheduled_at.getTime() <= now;
        const mineLineup = w.lineups.filter((l) => l.clan_id === mineId);
        const name = (id: string) => (id === w.challenger_id ? w.challenger_name : w.opponent_name);
        const delta = (id: string) => w.deltas.find((d) => d.clan_id === id)?.delta;
        const hidden = { war: w.id };
        const open = ["proposed", "accepted", "reported", "disputed"].includes(w.status);
        return (
          <li key={w.id} className="stack-sm">
            <div className="row-between">
              <span>
                <Link href={`/${lang}/clans/${w.challenger_slug}`}>
                  [{w.challenger_tag}] {w.challenger_name}
                </Link>{" "}
                <span className="muted">{x.vs}</span>{" "}
                <Link href={`/${lang}/clans/${w.opponent_slug}`}>
                  [{w.opponent_tag}] {w.opponent_name}
                </Link>
              </span>
              <Badge status={w.status}>{x.statuses[w.status] ?? w.status}</Badge>
            </div>
            <p className="small muted">
              {gameBySlug(w.game)?.name ?? w.game} · {w.side_size}v{w.side_size} · {fill(x.boShort, { n: String(w.best_of) })} · {x.startsAt} <LocalTime iso={w.scheduled_at} lang={lang} />
              {w.status === "proposed" ? (
                <>
                  {" "}
                  · {x.answerUntil} <LocalTime iso={w.answer_by} lang={lang} />
                </>
              ) : null}
              {w.status === "accepted" && started ? (
                <>
                  {" "}
                  · {x.reportUntil} <LocalTime iso={addHours(w.scheduled_at, WAR_REPORT_HOURS)} lang={lang} />
                </>
              ) : null}
              {w.status === "reported" && w.reported_at ? (
                <>
                  {" "}
                  · {x.reportedBy} «{name(w.reported_clan!)}» · {x.confirmUntil} <LocalTime iso={addHours(w.reported_at, WAR_CONFIRM_HOURS)} lang={lang} />
                </>
              ) : null}
            </p>
            {w.status === "completed" && w.winner_id ? (
              <p className="small">
                {w.score_challenger !== null && w.score_opponent !== null ? (
                  <strong>
                    {w.score_challenger}:{w.score_opponent}
                  </strong>
                ) : null}{" "}
                {x.winner} «{name(w.winner_id)}»
                {w.rated ? (
                  <span className="muted">
                    {" "}
                    · {x.rating} {fmtDelta(delta(mineId))}
                  </span>
                ) : (
                  <span className="muted"> · {x.unrated}</span>
                )}
                {w.decision ? <span className="muted"> · {x.decision}</span> : null}
              </p>
            ) : null}
            {w.status === "reported" && w.score_challenger !== null ? (
              <p className="small">
                <strong>
                  {w.score_challenger}:{w.score_opponent}
                </strong>
              </p>
            ) : null}
            {leader && w.message ? <p className="small muted prewrap">{w.message}</p> : null}
            <div className="war-lineups small">
              {[w.challenger_id, w.opponent_id].map((id) => {
                const players = w.lineups.filter((l) => l.clan_id === id);
                return (
                  <span key={id}>
                    <span className="muted">[{id === w.challenger_id ? w.challenger_tag : w.opponent_tag}]</span>{" "}
                    {players.length
                      ? players.map((p, i) => (
                          <span key={p.user_id}>
                            {i ? ", " : ""}
                            <Link href={`/${lang}/players/${p.username}`}>{p.display_name}</Link>
                          </span>
                        ))
                      : "—"}
                    {open && players.length && players.length < w.side_size ? <span className="muted"> · {x.shortLineup}</span> : null}
                  </span>
                );
              })}
            </div>
            {leader ? (
              <div className="stack-sm">
                {w.status === "proposed" && side === "opponent" ? (
                  <>
                    <ActionForm action="war.answer" lang={lang} back={back} hidden={{ ...hidden, answer: "accept" }} className="stack-sm card">
                      <LineupChecks lang={lang} members={members} />
                      <button className="btn btn-primary btn-sm">{x.acceptWith}</button>
                    </ActionForm>
                    <ActionForm action="war.answer" lang={lang} back={back} hidden={{ ...hidden, answer: "decline" }}>
                      <button className="btn btn-ghost btn-sm">{x.decline}</button>
                    </ActionForm>
                  </>
                ) : null}
                {(w.status === "proposed" && side === "challenger") || (w.status === "accepted" && !started) ? (
                  <div className="row">
                    <details className="disclosure">
                      <summary>{x.changeLineup}</summary>
                      <ActionForm action="war.lineup" lang={lang} back={back} hidden={hidden} className="stack-sm">
                        <LineupChecks lang={lang} members={members} chosen={mineLineup.map((l) => l.user_id)} />
                        <button className="btn btn-ghost btn-sm">{x.save}</button>
                      </ActionForm>
                    </details>
                    <ActionForm action="war.cancel" lang={lang} back={back} hidden={hidden}>
                      <button className="btn btn-ghost btn-xs">{w.status === "proposed" ? x.withdraw : x.cancel}</button>
                    </ActionForm>
                  </div>
                ) : null}
                {w.status === "accepted" && started ? (
                  <ActionForm action="war.report" lang={lang} back={back} hidden={hidden} className="inline-form war-score">
                    <Field label={x.ourScore}>
                      <input name="mine" type="number" min={0} max={3} required inputMode="numeric" />
                    </Field>
                    <Field label={x.theirScore}>
                      <input name="theirs" type="number" min={0} max={3} required inputMode="numeric" />
                    </Field>
                    <button className="btn btn-primary btn-sm">{x.report}</button>
                  </ActionForm>
                ) : null}
                {w.status === "reported" && w.reported_clan === otherId ? (
                  <div className="row">
                    <ActionForm action="war.confirm" lang={lang} back={back} hidden={hidden}>
                      <button className="btn btn-primary btn-sm">{x.confirm}</button>
                    </ActionForm>
                    <details className="disclosure">
                      <summary>{x.dispute}</summary>
                      <ActionForm action="war.dispute" lang={lang} back={back} hidden={hidden} className="stack-sm">
                        <Field label={x.disputeReason}>
                          <textarea name="reason" required minLength={20} maxLength={1000} rows={2} />
                        </Field>
                        <button className="btn btn-ghost btn-sm">{x.dispute}</button>
                      </ActionForm>
                    </details>
                  </div>
                ) : null}
                {w.status === "reported" && w.reported_clan === mineId ? <p className="small muted">{x.waitingOther}</p> : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const fmtDelta = (d: number | undefined) => (d === undefined ? "" : d > 0 ? `+${d}` : d < 0 ? `−${Math.abs(d)}` : "0");
