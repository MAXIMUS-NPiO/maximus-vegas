import Link from "next/link";
import type { Locale } from "@/lib/i18n.ts";
import { finderText } from "@/lib/finder-text.ts";
import { gameBySlug } from "@/lib/games.ts";
import type { ListedPost } from "@/server/finder.ts";
import { ActionForm, Badge, Field } from "@/components/ui";
import { LocalTime } from "@/components/time";

/** One team-finder post with the actions the viewer has on it. */
export function PostCard({
  lang,
  p,
  viewer,
  teams,
  memberOf = [],
  applied = false,
  moderator = false,
  back,
}: {
  lang: Locale;
  p: ListedPost;
  viewer: { username: string } | null;
  /** Teams the viewer leads: inviting from an LFT post, closing the team's vacancies. */
  teams: { id: string; name: string; game: string }[];
  /** Teams the viewer plays in: their vacancies are not offered to them. */
  memberOf?: string[];
  /** The viewer has a pending application to this post. */
  applied?: boolean;
  /** A platform administrator may remove any post. */
  moderator?: boolean;
  back: string;
}) {
  const x = finderText[lang];
  const leads = Boolean(p.team_id && teams.some((t) => t.id === p.team_id));
  const closable = Boolean(viewer && (viewer.username === p.username || (p.kind === "vacancy" && leads)));
  const moderate = Boolean(viewer && moderator && !closable);
  const ownTeam = p.kind === "vacancy" && Boolean(p.team_id && (leads || memberOf.includes(p.team_id)));
  const invitable = teams.filter((t) => t.game === p.game);
  const facts = [
    [x.region, p.region],
    [x.roles, p.roles],
    [x.languages, p.languages],
    [x.level, p.level],
    [x.schedule, p.schedule],
  ].filter(([, value]) => value);
  return (
    <article className="card finder-post">
      <div className="row-between">
        <span className="small muted">
          <Badge status={p.kind === "vacancy" ? "connect" : p.kind === "lft" ? "works" : "dev"}>{x.kindShort[p.kind]}</Badge> {gameBySlug(p.game)?.name ?? p.game}
        </span>
        <span className="small muted">
          {x.posted} <LocalTime iso={p.created_at} lang={lang} dateOnly />
        </span>
      </div>
      <h3 className="h4">
        {p.kind === "vacancy" && p.team_slug ? (
          <Link href={`/${lang}/teams/${p.team_slug}`}>{p.team_name}</Link>
        ) : (
          <Link href={`/${lang}/players/${p.username}`}>{p.display_name}</Link>
        )}{" "}
        {p.kind === "vacancy" ? (
          <span className="small muted">
            · {x.slots}: {p.slots}
          </span>
        ) : (
          <span className="small muted">@{p.username}</span>
        )}
      </h3>
      {facts.length ? (
        <dl className="finder-facts small">
          {facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {p.note ? <p className="prewrap small">{p.note}</p> : null}
      {closable ? (
        <div className="row">
          <span className="small muted">{p.kind === "vacancy" ? x.ownTeam : x.yours}</span>
          <ActionForm action="finder.close" lang={lang} back={back} hidden={{ post: p.id }}>
            <button className="btn btn-ghost btn-xs">{x.close}</button>
          </ActionForm>
        </div>
      ) : ownTeam ? (
        <p className="small muted">{x.ownTeam}</p>
      ) : applied ? (
        <p className="small muted">{x.applied}</p>
      ) : viewer && p.kind !== "lft" ? (
        <details className="disclosure">
          <summary>{x.apply}</summary>
          <ActionForm action="finder.apply" lang={lang} back={back} hidden={{ post: p.id }} className="stack-sm">
            <Field label={x.applyMessage}>
              <textarea name="message" rows={2} maxLength={500} />
            </Field>
            <button className="btn btn-primary btn-sm">{x.send}</button>
          </ActionForm>
        </details>
      ) : viewer && p.kind === "lft" && invitable.length ? (
        <ActionForm action="team.invite" lang={lang} back={back} hidden={{ username: p.username, ...(invitable.length === 1 ? { team: invitable[0].id } : {}) }} className="inline-form">
          {invitable.length > 1 ? (
            <select name="team" aria-label={x.invite}>
              {invitable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          ) : null}
          <button className="btn btn-primary btn-sm">{x.invite}</button>
        </ActionForm>
      ) : null}
      {moderate ? (
        <ActionForm action="finder.close" lang={lang} back={back} hidden={{ post: p.id }}>
          <button className="btn btn-ghost btn-xs">{x.moderateClose}</button>
        </ActionForm>
      ) : null}
    </article>
  );
}
