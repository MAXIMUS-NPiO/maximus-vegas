/**
 * Team finder (owner's specification, section 10): players looking for a team (LFT) or for a group to play with
 * (LFG), and teams' roster vacancies with applications.
 *
 * A player has at most one open LFT and one open LFG post per game; posting again replaces it. A vacancy belongs to a
 * team, is opened by its owner or captain, and holds 1–5 places; an accepted application adds the player to the team
 * and closes the vacancy once its places are filled. LFG applications connect two players without changing any team.
 * Posts expire after 30 days and are erased with the author's account.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail } from "./errors.ts";
import { gameBySlug } from "../lib/games.ts";
import * as v from "./validate.ts";

export const FINDER_KINDS = ["vacancy", "lft", "lfg"] as const;
export type FinderKind = (typeof FINDER_KINDS)[number];
export const POST_DAYS = 30;
export const MAX_OPEN_VACANCIES = 3;

export type PostInput = {
  kind?: unknown;
  game?: unknown;
  teamId?: unknown;
  region?: unknown;
  roles?: unknown;
  languages?: unknown;
  level?: unknown;
  schedule?: unknown;
  note?: unknown;
  slots?: unknown;
};

type Team = { id: string; name: string; slug: string; game: string; owner_id: string; captain_id: string | null };
const leaderOf = (team: Pick<Team, "owner_id" | "captain_id">, userId: string) => team.owner_id === userId || team.captain_id === userId;

async function lockTeam(q: Queryable, teamId: string): Promise<Team> {
  if (!/^[0-9a-f-]{36}$/i.test(teamId)) fail("not_found");
  const [team] = await q.query<Team>("select id, name, slug, game, owner_id, captain_id from teams where id = $1 for update", [teamId]);
  if (!team) fail("not_found");
  return team;
}

/** Opens a post. LFT and LFG replace the author's open post of the same kind and game. */
export async function createPost(db: Database, user: SessionUser, input: PostInput): Promise<{ id: string }> {
  const kind = typeof input.kind === "string" ? input.kind : "";
  if (!(FINDER_KINDS as readonly string[]).includes(kind)) fail("invalid_input");
  const fields = {
    region: v.oneLine(input.region, 40),
    roles: v.oneLine(input.roles, 80),
    languages: v.oneLine(input.languages, 60),
    level: v.oneLine(input.level, 60),
    schedule: v.oneLine(input.schedule, 80),
    note: v.clean(input.note, 500),
  };
  return db.tx(async (q) => {
    let game: string;
    let teamId: string | null = null;
    let slots = 1;
    if (kind === "vacancy") {
      const team = await lockTeam(q, typeof input.teamId === "string" ? input.teamId : "");
      if (!leaderOf(team, user.id)) fail("not_team_leader");
      game = team.game;
      teamId = team.id;
      slots = v.intIn(input.slots ?? 1, 1, 5);
      const [open] = await q.query<{ n: number }>(
        "select count(*)::int as n from finder_posts where team_id = $1 and status = 'open' and expires_at > now()",
        [team.id],
      );
      if ((open?.n ?? 0) >= MAX_OPEN_VACANCIES) fail("finder_limit");
    } else {
      game = typeof input.game === "string" ? input.game : "";
      if (!gameBySlug(game)) fail("invalid_game");
      await q.query("update finder_posts set status = 'closed', closed_at = now() where user_id = $1 and kind = $2 and game = $3 and status = 'open'", [
        user.id,
        kind,
        game,
      ]);
    }
    const [row] = await q.query<{ id: string }>(
      `insert into finder_posts (kind, user_id, team_id, game, region, roles, languages, level, schedule, note, slots, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(days => $12)) returning id`,
      [kind, user.id, teamId, game, fields.region, fields.roles, fields.languages, fields.level, fields.schedule, fields.note, slots, POST_DAYS],
    );
    await audit(q, { actorId: user.id, action: "finder.post_opened", entity: kind === "vacancy" ? "team" : "user", entityId: teamId ?? user.id, data: { post: row.id, kind, game } });
    return { id: row.id };
  });
}

type PostRow = { id: string; kind: FinderKind; user_id: string; team_id: string | null; game: string; status: string; slots: number; expires_at: Date };

async function lockPost(q: Queryable, postId: string): Promise<PostRow> {
  if (!/^[0-9a-f-]{36}$/i.test(postId)) fail("not_found");
  const [post] = await q.query<PostRow>("select id, kind, user_id, team_id, game, status, slots, expires_at from finder_posts where id = $1 for update", [postId]);
  if (!post) fail("not_found");
  return post;
}
const isOpen = (p: Pick<PostRow, "status" | "expires_at">) => p.status === "open" && new Date(p.expires_at).getTime() > Date.now();

/** Who decides about a post: the author, or for a vacancy the team's owner and captain. */
async function deciders(q: Queryable, post: PostRow): Promise<string[]> {
  if (post.kind !== "vacancy" || !post.team_id) return [post.user_id];
  const [team] = await q.query<{ owner_id: string; captain_id: string | null }>("select owner_id, captain_id from teams where id = $1", [post.team_id]);
  return [team?.owner_id, team?.captain_id].filter((x): x is string => Boolean(x));
}

/** The author, a team leader for a vacancy, or a platform administrator closes a post; open applications are declined. */
export async function closePost(db: Database, user: SessionUser, postId: string): Promise<{ changed: boolean }> {
  return db.tx(async (q) => {
    const post = await lockPost(q, postId);
    const allowed = post.user_id === user.id || (await deciders(q, post)).includes(user.id) || user.roles.includes("admin");
    if (!allowed) fail("forbidden");
    if (post.status !== "open") return { changed: false };
    await q.query("update finder_posts set status = 'closed', closed_at = now() where id = $1", [post.id]);
    await q.query("update finder_applications set status = 'declined', decided_by = $2, decided_at = now() where post_id = $1 and status = 'pending'", [post.id, user.id]);
    await audit(q, { actorId: user.id, action: "finder.post_closed", entity: post.kind === "vacancy" ? "team" : "user", entityId: post.team_id ?? post.user_id, data: { post: post.id } });
    return { changed: true };
  });
}

/** A player answers a vacancy or an LFG post; a pending application is not duplicated. */
export async function applyToPost(db: Database, user: SessionUser, postId: string, messageInput: unknown): Promise<{ id: string; created: boolean }> {
  const message = v.clean(messageInput, 500);
  return db.tx(async (q) => {
    const post = await lockPost(q, postId);
    if (!isOpen(post)) fail("finder_closed");
    if (post.kind === "lft") fail("invalid_input");
    if (post.user_id === user.id) fail("invalid_input");
    if (post.kind === "vacancy") {
      const [member] = await q.query("select 1 from team_members where team_id = $1 and user_id = $2", [post.team_id, user.id]);
      if (member) fail("invalid_input");
    }
    const [pending] = await q.query<{ id: string }>("select id from finder_applications where post_id = $1 and user_id = $2 and status = 'pending'", [post.id, user.id]);
    if (pending) return { id: pending.id, created: false };
    const [row] = await q.query<{ id: string }>("insert into finder_applications (post_id, user_id, message) values ($1, $2, $3) returning id", [post.id, user.id, message]);
    const [team] = post.team_id ? await q.query<{ name: string; slug: string }>("select name, slug from teams where id = $1", [post.team_id]) : [];
    await notify(q, await deciders(q, post), "finder_application", {
      user: user.username,
      game: gameBySlug(post.game)?.name ?? post.game,
      ...(team ? { team: team.name, teamSlug: team.slug } : { finder: "1" }),
    });
    await audit(q, { actorId: user.id, action: "finder.applied", entity: "user", entityId: user.id, data: { post: post.id, application: row.id } });
    return { id: row.id, created: true };
  });
}

/** The applicant withdraws a pending application. */
export async function withdrawApplication(db: Database, user: SessionUser, applicationId: string): Promise<{ changed: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(applicationId)) fail("not_found");
  return db.tx(async (q) => {
    const rows = await q.query("update finder_applications set status = 'withdrawn', decided_at = now() where id = $1 and user_id = $2 and status = 'pending' returning id", [
      applicationId,
      user.id,
    ]);
    return { changed: rows.length > 0 };
  });
}

/**
 * The author (LFG) or a team leader (vacancy) accepts or declines a pending application. An accepted vacancy
 * application adds the player to the team; the vacancy closes when its places are filled.
 */
export async function decideApplication(db: Database, user: SessionUser, applicationId: string, accept: boolean): Promise<{ changed: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(applicationId)) fail("not_found");
  return db.tx(async (q) => {
    const [ref] = await q.query<{ post_id: string }>("select post_id from finder_applications where id = $1", [applicationId]);
    if (!ref) fail("not_found");
    // Lock order: post, team (for a vacancy), then the application.
    const post = await lockPost(q, ref.post_id);
    const team = post.team_id ? await lockTeam(q, post.team_id) : null;
    if (!(await deciders(q, post)).includes(user.id)) fail("forbidden");
    const [app] = await q.query<{ id: string; user_id: string; status: string }>("select id, user_id, status from finder_applications where id = $1 for update", [applicationId]);
    if (app.status !== "pending") return { changed: false };
    if (accept && !isOpen(post)) fail("finder_closed");
    await q.query("update finder_applications set status = $2, decided_by = $3, decided_at = now() where id = $1", [app.id, accept ? "accepted" : "declined", user.id]);
    const gameName = gameBySlug(post.game)?.name ?? post.game;
    if (accept && team) {
      await q.query("insert into team_members (team_id, user_id) values ($1, $2) on conflict do nothing", [team.id, app.user_id]);
      await q.query("update team_invites set status = 'revoked' where team_id = $1 and user_id = $2 and status = 'pending'", [team.id, app.user_id]);
      const [filled] = await q.query<{ n: number }>("select count(*)::int as n from finder_applications where post_id = $1 and status = 'accepted'", [post.id]);
      if ((filled?.n ?? 0) >= post.slots) {
        await q.query("update finder_posts set status = 'closed', closed_at = now() where id = $1", [post.id]);
        await q.query("update finder_applications set status = 'declined', decided_by = $2, decided_at = now() where post_id = $1 and status = 'pending'", [post.id, user.id]);
      }
      await notify(q, [app.user_id], "finder_accepted", { team: team.name, teamSlug: team.slug, game: gameName });
    } else {
      const [author] = await q.query<{ username: string }>("select username from users where id = $1", [post.user_id]);
      await notify(q, [app.user_id], accept ? "finder_lfg_accepted" : "finder_declined", {
        user: author?.username ?? "",
        game: gameName,
        ...(accept ? { profile: author?.username ?? "" } : { finder: "1" }),
      });
    }
    await audit(q, {
      actorId: user.id,
      action: accept ? "finder.accepted" : "finder.declined",
      entity: team ? "team" : "user",
      entityId: team?.id ?? post.user_id,
      data: { post: post.id, application: app.id, player: app.user_id },
    });
    return { changed: true };
  });
}

export type ListedPost = {
  id: string;
  kind: FinderKind;
  game: string;
  region: string;
  roles: string;
  languages: string;
  level: string;
  schedule: string;
  note: string;
  slots: number;
  created_at: Date;
  expires_at: Date;
  username: string;
  display_name: string;
  team_name: string | null;
  team_slug: string | null;
  team_id: string | null;
};

const POST_COLUMNS = `p.id, p.kind, p.game, p.region, p.roles, p.languages, p.level, p.schedule, p.note, p.slots, p.created_at, p.expires_at,
       u.username, u.display_name, t.name as team_name, t.slug as team_slug, p.team_id`;

/** Open, unexpired posts, newest first, with optional game and region filters. */
export async function listPosts(q: Queryable, filter: { kind: FinderKind; game?: string; region?: string }, limit = 60): Promise<ListedPost[]> {
  return q.query<ListedPost>(
    `select ${POST_COLUMNS}
       from finder_posts p join users u on u.id = p.user_id left join teams t on t.id = p.team_id
      where p.kind = $1 and p.status = 'open' and p.expires_at > now() and u.status = 'active'
        and ($2::text = '' or p.game = $2) and ($3::text = '' or p.region ilike '%' || $3 || '%')
      order by p.created_at desc limit $4`,
    [filter.kind, filter.game ?? "", filter.region ?? "", limit],
  );
}

/** The open vacancies of one team. */
export async function teamVacancies(q: Queryable, teamId: string): Promise<ListedPost[]> {
  return q.query<ListedPost>(
    `select ${POST_COLUMNS} from finder_posts p join users u on u.id = p.user_id left join teams t on t.id = p.team_id
      where p.team_id = $1 and p.status = 'open' and p.expires_at > now() order by p.created_at desc`,
    [teamId],
  );
}

export type ApplicationRow = { id: string; post_id: string; status: string; message: string; created_at: Date; username: string; display_name: string };

/** Pending applications to posts the user decides about: their own LFG posts and their teams' vacancies. */
export async function applicationsToDecide(q: Queryable, userId: string): Promise<ApplicationRow[]> {
  return q.query<ApplicationRow>(
    `select a.id, a.post_id, a.status, a.message, a.created_at, u.username, u.display_name
       from finder_applications a join finder_posts p on p.id = a.post_id join users u on u.id = a.user_id
       left join teams t on t.id = p.team_id
      where a.status = 'pending' and p.status = 'open'
        and ((p.kind = 'lfg' and p.user_id = $1) or (p.kind = 'vacancy' and (t.owner_id = $1 or t.captain_id = $1)))
      order by a.created_at`,
    [userId],
  );
}

/** The user's own open posts and their applications with the post they went to. */
export async function myFinder(q: Queryable, userId: string) {
  const posts = await q.query<ListedPost>(
    `select ${POST_COLUMNS} from finder_posts p join users u on u.id = p.user_id left join teams t on t.id = p.team_id
      where p.user_id = $1 and p.status = 'open' and p.expires_at > now() order by p.created_at desc`,
    [userId],
  );
  const applications = await q.query<{ id: string; post_id: string; status: string; message: string; created_at: Date; kind: FinderKind; game: string; author: string; team_name: string | null; team_slug: string | null }>(
    `select a.id, a.post_id, a.status, a.message, a.created_at, p.kind, p.game, au.username as author, t.name as team_name, t.slug as team_slug
       from finder_applications a join finder_posts p on p.id = a.post_id join users au on au.id = p.user_id left join teams t on t.id = p.team_id
      where a.user_id = $1 and a.created_at > now() - interval '60 days' order by a.created_at desc limit 30`,
    [userId],
  );
  return { posts, applications };
}

/** Teams the user leads, for inviting a player from an LFT post. */
export async function ledTeams(q: Queryable, userId: string) {
  return q.query<{ id: string; name: string; game: string }>("select id, name, game from teams where owner_id = $1 or captain_id = $1 order by name", [userId]);
}

/** Open posts the user has a pending application to: the card shows "sent" instead of the form. */
export async function pendingPostIds(q: Queryable, userId: string): Promise<Set<string>> {
  const rows = await q.query<{ post_id: string }>(
    "select a.post_id from finder_applications a join finder_posts p on p.id = a.post_id where a.user_id = $1 and a.status = 'pending' and p.status = 'open'",
    [userId],
  );
  return new Set(rows.map((r) => r.post_id));
}

/** Teams the user plays in: their own vacancies are not offered to them. */
export async function memberTeamIds(q: Queryable, userId: string): Promise<string[]> {
  const rows = await q.query<{ team_id: string }>("select team_id from team_members where user_id = $1", [userId]);
  return rows.map((r) => r.team_id);
}
