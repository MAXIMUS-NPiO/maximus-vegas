import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { myTeamDesk } from "../src/server/my-teams.ts";
import { createTeam, revokeInvite, respondToInvite } from "../src/server/teams.ts";
import { reserveOrInvite, revokeReservation } from "../src/server/username-reservations.ts";
import { drainOutbox, testMailbox, compose, smtpRecipientAccepted } from "../src/server/mail.ts";
import {
  sendTeamInvitation, invitationDeliveryOverview, teamInvitationByToken, incomingDeliveries,
  claimTeamInvitation, respondToTeamInvitation, respondToAnyTeamInvite, retryTeamInvitation,
  revokeTeamInvitation, settleTeamInvitations, invitationExport, eraseInvitations,
} from "../src/server/team-invitation-delivery.ts";

let db: Database;
let serial = 0;
const savedEnv = Object.fromEntries(["MAIL_TRANSPORT", "MAIL_TEST_FAIL", "MAIL_FROM"].map((key) => [key, process.env[key]]));
const rejects = (work: Promise<unknown>, code: string) => assert.rejects(work, (e: unknown) => (e as { code?: string }).code === code);
async function player(prefix: string, verified = true): Promise<SessionUser> {
  const username = `${prefix}${++serial}`;
  const [row] = await db.query<{ id: string }>(`insert into users(email,username,display_name,password_hash,adult_confirmed_at,email_verified_at)
    values($1,$2,$2,'test',now(),case when $3 then now() else null end) returning id`, [`${username}@example.com`, username, verified]);
  return { id: row.id, username, email: `${username}@example.com`, displayName: username, roles: [], sessionId: "test", emailVerified: verified };
}
async function setup() {
  const owner = await player("captain");
  const team = await createTeam(db, owner, { name: `Invitation team ${serial}`, tag: "INV", game: "cs2" });
  return { owner, team };
}
const send = (owner: SessionUser, teamId: string, data: { username?: string; email?: string; requestId?: string } = {}) =>
  sendTeamInvitation(db, owner, { teamId, lang: "en", requestId: randomUUID(), ...data });
async function rowCount(table: string) {
  const [row] = await db.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return row.n;
}

test.before(async () => {
  process.env.MAIL_TRANSPORT = "test";
  delete process.env.MAIL_TEST_FAIL;
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
});
test.after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await db.close();
});

test("recipient is mandatory, leadership and active account are checked before any durable send", async () => {
  const { owner, team } = await setup();
  const outsider = await player("outsider");
  const before = await rowCount("team_invitation_deliveries");
  await rejects(send(null as unknown as SessionUser, team.id, { email: "private@example.com" }), "unauthorized");
  await rejects(send(owner, team.id), "recipient_required");
  await rejects(send(owner, team.id, { username: "unregistered_name" }), "recipient_required");
  await rejects(send(outsider, team.id, { email: "private@example.com" }), "not_team_leader");
  await rejects(send({ ...owner, restricted: true }, team.id, { email: "private@example.com" }), "account_restricted");
  await db.query("update users set status='suspended' where id=$1", [owner.id]);
  await rejects(send(owner, team.id, { email: "private@example.com" }), "unauthorized");
  assert.equal(await rowCount("team_invitation_deliveries"), before);
  assert.equal((await db.query("select id from username_reservations where username='unregistered_name'")).length, 0);
});

test("username send is site-only, private email stays hidden, repeated and concurrent submissions create one invite", async () => {
  const { owner, team } = await setup();
  const target = await player("player");
  const requestId = randomUUID();
  const sent = await send(owner, team.id, { username: `@${target.username.toUpperCase()}`, requestId });
  assert.equal(sent.channel, "site");
  assert.equal(sent.email, null);
  assert.equal(sent.deliveryStatus, "site_notification");
  assert.ok(sent.inviteId);
  assert.equal((await db.query("select id from email_outbox where team_invitation_id=$1", [sent.id])).length, 0);
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => send(owner, team.id, { username: target.username, requestId: i ? randomUUID() : requestId })));
  assert.ok(results.every((row) => row.id === sent.id && row.reused));
  assert.equal((await db.query("select id from notifications where user_id=$1 and kind='team_invite'", [target.id])).length, 1);
  await rejects(send(owner, team.id, { username: target.username, email: "different@example.com" }), "invitation_recipient_mismatch");
  await rejects(send(owner, team.id, { username: "fresh_name", email: target.email }), "invitation_recipient_mismatch");
  await rejects(send(owner, team.id, { email: "different@example.com", requestId }), "invalid_input");
  const overview = await invitationDeliveryOverview(db, owner);
  assert.equal(JSON.stringify(overview).includes(target.email), false);
  assert.deepEqual(await invitationDeliveryOverview(db, target), []);
  assert.equal((await teamInvitationByToken(db, sent.id, target.id))!.recipientMatches, true);
  await respondToAnyTeamInvite(db, target, sent.inviteId!, true);
  const [accepted] = await invitationDeliveryOverview(db, owner);
  assert.equal(accepted.status, "accepted");
  assert.equal((await db.query("select user_id from team_members where team_id=$1 and user_id=$2", [team.id, target.id])).length, 1);
  await rejects(respondToAnyTeamInvite(db, target, sent.inviteId!, true), "invite_not_found");
});

test("explicit email adds one durable message to an existing site invite without a second notification", async () => {
  const { owner, team } = await setup();
  const target = await player("explicit");
  const site = await send(owner, team.id, { username: target.username });
  const emailed = await send(owner, team.id, { username: target.username, email: target.email });
  assert.equal(emailed.id, site.id);
  assert.equal(emailed.channel, "site_and_email");
  assert.equal(emailed.deliveryStatus, "queued");
  assert.equal((await db.query("select id from email_outbox where team_invitation_id=$1", [site.id])).length, 1);
  assert.equal((await db.query("select id from notifications where user_id=$1 and kind='team_invite'", [target.id])).length, 1);
  await revokeTeamInvitation(db, owner, site.id);
});

test("legacy reserve is reused, wrong address signup rolls back, verified recipient must explicitly accept", async () => {
  const { owner, team } = await setup();
  const username = `reserved${++serial}`;
  await reserveOrInvite(db, owner, team.id, username);
  const [reservation] = await db.query<{ id: string }>("select id from username_reservations where username=$1", [username]);
  const sent = await send(owner, team.id, { username, email: "reserved-invite@example.com" });
  assert.equal(sent.reservationId, reservation.id);
  assert.equal(sent.channel, "email");
  assert.equal(sent.inviteId, null);
  const signup = { username, displayName: "Reserved player", adult: "on", terms: "on", password: "Test-password-12345", reservation: reservation.id };
  await rejects(signUp(db, { ...signup, email: "wrong-person@example.com" }), "invitation_recipient_mismatch");
  assert.equal((await db.query("select id from users where username=$1", [username])).length, 0);
  const signed = await signUp(db, { ...signup, email: "reserved-invite@example.com" });
  const recipient = (await sessionUser(db, signed.token))!;
  assert.equal((await db.query("select id from team_invites where user_id=$1", [recipient.id])).length, 0);
  assert.deepEqual(await incomingDeliveries(db, recipient), []);
  await rejects(claimTeamInvitation(db, recipient, sent.id), "email_not_verified");
  await rejects(claimTeamInvitation(db, owner, sent.id), "invitation_recipient_mismatch");
  await db.query("update users set email_verified_at=now() where id=$1", [recipient.id]);
  assert.equal((await incomingDeliveries(db, recipient))[0].id, sent.id);
  assert.equal((await teamInvitationByToken(db, sent.id, owner.id))!.recipientMatches, false);
  assert.equal(JSON.stringify(await teamInvitationByToken(db, sent.id)).includes("reserved-invite@example.com"), false);
  const claimed = await claimTeamInvitation(db, recipient, sent.id);
  assert.equal((await claimTeamInvitation(db, recipient, sent.id)).inviteId, claimed.inviteId);
  assert.equal((await db.query("select user_id from team_members where team_id=$1 and user_id=$2", [team.id, recipient.id])).length, 0);
  await respondToTeamInvitation(db, recipient, sent.id, true);
  assert.equal((await invitationDeliveryOverview(db, owner))[0].status, "accepted");
  const [mail] = await db.query<{ status: string }>("select status from email_outbox where team_invitation_id=$1", [sent.id]);
  assert.equal(mail.status, "cancelled", "accepted player never receives a later unsent invitation email");
});

test("email-only invite needs no reserved nickname, appears only to the verified recipient, and allows decline", async () => {
  const { owner, team } = await setup();
  const address = "email-only@example.com";
  const sent = await send(owner, team.id, { email: address });
  assert.equal(sent.username, null);
  assert.equal(sent.reservationId, null);
  const recipient = await player("emailonly", false);
  await db.query("update users set email=$2 where id=$1", [recipient.id, address]);
  const wrong = await player("wrongrecipient");
  assert.deepEqual(await incomingDeliveries(db, wrong), []);
  assert.deepEqual(await incomingDeliveries(db, recipient), []);
  await rejects(claimTeamInvitation(db, wrong, sent.id), "invitation_recipient_mismatch");
  await rejects(claimTeamInvitation(db, recipient, sent.id), "email_not_verified");
  await db.query("update users set email_verified_at=now() where id=$1", [recipient.id]);
  assert.equal((await incomingDeliveries(db, recipient))[0].id, sent.id);
  await respondToTeamInvitation(db, recipient, sent.id, false);
  assert.equal((await invitationDeliveryOverview(db, owner))[0].status, "declined");
  assert.equal((await db.query("select user_id from team_members where team_id=$1 and user_id=$2", [team.id, recipient.id])).length, 0);
});

test("transport absence stays queued, test failure is retried once per outbox identity and service acceptance is truthful", async () => {
  const { owner, team } = await setup();
  delete process.env.MAIL_TRANSPORT;
  process.env.MAIL_FROM = "";
  const sent = await send(owner, team.id, { email: "queued-invite@example.com" });
  assert.equal(sent.mailConfigured, false);
  assert.equal(sent.deliveryStatus, "queued");
  assert.deepEqual(await drainOutbox(db), { configured: false, sent: 0, failed: 0 });
  process.env.MAIL_TRANSPORT = "test";
  process.env.MAIL_TEST_FAIL = "1";
  await drainOutbox(db, 100);
  assert.equal((await invitationDeliveryOverview(db, owner))[0].deliveryStatus, "failed");
  const wrong = await player("retryoutsider");
  await rejects(retryTeamInvitation(db, wrong, sent.id), "not_team_leader");
  const retry = await retryTeamInvitation(db, owner, sent.id);
  assert.equal(retry.deliveryStatus, "queued");
  assert.equal((await retryTeamInvitation(db, owner, sent.id)).id, sent.id);
  delete process.env.MAIL_TEST_FAIL;
  const mailboxBefore = testMailbox().filter((mail) => mail.to === "queued-invite@example.com").length;
  await Promise.all([drainOutbox(db, 100), drainOutbox(db, 100)]);
  const messages = testMailbox().filter((mail) => mail.to === "queued-invite@example.com");
  assert.equal(messages.length, mailboxBefore + 1);
  assert.match(messages.at(-1)!.text, new RegExp(`/en/team-invitations/${sent.id}`));
  assert.equal((await invitationDeliveryOverview(db, owner))[0].deliveryStatus, "service_accepted");
  await retryTeamInvitation(db, owner, sent.id);
  await drainOutbox(db, 100);
  assert.equal(testMailbox().filter((mail) => mail.to === "queued-invite@example.com").length, mailboxBefore + 1);
  assert.equal((await invitationDeliveryOverview(db, owner))[0].status, "pending", "provider acceptance is not player acceptance");
});

test("all revoke paths and expiration cancel unsent mail and deny acceptance", async () => {
  const { owner, team } = await setup();
  const target = await player("cancelled");
  const site = await send(owner, team.id, { username: target.username, email: target.email });
  await revokeInvite(db, owner, site.inviteId!);
  assert.equal((await invitationDeliveryOverview(db, owner))[0].status, "revoked");
  const reserved = await send(owner, team.id, { username: `cancelreserve${++serial}`, email: "cancel-reservation@example.com" });
  await revokeReservation(db, owner, reserved.reservationId!);
  const expired = await send(owner, team.id, { email: "expire-invitation@example.com" });
  await db.query("update team_invitation_deliveries set expires_at=now()-interval '1 second' where id=$1", [expired.id]);
  assert.equal((await teamInvitationByToken(db, expired.id))!.status, "expired");
  await rejects(claimTeamInvitation(db, target, expired.id), "invite_not_found");
  await db.tx((q) => settleTeamInvitations(q));
  const before = testMailbox().length;
  await drainOutbox(db, 100);
  assert.equal(testMailbox().length, before);
  const statuses = await db.query<{ status: string }>("select status from email_outbox where team_invitation_id=any($1::uuid[])", [[site.id, reserved.id, expired.id]]);
  assert.equal(statuses.length, 3);
  assert.ok(statuses.every((row) => row.status === "cancelled"));
  await rejects(retryTeamInvitation(db, owner, expired.id), "invite_not_found");
  await rejects(respondToAnyTeamInvite(db, target, site.inviteId!, true), "invite_not_found");
});

test("hourly bound is transactional and repeated delivery does not consume another send", async () => {
  const { owner, team } = await setup();
  const first = await send(owner, team.id, { email: "limit0@example.com" });
  for (let i = 1; i < 20; i++) await send(owner, team.id, { email: `limit${i}@example.com` });
  assert.equal((await send(owner, team.id, { email: "limit0@example.com" })).id, first.id);
  await rejects(send(owner, team.id, { username: "limitblocked", email: "limit20@example.com" }), "too_many_attempts");
  assert.equal((await db.query("select id from username_reservations where username='limitblocked'")).length, 0);
  assert.equal((await db.query("select id from team_invitation_deliveries where invited_by=$1", [owner.id])).length, 20);
  await db.tx((q) => eraseInvitations(q, owner.id));
});

test("export and erase include unclaimed email-only recipients, remove queued personal data and preserve unrelated deliveries", async () => {
  const { owner, team } = await setup();
  const target = await player("eraseinvite");
  const sent = await send(owner, team.id, { email: target.email });
  const other = await send(owner, team.id, { email: "untouched-invite@example.com" });
  const stranger = await player("exportoutsider");
  assert.equal((await invitationExport(db, target.id)).length, 1);
  assert.deepEqual(await invitationExport(db, stranger.id), []);
  assert.equal((await invitationExport(db, owner.id)).length, 2);
  const auditRows = await db.query<{ data: unknown }>("select data from audit_log where entity_id=$1", [team.id]);
  assert.equal(JSON.stringify(auditRows).includes(target.email), false);
  await db.tx((q) => eraseInvitations(q, target.id));
  assert.equal(await teamInvitationByToken(db, sent.id), null);
  assert.ok(await teamInvitationByToken(db, other.id));
  assert.equal((await db.query("select id from email_outbox where team_invitation_id=$1", [sent.id])).length, 0);
  await db.tx((q) => eraseInvitations(q, owner.id));
});

test("mail template escapes team/user content and renders the recipient action in both languages", () => {
  for (const lang of ["ru", "en"] as const) {
    const mail = compose("team_invitation", lang, { team: "<script>team</script>", by: 'captain"onclick', username: "player", expiresAt: "2026-10-11T00:00:00Z", path: `/${lang}/team-invitations/${randomUUID()}` }, "target@example.com", randomUUID());
    assert.equal(mail.html.includes("<script>"), false);
    assert.ok(mail.html.includes("&lt;script&gt;"));
    assert.match(mail.text, /https:\/\/www.maximus.vegas\/(ru|en)\/team-invitations/);
  }
});


test("a failure after outbox insertion rolls back invitation, nickname reservation and mail together", async () => {
  const { owner, team } = await setup();
  const before = await Promise.all(["team_invitation_deliveries", "username_reservations", "email_outbox"].map(rowCount));
  const failed: Database = { ...db, tx: (fn) => db.tx((q) => fn({
    async query<T>(text: string, params?: unknown[]) {
      if (text.startsWith("insert into team_invitation_requests")) throw new Error("injected transaction failure");
      return q.query<T>(text, params);
    },
  })) };
  await assert.rejects(sendTeamInvitation(failed, owner, { teamId: team.id, username: "atomicreservation", email: "atomic@example.com", lang: "en", requestId: randomUUID() }), /injected transaction failure/);
  assert.deepEqual(await Promise.all(["team_invitation_deliveries", "username_reservations", "email_outbox"].map(rowCount)), before);
});

test("a final crashed claim becomes failed and can be explicitly retried without another outbox row", async () => {
  const { owner, team } = await setup();
  const sent = await send(owner, team.id, { email: "crashed-invite@example.com" });
  await db.query("update email_outbox set status='sending',attempts=7,locked_until=now()-interval '1 minute' where team_invitation_id=$1", [sent.id]);
  await drainOutbox(db, 100);
  assert.equal((await invitationDeliveryOverview(db, owner))[0].deliveryStatus, "failed");
  await retryTeamInvitation(db, owner, sent.id);
  await drainOutbox(db, 100);
  assert.equal(testMailbox().filter((mail) => mail.to === "crashed-invite@example.com").length, 1);
  assert.equal((await db.query("select id from email_outbox where team_invitation_id=$1", [sent.id])).length, 1);
});

test("real PostgreSQL: racing submissions, retries and recipient limits preserve one invitation and one email", { skip: !process.env.PG_TEST_URL }, async () => {
  const pg = await openDatabase({ url: process.env.PG_TEST_URL });
  const run = randomUUID().replace(/-/g, "").slice(0, 10);
  const make = async (index: number) => {
    const username = `invc${index}${run}`;
    const [row] = await pg.query<{ id: string }>("insert into users(email,username,display_name,password_hash,adult_confirmed_at,email_verified_at) values($1,$2,$2,'test',now(),now()) returning id", [`${username}@example.com`, username]);
    const owner: SessionUser = { id: row.id, username, email: `${username}@example.com`, displayName: username, roles: [], sessionId: "test" };
    const team = await createTeam(pg, owner, { name: `Concurrent invitation ${username}`, tag: "INV", game: "cs2" });
    return { owner, team };
  };
  const created: Array<{ owner: SessionUser; team: { id: string; slug: string } }> = [];
  try {
    const primary = await make(0); created.push(primary);
    const requestId = randomUUID(), address = `invrace${run}@example.com`;
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => sendTeamInvitation(pg, primary.owner, {
      teamId: primary.team.id, email: address, lang: "en", requestId: index % 2 ? requestId : randomUUID(),
    })));
    assert.equal(new Set(responses.map((result) => result.id)).size, 1);
    const id = responses[0].id;
    assert.equal((await pg.query("select id from email_outbox where team_invitation_id=$1", [id])).length, 1);
    await pg.query("update email_outbox set status='failed',attempts=1 where team_invitation_id=$1", [id]);
    await Promise.all(Array.from({ length: 10 }, () => retryTeamInvitation(pg, primary.owner, id)));
    const [retried] = await pg.query<{ manual_retries: number }>("select manual_retries from team_invitation_deliveries where id=$1", [id]);
    assert.equal(retried.manual_retries, 1);
    await Promise.all([drainOutbox(pg, 100), drainOutbox(pg, 100), drainOutbox(pg, 100)]);
    assert.equal(testMailbox().filter((mail) => mail.to === address).length, 1);
    const recipient = `invcap${run}@example.com`;
    for (let i = 1; i <= 6; i++) created.push(await make(i));
    const capped = await Promise.allSettled(created.slice(1).map(({ owner, team }) => sendTeamInvitation(pg, owner, { teamId: team.id, email: recipient, lang: "en", requestId: randomUUID() })));
    assert.equal(capped.filter((result) => result.status === "fulfilled").length, 5);
    const rejected = capped.filter((result) => result.status === "rejected");
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "too_many_attempts");
    assert.equal((await pg.query("select id from team_invitation_deliveries where recipient_email=$1", [recipient])).length, 5);
  } finally {
    for (const { owner } of created) await pg.tx((q) => eraseInvitations(q, owner.id));
    await pg.close();
  }
});


test("the database guard also refuses expired or unverified email invitations through the historical responder", async () => {
  const { owner, team } = await setup();
  const recipient = await player("guardrecipient", false);
  const invitation = await send(owner, team.id, { email: recipient.email });
  await rejects(respondToAnyTeamInvite(db, recipient, invitation.inviteId!, true), "email_not_verified");
  await assert.rejects(respondToInvite(db, recipient, invitation.inviteId!, true), (error: unknown) => (error as Error).message === "email_not_verified");
  await db.query("update users set email_verified_at=now() where id=$1", [recipient.id]);
  await db.query("update team_invitation_deliveries set expires_at=now()-interval '1 second' where id=$1", [invitation.id]);
  await assert.rejects(respondToInvite(db, recipient, invitation.inviteId!, true), (error: unknown) => (error as Error).message === "invite_not_found");
  assert.equal((await db.query("select user_id from team_members where team_id=$1 and user_id=$2", [team.id, recipient.id])).length, 0);
  await db.tx((q) => settleTeamInvitations(q));
});

test("one recipient cap spans username and explicitly supplied email, and manual retries stay bounded", async () => {
  const owner = await player("capowner"), recipient = await player("captarget");
  let invitationId = "";
  for (let index = 0; index < 6; index++) {
    const team = await createTeam(db, owner, { name: `Shared recipient cap ${serial} ${index}`, tag: "CAP", game: "cs2" });
    if (index === 5) await rejects(send(owner, team.id, { email: recipient.email }), "too_many_attempts");
    else {
      const invitation = await send(owner, team.id, index % 2 ? { username: recipient.username } : { email: recipient.email });
      if (index === 0) invitationId = invitation.id;
    }
  }
  for (let index = 0; index < 3; index++) {
    await db.query("update email_outbox set status='failed',attempts=1 where team_invitation_id=$1", [invitationId]);
    await db.query("update team_invitation_deliveries set last_retry_at=now()-interval '2 minutes' where id=$1", [invitationId]);
    await retryTeamInvitation(db, owner, invitationId);
  }
  await db.query("update email_outbox set status='failed',attempts=1 where team_invitation_id=$1", [invitationId]);
  await db.query("update team_invitation_deliveries set last_retry_at=now()-interval '2 minutes' where id=$1", [invitationId]);
  await rejects(retryTeamInvitation(db, owner, invitationId), "too_many_attempts");
  assert.equal((await invitationDeliveryOverview(db, owner)).find((row) => row.id === invitationId)!.canRetry, false);
  await db.tx((q) => eraseInvitations(q, owner.id));
});


test("SMTP acknowledgement requires this recipient in accepted and never in rejected", () => {
  assert.equal(smtpRecipientAccepted({ accepted: ["PLAYER@example.com"], rejected: [] }, "player@example.com"), true);
  assert.equal(smtpRecipientAccepted({ accepted: [{ address: "player@example.com" }] }, "player@example.com"), true);
  assert.equal(smtpRecipientAccepted({ accepted: ["someoneelse@example.com"] }, "player@example.com"), false);
  assert.equal(smtpRecipientAccepted({ accepted: [], rejected: ["player@example.com"] }, "player@example.com"), false);
  assert.equal(smtpRecipientAccepted({ accepted: ["player@example.com"], rejected: ["player@example.com"] }, "player@example.com"), false);
  assert.equal(smtpRecipientAccepted({}, "player@example.com"), false);
});


test("team desk hides expired tracked invitations and reports expiry before maintenance while preserving legacy invitations", async () => {
  const { owner, team } = await setup();
  const tracked = await player("desktracked"), legacy = await player("desklegacy");
  const invitation = await send(owner, team.id, { username: tracked.username });
  await reserveOrInvite(db, owner, team.id, legacy.username);
  assert.equal((await myTeamDesk(db, tracked)).incoming.length, 1, "positive control: live tracked invitation is actionable");
  await db.query("update team_invitation_deliveries set expires_at=now()-interval '1 second' where id=$1", [invitation.id]);
  const [unchanged] = await db.query<{ status: string }>("select status from team_invites where id=$1", [invitation.inviteId]);
  assert.equal(unchanged.status, "pending", "maintenance has not settled the historical invitation row");
  assert.deepEqual((await myTeamDesk(db, tracked)).incoming, []);
  const outgoing = (await myTeamDesk(db, owner)).outgoing;
  assert.equal(outgoing.find((row) => row.id === invitation.inviteId)!.status, "expired");
  assert.equal(outgoing.find((row) => row.username === legacy.username)!.status, "pending");
  assert.equal((await myTeamDesk(db, legacy)).incoming.length, 1, "legacy invitation without a delivery record stays actionable");
});
