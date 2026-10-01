import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { isGame } from "../lib/games.ts";
import * as v from "./validate.ts";

type Team = { id: string; slug: string; name: string; owner_id: string; captain_id: string; game: string };

async function uniqueSlug(q: Queryable, table: "teams" | "organizations" | "tournaments" | "circuits" | "clans", name: string) {
  const base = v.slugify(name);
  for (let i = 0; i < 6; i++) {
    const slug = i === 0 ? base : `${base}-${v.shortId()}`;
    const [row] = await q.query(`select 1 from ${table} where slug = $1`, [slug]);
    if (!row) return slug;
  }
  return `${base}-${v.shortId(6)}`;
}
export { uniqueSlug };

async function lockTeam(q: Queryable, teamId: string): Promise<Team> {
  const [team] = await q.query<Team>("select * from teams where id = $1 for update", [teamId]);
  if (!team) fail("not_found");
  return team;
}

const isLeader = (team: Team, userId: string) => team.owner_id === userId || team.captain_id === userId;

export async function createTeam(
  db: Database,
  user: SessionUser,
  input: { name: unknown; tag: unknown; game: unknown },
) {
  const name = v.displayName(input.name, 48);
  const tag = v.oneLine(input.tag, 6).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!isGame(input.game)) fail("invalid_game");
  return db.tx(async (q) => {
    const slug = await uniqueSlug(q, "teams", name);
    const [team] = await q.query<{ id: string; slug: string }>(
      `insert into teams (slug, name, tag, game, owner_id, captain_id) values ($1, $2, $3, $4, $5, $5) returning id, slug`,
      [slug, name, tag, input.game, user.id],
    );
    await q.query("insert into team_members (team_id, user_id) values ($1, $2)", [team.id, user.id]);
    await audit(q, { actorId: user.id, action: "team.created", entity: "team", entityId: team.id, data: { name, game: input.game } });
    return team;
  });
}

export async function inviteToTeam(db: Database, user: SessionUser, teamId: string, usernameInput: unknown) {
  const username = v.username(usernameInput);
  return db.tx(async (q) => {
    const team = await lockTeam(q, teamId);
    if (!isLeader(team, user.id)) fail("not_team_leader");
    const [target] = await q.query<{ id: string }>(
      "select id from users where username = $1 and status = 'active'",
      [username],
    );
    if (!target) fail("not_found");
    const [member] = await q.query("select 1 from team_members where team_id = $1 and user_id = $2", [teamId, target.id]);
    if (member) fail("already_member");
    try {
      const [invite] = await q.query<{ id: string }>(
        "insert into team_invites (team_id, user_id, invited_by) values ($1, $2, $3) returning id",
        [teamId, target.id, user.id],
      );
      await notify(q, [target.id], "team_invite", { team: team.name, teamSlug: team.slug, inviteId: invite.id, by: user.username });
      await audit(q, { actorId: user.id, action: "team.invited", entity: "team", entityId: teamId, data: { userId: target.id } });
      return invite;
    } catch (error) {
      if (isUniqueViolation(error)) fail("already_invited");
      throw error;
    }
  });
}

export async function respondToInvite(db: Database, user: SessionUser, inviteId: string, accept: boolean) {
  return db.tx(async (q) => {
    const [invite] = await q.query<{ id: string; team_id: string; invited_by: string }>(
      "select * from team_invites where id = $1 and user_id = $2 and status = 'pending' for update",
      [inviteId, user.id],
    );
    if (!invite) fail("invite_not_found");
    const team = await lockTeam(q, invite.team_id);
    await q.query("update team_invites set status = $2, responded_at = now() where id = $1", [
      invite.id,
      accept ? "accepted" : "declined",
    ]);
    if (accept) {
      await q.query("insert into team_members (team_id, user_id) values ($1, $2) on conflict do nothing", [team.id, user.id]);
      await notify(q, [team.owner_id, team.captain_id], "team_joined", { team: team.name, teamSlug: team.slug, user: user.username });
    }
    await audit(q, {
      actorId: user.id,
      action: accept ? "team.invite_accepted" : "team.invite_declined",
      entity: "team",
      entityId: team.id,
    });
    return team;
  });
}

export async function revokeInvite(db: Database, user: SessionUser, inviteId: string) {
  await db.tx(async (q) => {
    const [invite] = await q.query<{ team_id: string }>(
      "select team_id from team_invites where id = $1 and status = 'pending' for update",
      [inviteId],
    );
    if (!invite) fail("invite_not_found");
    const team = await lockTeam(q, invite.team_id);
    if (!isLeader(team, user.id)) fail("not_team_leader");
    await q.query("update team_invites set status = 'revoked', responded_at = now() where id = $1", [inviteId]);
    await audit(q, { actorId: user.id, action: "team.invite_revoked", entity: "team", entityId: team.id });
  });
}

export async function leaveTeam(db: Database, user: SessionUser, teamId: string) {
  await db.tx(async (q) => {
    const team = await lockTeam(q, teamId);
    if (team.owner_id === user.id) fail("owner_cannot_leave");
    const removed = await q.query("delete from team_members where team_id = $1 and user_id = $2 returning user_id", [teamId, user.id]);
    if (!removed.length) fail("not_found");
    if (team.captain_id === user.id) await q.query("update teams set captain_id = owner_id where id = $1", [teamId]);
    await audit(q, { actorId: user.id, action: "team.left", entity: "team", entityId: teamId });
  });
}

export async function removeMember(db: Database, user: SessionUser, teamId: string, memberId: string) {
  await db.tx(async (q) => {
    const team = await lockTeam(q, teamId);
    if (!isLeader(team, user.id)) fail("not_team_leader");
    if (memberId === team.owner_id) fail("forbidden");
    if (memberId === user.id) fail("cannot_modify_self");
    if (memberId === team.captain_id && user.id !== team.owner_id) fail("forbidden");
    // Roster history records this as a removal, not as the player leaving.
    await q.query("select set_config('mv.membership', 'removed', true)");
    const removed = await q.query("delete from team_members where team_id = $1 and user_id = $2 returning user_id", [teamId, memberId]);
    if (!removed.length) fail("not_found");
    if (team.captain_id === memberId) await q.query("update teams set captain_id = owner_id where id = $1", [teamId]);
    await notify(q, [memberId], "team_removed", { team: team.name, teamSlug: team.slug });
    await audit(q, { actorId: user.id, action: "team.member_removed", entity: "team", entityId: teamId, data: { userId: memberId } });
  });
}

export async function setTeamRole(
  db: Database,
  user: SessionUser,
  teamId: string,
  memberId: string,
  role: "captain" | "owner",
) {
  await db.tx(async (q) => {
    const team = await lockTeam(q, teamId);
    if (team.owner_id !== user.id) fail("forbidden");
    const [member] = await q.query("select 1 from team_members where team_id = $1 and user_id = $2", [teamId, memberId]);
    if (!member) fail("not_found");
    if (role === "captain") await q.query("update teams set captain_id = $2 where id = $1", [teamId, memberId]);
    else await q.query("update teams set owner_id = $2 where id = $1", [teamId, memberId]);
    await notify(q, [memberId], role === "owner" ? "team_owner" : "team_captain", { team: team.name, teamSlug: team.slug });
    await audit(q, { actorId: user.id, action: `team.${role}_set`, entity: "team", entityId: teamId, data: { userId: memberId } });
  });
}

export async function createOrg(db: Database, user: SessionUser, input: { name: unknown; description: unknown }) {
  const name = v.displayName(input.name, 60);
  const description = v.clean(input.description, 600);
  return db.tx(async (q) => {
    const slug = await uniqueSlug(q, "organizations", name);
    const [org] = await q.query<{ id: string; slug: string }>(
      "insert into organizations (slug, name, description, created_by) values ($1, $2, $3, $4) returning id, slug",
      [slug, name, description, user.id],
    );
    await q.query("insert into org_members (org_id, user_id, role) values ($1, $2, 'owner')", [org.id, user.id]);
    await audit(q, { actorId: user.id, action: "org.created", entity: "organization", entityId: org.id, data: { name } });
    return org;
  });
}

export async function addOrgMember(db: Database, user: SessionUser, orgId: string, usernameInput: unknown, roleInput: unknown) {
  const username = v.username(usernameInput);
  const role = ["owner", "admin", "referee"].includes(String(roleInput)) ? String(roleInput) : fail("invalid_input");
  await db.tx(async (q) => {
    const [actor] = await q.query<{ role: string }>("select role from org_members where org_id = $1 and user_id = $2", [orgId, user.id]);
    const platformAdmin = user.roles.includes("admin");
    if (!platformAdmin && actor?.role !== "owner" && actor?.role !== "admin") fail("forbidden");
    if (role === "owner" && !platformAdmin && actor?.role !== "owner") fail("forbidden");
    const [target] = await q.query<{ id: string }>("select id from users where username = $1 and status = 'active'", [username]);
    if (!target) fail("not_found");
    await q.query(
      `insert into org_members (org_id, user_id, role) values ($1, $2, $3)
       on conflict (org_id, user_id) do update set role = excluded.role`,
      [orgId, target.id, role],
    );
    const [org] = await q.query<{ name: string; slug: string }>("select name, slug from organizations where id = $1", [orgId]);
    await notify(q, [target.id], "org_role", { org: org?.name, orgSlug: org?.slug, role });
    await audit(q, { actorId: user.id, action: "org.member_set", entity: "organization", entityId: orgId, data: { userId: target.id, role } });
  });
}

export async function removeOrgMember(db: Database, user: SessionUser, orgId: string, memberId: string) {
  await db.tx(async (q) => {
    const [actor] = await q.query<{ role: string }>("select role from org_members where org_id = $1 and user_id = $2", [orgId, user.id]);
    if (!user.roles.includes("admin") && actor?.role !== "owner") fail("forbidden");
    const [target] = await q.query<{ role: string }>("select role from org_members where org_id = $1 and user_id = $2 for update", [orgId, memberId]);
    if (!target) fail("not_found");
    if (target.role === "owner") {
      const [owners] = await q.query<{ n: number }>("select count(*)::int as n from org_members where org_id = $1 and role = 'owner'", [orgId]);
      if ((owners?.n ?? 0) <= 1) fail("last_owner");
    }
    await q.query("delete from org_members where org_id = $1 and user_id = $2", [orgId, memberId]);
    await audit(q, { actorId: user.id, action: "org.member_removed", entity: "organization", entityId: orgId, data: { userId: memberId } });
  });
}

/** Team logo and banner (owner or captain). Images only, size-limited, stored with the portal's data. */
export async function setTeamMedia(
  db: Database,
  user: SessionUser,
  teamId: string,
  input: { logo?: File | null; banner?: File | null; clear?: unknown },
) {
  const { storeUpload } = await import("./media.ts");
  await db.tx(async (q) => {
    const team = await lockTeam(q, teamId);
    if (!isLeader(team, user.id)) fail("not_team_leader");
    if (input.clear === "logo") await q.query("update teams set logo_media_id = null where id = $1", [team.id]);
    if (input.clear === "banner") await q.query("update teams set banner_media_id = null where id = $1", [team.id]);
    const logo = await storeUpload(q, user.id, "team_logo", input.logo);
    const banner = await storeUpload(q, user.id, "team_banner", input.banner);
    if (logo) await q.query("update teams set logo_media_id = $2 where id = $1", [team.id, logo]);
    if (banner) await q.query("update teams set banner_media_id = $2 where id = $1", [team.id, banner]);
    if (!logo && !banner && !input.clear) fail("invalid_file");
    await audit(q, { actorId: user.id, action: "team.media_updated", entity: "team", entityId: team.id, data: { logo: Boolean(logo), banner: Boolean(banner), clear: input.clear ?? null } });
  });
}
