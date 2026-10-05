import { createHash, randomUUID } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { notify } from "./access.ts";
import { fail } from "./errors.ts";
import { email as parseEmail, username as parseUsername } from "./validate.ts";
import { link, mailConfigured } from "./mail.ts";
import { respondToInvite, revokeInvite } from "./teams.ts";

export type InvitationStatus = "pending" | "accepted" | "declined" | "revoked" | "expired";
export type InvitationDeliveryStatus = "site_notification" | "queued" | "service_accepted" | "failed" | "cancelled";
export type SendTeamInvitationInput = { teamId: string; username?: unknown; email?: unknown; lang: "ru" | "en"; requestId: string };
export type InvitationDelivery = {
  id: string; teamId: string; teamName: string; teamSlug: string; username: string | null; email: string | null;
  reservationId: string | null; inviteId: string | null; channel: "site" | "email" | "site_and_email";
  status: InvitationStatus; deliveryStatus: InvitationDeliveryStatus; expiresAt: Date; createdAt: Date;
  reused: boolean; mailConfigured: boolean; canRetry: boolean;
};

type Team = { id: string; name: string; slug: string; owner_id: string; captain_id: string };
type DeliveryRow = {
  id: string; team_id: string; invited_by: string; recipient_user_id: string | null; recipient_email: string | null;
  requested_username: string | null; reservation_id: string | null; team_invite_id: string | null;
  requires_email_verification: boolean; status: InvitationStatus; expires_at: Date; created_at: Date;
  manual_retries: number; last_retry_at: Date | null;
};
type ViewRow = DeliveryRow & { team_name: string; team_slug: string; outbox_status: string | null; attempts: number | null; retry_ready: boolean };
const validId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const viewSelect = `select d.*,t.name as team_name,t.slug as team_slug,o.status as outbox_status,o.attempts,
  (d.last_retry_at is null or d.last_retry_at<=now()-interval '1 minute') as retry_ready
  from team_invitation_deliveries d join teams t on t.id=d.team_id
  left join email_outbox o on o.team_invitation_id=d.id`;

function present(row: ViewRow, reused = false): InvitationDelivery {
  const status = row.status === "pending" && new Date(row.expires_at).getTime() <= Date.now() ? "expired" : row.status;
  const deliveryStatus: InvitationDeliveryStatus = row.outbox_status === "sent" ? "service_accepted"
    : row.outbox_status === "cancelled" || (row.recipient_email && status !== "pending") ? "cancelled"
    : row.outbox_status === "failed" ? "failed" : row.recipient_email ? "queued" : "site_notification";
  return {
    id: row.id, teamId: row.team_id, teamName: row.team_name, teamSlug: row.team_slug,
    username: row.requested_username, email: row.recipient_email, reservationId: row.reservation_id,
    inviteId: row.team_invite_id, channel: row.recipient_email ? row.team_invite_id ? "site_and_email" : "email" : "site",
    status, deliveryStatus, expiresAt: row.expires_at, createdAt: row.created_at, reused,
    mailConfigured: mailConfigured(),
    canRetry: status === "pending" && row.outbox_status === "failed" && row.manual_retries < 3 && row.retry_ready,
  };
}
async function view(q: Queryable, id: string, reused = false) {
  const [row] = await q.query<ViewRow>(`${viewSelect} where d.id=$1`, [id]);
  if (!row) fail("invite_not_found");
  return present(row, reused);
}
async function activeActor(q: Queryable, user: SessionUser) {
  if (!user?.id) fail("unauthorized");
  const [actor] = await q.query<{ status: string }>("select status from users where id=$1 for key share", [user.id]);
  if (!actor || actor.status !== "active") fail("unauthorized");
  if (user.restricted) fail("account_restricted");
}
async function leader(q: Queryable, user: SessionUser, teamId: string) {
  await activeActor(q, user);
  const [team] = await q.query<Team>("select id,name,slug,owner_id,captain_id from teams where id=$1 for no key update", [teamId]);
  if (!team || ![team.owner_id, team.captain_id].includes(user.id)) fail("not_team_leader");
  return team;
}
async function lockInvitationNames(q: Queryable, teamId: string, extra: Array<string | null> = []) {
  const due = await q.query<{ requested_username: string | null }>("select requested_username from team_invitation_deliveries where team_id=$1 and status='pending' and expires_at<=now()", [teamId]);
  const names = [...new Set([...extra, ...due.map((row) => row.requested_username)].filter((name): name is string => Boolean(name)))].sort();
  for (const name of names) await q.query("select pg_advisory_xact_lock(hashtext($1))", [`username:${name}`]);
}
async function recordRequest(q: Queryable, actorId: string, requestId: string, fingerprint: string, deliveryId: string) {
  const [recent] = await q.query<{ n: number }>("select count(*)::int as n from team_invitation_requests where actor_id=$1 and created_at>now()-interval '1 hour'", [actorId]);
  if (recent.n >= 200) fail("too_many_attempts");
  await q.query("insert into team_invitation_requests(actor_id,request_id,fingerprint,delivery_id) values($1,$2,$3,$4)", [actorId, requestId, fingerprint, deliveryId]);
}

/** Explicit send. A missing transport still stores one queued message and never reports it as sent. */
export async function sendTeamInvitation(db: Database, user: SessionUser, input: SendTeamInvitationInput): Promise<InvitationDelivery> {
  if (!user?.id) fail("unauthorized");
  if (!validId(input.teamId) || !validId(input.requestId) || !["ru", "en"].includes(input.lang)) fail("invalid_input");
  const rawUsername = typeof input.username === "string" ? input.username.trim().replace(/^@/, "") : input.username;
  const username = rawUsername ? parseUsername(rawUsername) : null;
  const email = input.email ? parseEmail(input.email) : null;
  if (!username && !email) fail("recipient_required");
  const fingerprint = digest(JSON.stringify([input.teamId, username, email, input.lang]));
  return db.tx(async (q) => {
    // Across teams, concurrent requests from one sender share both the idempotency and rate lock.
    await q.query("select pg_advisory_xact_lock(hashtext($1))", [`team-invitation:actor:${user.id}`]);
    await activeActor(q, user);
    const [visibleTeam] = await q.query<Team>("select id,name,slug,owner_id,captain_id from teams where id=$1", [input.teamId]);
    if (!visibleTeam || ![visibleTeam.owner_id, visibleTeam.captain_id].includes(user.id)) fail("not_team_leader");
    // Acquire recipient identity locks before team/name locks: account erasure locks the user first.
    const [byName] = username ? await q.query<{ id: string; email: string; status: string }>("select id,email,status from users where username=$1 for key share", [username]) : [];
    const [byEmail] = email ? await q.query<{ id: string; username: string; status: string }>("select id,username,status from users where email=$1 for key share", [email]) : [];
    await lockInvitationNames(q, input.teamId, [username]);
    const team = await leader(q, user, input.teamId);
    // A signup may have completed between the identity lookup and this namespace lock.
    if (username) {
      const [current] = await q.query<{ id: string }>("select id from users where username=$1", [username]);
      if ((current?.id ?? null) !== (byName?.id ?? null)) fail("too_many_attempts");
    }
    const [request] = await q.query<{ fingerprint: string; delivery_id: string }>(
      "select fingerprint,delivery_id from team_invitation_requests where actor_id=$1 and request_id=$2", [user.id, input.requestId],
    );
    if (request) {
      if (request.fingerprint !== fingerprint) fail("invalid_input");
      return view(q, request.delivery_id, true);
    }
    await settleTeamInvitations(q, team.id);
    // Refuse ambiguous identity; never email another person's reserved-name token.
    if ((byName && byName.status !== "active") || (byEmail && byEmail.status !== "active") ||
      (byName && email && byName.email !== email) || (username && byEmail && byEmail.username !== username)) fail("invitation_recipient_mismatch");
    const targetId = byName?.id ?? byEmail?.id ?? null;
    if (!targetId && !email) fail("recipient_required");
    if (targetId) {
      const [member] = await q.query("select 1 from team_members where team_id=$1 and user_id=$2", [team.id, targetId]);
      if (member) fail("already_member");
    }
    const recipientKey = digest(`email:${email ?? byName!.email}`);
    await q.query("select pg_advisory_xact_lock(hashtext($1))", [`team-invitation:recipient:${recipientKey}`]);
    const [existing] = await q.query<DeliveryRow>(`select * from team_invitation_deliveries where team_id=$1 and status='pending'
      and (($2::uuid is not null and recipient_user_id=$2) or ($3::text is not null and recipient_email=$3) or recipient_key=$4) for update`, [team.id, targetId, email, recipientKey]);
    if (existing) {
      if ((username && existing.requested_username !== username) ||
        (existing.recipient_email && email && existing.recipient_email !== email)) fail("invitation_recipient_mismatch");
      // A new explicit address may add email to an existing site-only invitation; it never replaces one.
      if (email && !existing.recipient_email) {
        await checkLimits(q, user.id, team.id, recipientKey);
        await q.query("update team_invitation_deliveries set recipient_email=$2,recipient_key=$3 where id=$1", [existing.id, email, recipientKey]);
        await queueInvitationMail(q, { ...existing, recipient_email: email }, team, user.username, input.lang);
      }
      await recordRequest(q, user.id, input.requestId, fingerprint, existing.id);
      return view(q, existing.id, true);
    }
    await checkLimits(q, user.id, team.id, recipientKey);
    let reservationId: string | null = null;
    let expiresAt: Date | null = null;
    if (username && !targetId) {
      await q.query("update username_reservations set status='expired' where username=$1 and status='pending' and expires_at<=now()", [username]);
      const [reservation] = await q.query<{ id: string; team_id: string; expires_at: Date }>("select id,team_id,expires_at from username_reservations where username=$1 and status='pending' for update", [username]);
      if (reservation) {
        if (reservation.team_id !== team.id) fail("username_taken");
        reservationId = reservation.id;
        expiresAt = reservation.expires_at;
      } else {
        const [count] = await q.query<{ n: number }>("select count(*)::int as n from username_reservations where invited_by=$1 and status='pending' and expires_at>now()", [user.id]);
        if (count.n >= 20) fail("too_many_attempts");
        const [created] = await q.query<{ id: string; expires_at: Date }>("insert into username_reservations(id,username,team_id,invited_by) values($1,$2,$3,$4) returning id,expires_at", [randomUUID(), username, team.id, user.id]);
        reservationId = created.id;
        expiresAt = created.expires_at;
      }
      const [bound] = await q.query<{ recipient_email: string }>("select recipient_email from team_invitation_deliveries where reservation_id=$1", [reservationId]);
      if (bound) fail("invitation_recipient_mismatch");
    }
    let inviteId: string | null = null;
    if (targetId) inviteId = await ensureSiteInvite(q, team, targetId, user.id, user.username);
    const [created] = await q.query<DeliveryRow>(`insert into team_invitation_deliveries(team_id,invited_by,recipient_user_id,recipient_email,requested_username,
      recipient_key,reservation_id,team_invite_id,requires_email_verification,lang,expires_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11::timestamptz,now()+interval '7 days')) returning *`,
      [team.id, user.id, targetId, email, username, recipientKey, reservationId, inviteId, !byName, input.lang, expiresAt]);
    if (email) await queueInvitationMail(q, created, team, user.username, input.lang);
    await recordRequest(q, user.id, input.requestId, fingerprint, created.id);
    await audit(q, { actorId: user.id, action: "team.invitation_requested", entity: "team", entityId: team.id,
      data: { invitationId: created.id, channel: email ? targetId ? "site_and_email" : "email" : "site", reserved: Boolean(reservationId) } });
    return view(q, created.id);
  });
}

async function checkLimits(q: Queryable, actorId: string, teamId: string, recipientKey: string) {
  const [counts] = await q.query<{ hour: number; day: number; team: number; recipient: number }>(`select
    count(*) filter(where invited_by=$1 and created_at>now()-interval '1 hour')::int as hour,
    count(*) filter(where invited_by=$1)::int as day,
    count(*) filter(where team_id=$2)::int as team,
    count(*) filter(where recipient_key=$3)::int as recipient
    from team_invitation_deliveries where created_at>now()-interval '1 day' and (invited_by=$1 or team_id=$2 or recipient_key=$3)`, [actorId, teamId, recipientKey]);
  if (counts.hour >= 20 || counts.day >= 50 || counts.team >= 100 || counts.recipient >= 5) fail("too_many_attempts");
}
async function ensureSiteInvite(q: Queryable, team: Team, targetId: string, actorId: string, actorName: string) {
  const [existing] = await q.query<{ id: string }>("select id from team_invites where team_id=$1 and user_id=$2 and status='pending'", [team.id, targetId]);
  if (existing) return existing.id;
  const [invite] = await q.query<{ id: string }>("insert into team_invites(team_id,user_id,invited_by) values($1,$2,$3) returning id", [team.id, targetId, actorId]);
  await notify(q, [targetId], "team_invite", { team: team.name, teamSlug: team.slug, inviteId: invite.id, by: actorName });
  return invite.id;
}
async function queueInvitationMail(q: Queryable, delivery: DeliveryRow, team: Team, actorName: string, lang: "ru" | "en") {
  await q.query(`insert into email_outbox(to_email,template,lang,data,user_id,dedupe_key,team_invitation_id)
    values($1,'team_invitation',$2,$3,$4,$5,$6) on conflict(dedupe_key) do nothing`,
    [delivery.recipient_email, lang, JSON.stringify({ team: team.name, by: actorName, username: delivery.requested_username,
      expiresAt: new Date(delivery.expires_at).toISOString(), path: `/${lang}/team-invitations/${delivery.id}`, url: link(`/${lang}/team-invitations/${delivery.id}`) }),
    delivery.recipient_user_id, `team-invitation:${delivery.id}`, delivery.id]);
}

/** Leadership-only operational view. No account email is selected or revealed. */
export async function invitationDeliveryOverview(q: Queryable, user: SessionUser, search = ""): Promise<InvitationDelivery[]> {
  if (!user?.id) fail("unauthorized");
  const query = search.trim().replace(/^@/, "").toLowerCase().slice(0, 254);
  const rows = await q.query<ViewRow>(`${viewSelect} where (t.owner_id=$1 or t.captain_id=$1)
    and (strpos(coalesce(d.requested_username,''),$2)>0 or strpos(coalesce(d.recipient_email,''),$2)>0)
    order by (d.status='pending' and d.expires_at>now()) desc,d.created_at desc limit 100`, [user.id, query]);
  return rows.map((row) => present(row));
}

/** Expiry is shared by cron, send, claims and retry. Safe to call with a transaction queryable. */
export async function settleTeamInvitations(q: Queryable, teamId?: string) {
  const due = await q.query<{ id: string; team_id: string; requested_username: string | null }>(`select id,team_id,requested_username
    from team_invitation_deliveries where status='pending' and expires_at<=now() and ($1::uuid is null or team_id=$1)
    order by team_id,id`, [teamId ?? null]);
  const names = [...new Set(due.map((row) => row.requested_username).filter((name): name is string => Boolean(name)))].sort();
  for (const name of names) await q.query("select pg_advisory_xact_lock(hashtext($1))", [`username:${name}`]);
  let count = 0;
  for (const dueRow of due) {
    await q.query("select id from teams where id=$1 for no key update", [dueRow.team_id]);
    const [row] = await q.query<{ id: string; reservation_id: string | null; team_invite_id: string | null }>(`update team_invitation_deliveries
      set status='expired',responded_at=now() where id=$1 and status='pending' and expires_at<=now() returning id,reservation_id,team_invite_id`, [dueRow.id]);
    if (!row) continue;
    if (row.reservation_id) await q.query("update username_reservations set status='expired' where id=$1 and status='pending'", [row.reservation_id]);
    if (row.team_invite_id) await q.query("update team_invites set status='revoked',responded_at=now() where id=$1 and status='pending'", [row.team_invite_id]);
    await q.query("update email_outbox set status='cancelled',locked_until=null,last_error='' where team_invitation_id=$1 and status in('pending','failed','sending')", [row.id]);
    count++;
  }
  return count;
}

export async function retryTeamInvitation(db: Database, user: SessionUser, id: string) {
  if (!validId(id)) fail("invite_not_found");
  return db.tx(async (q) => {
    const [found] = await q.query<{ team_id: string; requested_username: string | null }>("select team_id,requested_username from team_invitation_deliveries where id=$1", [id]);
    if (!found) fail("invite_not_found");
    await activeActor(q, user);
    await lockInvitationNames(q, found.team_id, [found.requested_username]);
    await leader(q, user, found.team_id);
    await settleTeamInvitations(q, found.team_id);
    const [row] = await q.query<DeliveryRow>("select * from team_invitation_deliveries where id=$1 for update", [id]);
    if (row.status !== "pending") fail("invite_not_found");
    const [outbox] = await q.query<{ status: string; retry_ready: boolean }>(`select o.status,(last_retry_at is null or last_retry_at<=now()-interval '1 minute') as retry_ready
      from email_outbox o join team_invitation_deliveries d on d.id=o.team_invitation_id where d.id=$1 for update of o`, [id]);
    if (!outbox || outbox.status !== "failed") return view(q, id, true);
    if (!outbox.retry_ready || row.manual_retries >= 3) fail("too_many_attempts");
    await q.query("update team_invitation_deliveries set manual_retries=manual_retries+1,last_retry_at=now() where id=$1", [id]);
    await q.query("update email_outbox set status='pending',attempts=0,next_attempt_at=now(),locked_until=null,last_error='' where team_invitation_id=$1", [id]);
    await audit(q, { actorId: user.id, action: "team.invitation_retry", entity: "team", entityId: found.team_id, data: { invitationId: id } });
    return view(q, id, true);
  });
}

export async function revokeTeamInvitation(db: Database, user: SessionUser, id: string) {
  if (!validId(id)) fail("invite_not_found");
  await db.tx(async (q) => {
    const [found] = await q.query<{ team_id: string; requested_username: string | null }>("select team_id,requested_username from team_invitation_deliveries where id=$1", [id]);
    if (!found) fail("invite_not_found");
    await activeActor(q, user);
    await lockInvitationNames(q, found.team_id, [found.requested_username]);
    await leader(q, user, found.team_id);
    const [row] = await q.query<DeliveryRow>("select * from team_invitation_deliveries where id=$1 for update", [id]);
    if (row.status !== "pending") return;
    await q.query("update team_invitation_deliveries set status='revoked',responded_at=now() where id=$1", [id]);
    if (row.reservation_id) await q.query("update username_reservations set status='revoked' where id=$1 and status='pending'", [row.reservation_id]);
    if (row.team_invite_id) await q.query("update team_invites set status='revoked',responded_at=now() where id=$1 and status='pending'", [row.team_invite_id]);
    await q.query("update email_outbox set status='cancelled',locked_until=null,last_error='' where team_invitation_id=$1 and status in('pending','failed','sending')", [id]);
    await audit(q, { actorId: user.id, action: "team.invitation_revoked", entity: "team", entityId: row.team_id, data: { invitationId: id } });
  });
}

/** The bearer token reveals invitation context only, never a recipient's private address. */
export async function teamInvitationByToken(q: Queryable, token: unknown, viewerId?: string) {
  if (!validId(token)) return null;
  const [row] = await q.query<DeliveryRow & { name: string; slug: string; inviter: string; recipient_matches: boolean | null }>(`select d.*,t.name,t.slug,u.username as inviter,
    case when $2::uuid is null then null else exists(select 1 from users recipient where recipient.id=$2 and recipient.status='active'
      and ((d.recipient_user_id is not null and recipient.id=d.recipient_user_id) or (d.recipient_user_id is null and recipient.email=d.recipient_email))
      and (d.requested_username is null or recipient.username=d.requested_username)) end as recipient_matches
    from team_invitation_deliveries d join teams t on t.id=d.team_id join users u on u.id=d.invited_by where d.id=$1`, [token, viewerId ?? null]);
  if (!row) return null;
  return { id: row.id, teamId: row.team_id, teamName: row.name, teamSlug: row.slug, invitedBy: row.inviter,
    username: row.requested_username, reservationId: row.reservation_id, expiresAt: row.expires_at,
    status: row.status === "pending" && new Date(row.expires_at).getTime() <= Date.now() ? "expired" as const : row.status,
    recipientMatches: row.recipient_matches, requiresEmailVerification: row.requires_email_verification };
}

async function claimInside(q: Queryable, user: SessionUser, token: string) {
  await activeActor(q, user);
  const [found] = await q.query<{ team_id: string; requested_username: string | null }>("select team_id,requested_username from team_invitation_deliveries where id=$1", [token]);
  if (!found) fail("invite_not_found");
  if (found.requested_username) await q.query("select pg_advisory_xact_lock(hashtext($1))", [`username:${found.requested_username}`]);
  const [team] = await q.query<Team>("select id,name,slug,owner_id,captain_id from teams where id=$1 for no key update", [found.team_id]);
  const [row] = await q.query<DeliveryRow>("select * from team_invitation_deliveries where id=$1 for update", [token]);
  if (row.status !== "pending" || new Date(row.expires_at).getTime() <= Date.now()) fail("invite_not_found");
  const [recipient] = await q.query<{ id: string; username: string; email: string; email_verified_at: Date | null }>("select id,username,email,email_verified_at from users where id=$1 and status='active'", [user.id]);
  if (!recipient || (row.recipient_user_id && row.recipient_user_id !== recipient.id) ||
    (!row.recipient_user_id && row.recipient_email !== recipient.email) ||
    (row.requested_username && row.requested_username !== recipient.username) ||
    (row.requires_email_verification && row.recipient_email !== recipient.email)) fail("invitation_recipient_mismatch");
  if (row.requires_email_verification && !recipient.email_verified_at) fail("email_not_verified");
  if (row.reservation_id) {
    const [reservation] = await q.query<{ status: string; claimed_by: string | null }>("select status,claimed_by from username_reservations where id=$1 for update", [row.reservation_id]);
    if (!reservation || (reservation.status !== "pending" && (reservation.status !== "claimed" || reservation.claimed_by !== user.id))) fail("token_invalid");
    if (reservation.status === "pending") await q.query("update username_reservations set status='claimed',claimed_by=$2 where id=$1", [row.reservation_id, user.id]);
  }
  const [inviter] = await q.query<{ username: string }>("select username from users where id=$1", [row.invited_by]);
  const inviteId = row.team_invite_id ?? await ensureSiteInvite(q, team, user.id, row.invited_by, inviter.username);
  await q.query("update team_invitation_deliveries set recipient_user_id=$2,team_invite_id=$3 where id=$1", [row.id, user.id, inviteId]);
  await q.query("update email_outbox set user_id=$2 where team_invitation_id=$1", [row.id, user.id]);
  return { inviteId, team, row };
}
export async function claimTeamInvitation(db: Database, user: SessionUser, token: string) {
  if (!validId(token)) fail("invite_not_found");
  return db.tx(async (q) => { const claimed = await claimInside(q, user, token); return { inviteId: claimed.inviteId, teamSlug: claimed.team.slug }; });
}
export async function respondToTeamInvitation(db: Database, user: SessionUser, token: string, accept: boolean) {
  if (!validId(token)) fail("invite_not_found");
  return db.tx(async (q) => {
    const { inviteId, team } = await claimInside(q, user, token);
    let changed;
    try {
      changed = await q.query("update team_invites set status=$2,responded_at=now() where id=$1 and user_id=$3 and status='pending' returning id", [inviteId, accept ? "accepted" : "declined", user.id]);
    } catch (error) {
      const databaseError = error as { code?: string; message?: string };
      if (databaseError.code === "P0001" && databaseError.message === "invite_not_found") fail("invite_not_found");
      if (databaseError.code === "P0001" && databaseError.message === "email_not_verified") fail("email_not_verified");
      throw error;
    }
    if (!changed.length) fail("invite_not_found");
    if (accept) {
      await q.query("insert into team_members(team_id,user_id) values($1,$2) on conflict do nothing", [team.id, user.id]);
      await notify(q, [team.owner_id, team.captain_id], "team_joined", { team: team.name, teamSlug: team.slug, user: user.username });
    }
    await audit(q, { actorId: user.id, action: accept ? "team.invite_accepted" : "team.invite_declined", entity: "team", entityId: team.id });
    return { teamSlug: team.slug };
  });
}
/** Use in the existing team.respond action: old invitations retain their original behavior. */
export async function respondToAnyTeamInvite(db: Database, user: SessionUser, inviteId: string, accept: boolean) {
  if (!validId(inviteId)) fail("invite_not_found");
  const [delivery] = await db.query<{ id: string }>("select id from team_invitation_deliveries where team_invite_id=$1", [inviteId]);
  if (delivery) return respondToTeamInvitation(db, user, delivery.id, accept);
  const team = await respondToInvite(db, user, inviteId, accept);
  return { teamSlug: team.slug };
}

/** Export only the account's own supplied recipient data; incoming exports contain its own address. */
export async function invitationExport(q: Queryable, userId: string) {
  return q.query(`select d.id,d.team_id,d.requested_username,d.recipient_email,d.status,d.created_at,d.expires_at,d.responded_at,
    (d.invited_by=$1) as sent_by_me,o.status as email_status,o.sent_at as service_accepted_at
    from team_invitation_deliveries d left join email_outbox o on o.team_invitation_id=d.id
    where d.invited_by=$1 or d.recipient_user_id=$1 or d.recipient_email=(select email from users where id=$1 and email_verified_at is not null) order by d.created_at`, [userId]);
}
/** Call before replacing the user's email during account deletion. */
export async function eraseInvitations(q: Queryable, userId: string) {
  const rows = await q.query<{ id: string; requested_username: string | null; reservation_id: string | null; team_invite_id: string | null }>(`select id,requested_username,reservation_id,team_invite_id from team_invitation_deliveries
    where invited_by=$1 or recipient_user_id=$1 or recipient_email=(select email from users where id=$1) order by requested_username,id`, [userId]);
  for (const row of rows) {
    if (row.requested_username) await q.query("select pg_advisory_xact_lock(hashtext($1))", [`username:${row.requested_username}`]);
    await q.query("select id from team_invitation_deliveries where id=$1 for update", [row.id]);
    if (row.reservation_id) await q.query("update username_reservations set status='revoked' where id=$1 and status='pending'", [row.reservation_id]);
    if (row.team_invite_id) await q.query("update team_invites set status='revoked',responded_at=now() where id=$1 and status='pending'", [row.team_invite_id]);
    await q.query("delete from team_invitation_deliveries where id=$1", [row.id]);
  }
}

/** Only an authenticated account with the matching verified email sees incoming token links. */
export async function incomingDeliveries(q: Queryable, user: SessionUser) {
  if (!user?.id) fail("unauthorized");
  return q.query<{ id: string; teamId: string; teamName: string; teamSlug: string; username: string | null; invitedBy: string; expiresAt: Date }>(`select d.id,d.team_id as "teamId",t.name as "teamName",t.slug as "teamSlug",
    d.requested_username as username,inviter.username as "invitedBy",d.expires_at as "expiresAt"
    from team_invitation_deliveries d join teams t on t.id=d.team_id join users inviter on inviter.id=d.invited_by
    join users recipient on recipient.id=$1 and recipient.status='active'
    where d.status='pending' and d.expires_at>now() and d.team_invite_id is null
      and recipient.email_verified_at is not null and recipient.email=d.recipient_email
      and (d.recipient_user_id is null or d.recipient_user_id=recipient.id)
      and (d.requested_username is null or d.requested_username=recipient.username)
    order by d.created_at desc limit 100`, [user.id]);
}

/** Match the response lock order for cancellation through the historical team.revoke action. */
export async function revokeAnyTeamInvite(db: Database, user: SessionUser, inviteId: string) {
  if (!validId(inviteId)) fail("invite_not_found");
  const [delivery] = await db.query<{ id: string }>("select id from team_invitation_deliveries where team_invite_id=$1", [inviteId]);
  if (delivery) return revokeTeamInvitation(db, user, delivery.id);
  return revokeInvite(db, user, inviteId);
}
