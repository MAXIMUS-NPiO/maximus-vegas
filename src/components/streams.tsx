import { headers } from "next/headers";
import { fill, type Locale } from "@/lib/i18n.ts";
import { siteOrigin } from "@/lib/site.ts";
import { mediaText } from "@/lib/media-text.ts";
import { embedSrc, parseStreamUrl, platformName } from "@/lib/streams.ts";
import type { Database } from "@/server/db.ts";
import { STREAM_LANGUAGES, streamableMatches, tournamentStreams, type Stream } from "@/server/streams.ts";
import { ActionForm, Badge, Check, Field } from "@/components/ui";
import { LocalTime, TimeZoneField } from "@/components/time";
import { StreamPlayer } from "@/components/stream-player";

/** The portal's own host name, as the viewer reached it (Twitch requires it for its player). */
export async function portalHost(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-host") ?? h.get("host") ?? "localhost").split(",")[0].trim().split(":")[0];
}

/** The portal's address for links pasted into other tools (overlay URLs). */
async function portalOrigin(): Promise<string> {
  const h = await headers();
  return siteOrigin() ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost"}`;
}

const sides = (s: { a_name: string | null; b_name: string | null }, lang: Locale) => `${s.a_name ?? mediaText[lang].tbd} — ${s.b_name ?? mediaText[lang].tbd}`;

/** One stream or recording: platform, caption, time, a link out and, where possible, a click-to-play player. */
export function StreamCard({ s, lang, host, context }: { s: Stream; lang: Locale; host: string; context?: React.ReactNode }) {
  const x = mediaText[lang];
  const parsed = parseStreamUrl(s.url);
  const name = platformName[s.platform][lang];
  const title = s.title || (s.kind === "vod" ? x.vod : s.match_id ? x.matchStream : x.event);
  return (
    <div className="card stack-sm stream-card">
      <div className="row">
        <Badge status={s.kind === "vod" ? "muted" : "live"}>{s.kind === "vod" ? x.vod : x.kinds.live}</Badge>
        <strong className="grow msg-title">{title}</strong>
        <span className="small muted">
          {name}
          {s.language ? ` · ${x.languages[s.language] ?? s.language}` : ""}
        </span>
      </div>
      {context ? <p className="small">{context}</p> : s.match_id ? <p className="small">{sides(s, lang)}</p> : null}
      {s.kind === "live" && (s.starts_at ?? s.match_scheduled_at) ? (
        <p className="small muted">
          {x.when}: <LocalTime iso={(s.starts_at ?? s.match_scheduled_at)!} lang={lang} />
        </p>
      ) : null}
      {parsed?.embed ? <StreamPlayer src={embedSrc(parsed.embed, host)} title={title} play={x.play} note={x.playNote} /> : null}
      <a href={s.url} target="_blank" rel="noopener nofollow ugc" className="text-link small">
        {fill(x.open, { platform: name })} ↗
      </a>
    </div>
  );
}

/** Streams of a match page: its own first, then the event's; recordings after the match. */
export function StreamsBlock({ lang, host, title, streams }: { lang: Locale; host: string; title: string; streams: Stream[] }) {
  if (!streams.length) return null;
  return (
    <section className="section-tight stack-sm" id="streams">
      <h2 className="h3">{title}</h2>
      <div className="grid grid-2">
        {streams.map((s) => (
          <StreamCard key={s.id} s={s} lang={lang} host={host} />
        ))}
      </div>
    </section>
  );
}

/** Organiser section: the tournament's links, the form to assign one, and overlay addresses. */
export async function StreamsManager({ db, lang, back, tournament }: { db: Database; lang: Locale; back: string; tournament: { id: string; status: string } }) {
  const x = mediaText[lang];
  const [list, matches, origin] = await Promise.all([tournamentStreams(db, tournament.id), streamableMatches(db, tournament.id), portalOrigin()]);
  const editable = !["CANCELLED", "ARCHIVED"].includes(tournament.status);
  const label = (m: { round: number; bracket: string | null; stage: number | null; a_name: string | null; b_name: string | null }) =>
    `${(m.stage ?? 1) === 2 ? (lang === "ru" ? "Плей-офф · " : "Playoff · ") : ""}${m.bracket && !["W", "RR", "SW"].includes(m.bracket) ? `${m.bracket} · ` : ""}${lang === "ru" ? "Раунд" : "Round"} ${m.round} · ${sides(m, lang)}`;
  const streamed = [...new Set(list.map((s) => s.match_id).filter((id): id is string => Boolean(id)))];
  return (
    <section className="section-tight stack-sm" id="streams">
      <h2 className="h3">{x.manage}</h2>
      <p className="small muted">{x.manageLead}</p>
      {list.length ? (
        <ul className="list small">
          {list.map((s) => (
            <li key={s.id}>
              <span className="grow">
                <Badge status={s.kind === "vod" ? "muted" : "live"}>{x.kinds[s.kind]}</Badge> {s.title || platformName[s.platform][lang]} ·{" "}
                {s.match_id ? sides(s, lang) : x.wholeEvent}
                {s.starts_at ? (
                  <>
                    {" "}
                    · <LocalTime iso={s.starts_at} lang={lang} />
                  </>
                ) : null}
                <span className="block-line break-all muted">
                  {s.url} · {x.by} @{s.rights_by}
                </span>
              </span>
              <ActionForm action="stream.remove" lang={lang} back={`${back}#streams`} hidden={{ stream: s.id }}>
                <button className="btn btn-ghost btn-xs">{x.remove}</button>
              </ActionForm>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">{x.none}</p>
      )}
      {editable ? (
        <details className="disclosure card" open={!list.length}>
          <summary>{x.add}</summary>
          <ActionForm action="stream.add" lang={lang} back={`${back}#streams`} hidden={{ tournament: tournament.id }} className="stack-sm">
            <div className="form-grid">
              <Field label={x.url}>
                <input name="url" type="url" required maxLength={500} placeholder="https://www.twitch.tv/…" />
              </Field>
              <Field label={x.label}>
                <input name="title" maxLength={80} />
              </Field>
              <Field label={x.kind}>
                <select name="kind" defaultValue="live">
                  <option value="live">{x.kinds.live}</option>
                  <option value="vod">{x.kinds.vod}</option>
                </select>
              </Field>
              <Field label={x.scope}>
                <select name="match" defaultValue="">
                  <option value="">{x.wholeEvent}</option>
                  {matches.map((m) => (
                    <option key={m.id} value={m.id}>
                      {label(m)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={x.language}>
                <select name="language" defaultValue="">
                  <option value="">{x.anyLanguage}</option>
                  {STREAM_LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {x.languages[l]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={x.startsAt}>
                <input type="datetime-local" name="startsAt" />
              </Field>
            </div>
            <TimeZoneField />
            <Check name="rights" value="1" required label={x.rights} />
            <button className="btn btn-primary btn-sm">{x.add}</button>
          </ActionForm>
        </details>
      ) : null}
      {streamed.length ? (
        <div className="stack-sm">
          <p className="field-label">{x.overlay}</p>
          <p className="small muted">{x.overlayLead}</p>
          <ul className="list small">
            {streamed.map((id) => {
              const s = list.find((r) => r.match_id === id)!;
              return (
                <li key={id}>
                  <span className="grow">
                    {sides(s, lang)}
                    <span className="block-line break-all mono muted">
                      {origin}/embed/{lang}/matches/{id}/overlay
                    </span>
                    <span className="block-line break-all mono muted">
                      {origin}/api/overlay/matches/{id}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
