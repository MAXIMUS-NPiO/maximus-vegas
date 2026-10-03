import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import type { BroadcastMode } from "./broadcast-config.ts";
import { broadcastAvailability, broadcastConfig } from "./broadcast-config.ts";
import { liveBroadcastProvider, type BroadcastProvider } from "./broadcast-provider.ts";
import { audit } from "./audit.ts";
import { fail } from "./errors.ts";
import { isAdmin } from "./access.ts";
import { requireStepUp } from "./mfa.ts";
import { gate, recordRun } from "./system.ts";
import { activeAccount } from "./product-access.ts";

export type Broadcast = {
  id: string; owner_id: string; title: string; mode: BroadcastMode; minutes: number; max_viewers: number; retention_days: number;
  state: "unpaid" | "paid" | "starting" | "live" | "stopping" | "ended" | "deleting" | "deleted";
  room_name: string; room_sid: string | null; started_at: Date | null; expires_at: Date | null; ended_at: Date | null;
  heartbeat_at: Date | null; cleanup_until: Date | null; delete_requested_at: Date | null;
  archive_state: "none" | "pending" | "ready" | "failed" | "deleted"; archive_key: string; archive_bytes: string | null;
  retain_until: Date | null; egress_id: string | null; failure: string; created_at: Date;
};
export const broadcastId = (id: unknown) => typeof id === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id) ? id : fail("invalid_input");
const time = (date: Date | null) => date ? new Date(date).getTime() : 0;
const openStates = ["starting", "live", "stopping"];
export function broadcastPublic(b: Broadcast) {
  return { id: b.id, title: b.title, mode: b.mode, minutes: b.minutes, maxViewers: b.max_viewers, retentionDays: b.retention_days,
    state: b.state, archiveState: b.archive_state, failure: b.failure, startedAt: b.started_at, expiresAt: b.expires_at,
    retainUntil: b.retain_until, createdAt: b.created_at };
}
export type BroadcastView = ReturnType<typeof broadcastPublic>;

export async function getBroadcast(db: Queryable, id: unknown) {
  const [b] = await db.query<Broadcast>("select * from native_broadcasts where id=$1", [broadcastId(id)]);
  return b ?? fail("not_found");
}
export async function myBroadcasts(db: Queryable, userId: string) {
  const rows = await db.query<Broadcast>("select * from native_broadcasts where owner_id=$1 and state<>'deleted' order by created_at desc limit 60", [userId]);
  return rows.map(broadcastPublic);
}
export async function publicBroadcasts(db: Queryable) {
  return db.query<{ id: string; title: string; display_name: string }>(`select b.id,b.title,u.display_name from native_broadcasts b
    join users u on u.id=b.owner_id where b.mode<>'record' and b.state='live' and b.expires_at>now() and b.delete_requested_at is null
    and u.status='active' and not exists(select 1 from sanctions s where s.user_id=u.id and s.kind='suspension' and s.revoked_at is null
      and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now())) order by b.started_at desc limit 30`);
}
async function allowedOwner(db: Queryable, b: Broadcast, user: SessionUser) {
  if (b.owner_id !== user.id) fail("forbidden");
  await activeAccount(db, user);
}
async function joinToken(db: Database, user: SessionUser, id: unknown, publisher: boolean, p: BroadcastProvider) {
  return db.tx(async q => {
    const [b] = await q.query<Broadcast>("select * from native_broadcasts where id=$1 for update", [broadcastId(id)]);
    if (!b) return fail("not_found");
    if (publisher) await allowedOwner(q, b, user);
    else if (b.mode === "record") fail("forbidden");
    const [active] = await q.query(`select 1 from users u where id=$1 and status='active' and not exists(select 1 from sanctions s
      where s.user_id=u.id and s.kind='suspension' and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now()))`, [b.owner_id]);
    const left = Math.floor((time(b.expires_at) - Date.now()) / 1000);
    if (!active || b.delete_requested_at || left < 1 || !(publisher ? ["starting", "live"] : ["live"]).includes(b.state)) fail("session_state");
    let identity = "host";
    if (!publisher) {
      await activeAccount(q, user);
      const present = await p.participants(b.room_name);
      const seats = await q.query<{ slot: number; user_id: string; hold_until: Date }>("select * from broadcast_seats where broadcast_id=$1 order by slot", [b.id]);
      const existing = seats.find(s => s.user_id === user.id);
      const slot = existing?.slot ?? Array.from({ length: b.max_viewers }, (_, i) => i + 1).find(n => {
        const s = seats.find(seat => seat.slot === n);
        return !s || (time(s.hold_until) < Date.now() && !present.includes(`viewer-${n}`));
      });
      if (!slot) return fail("stream_limit");
      if (!existing && seats.some(s => s.slot === slot)) await p.revokeViewer(b.room_name, `viewer-${slot}`);
      await q.query(`insert into broadcast_seats(broadcast_id,slot,user_id,hold_until) values($1,$2,$3,now()+interval '90 seconds')
        on conflict(broadcast_id,slot) do update set user_id=excluded.user_id,hold_until=excluded.hold_until`, [b.id, slot, user.id]);
      identity = `viewer-${slot}`;
    }
    return { url: broadcastConfig().url, token: await p.token(b.room_name, identity, publisher, Math.min(60, left)), expiresAt: b.expires_at };
  });
}

export async function startBroadcast(db: Database, user: SessionUser, id: unknown, p = liveBroadcastProvider()) {
  await gate(db, "broadcast.start", user);
  if (!(await broadcastAvailability(db)).ready) fail("feature_disabled");
  const b = await db.tx(async q => {
    await q.query("select id from broadcast_worker where id=true for update");
    const [row] = await q.query<Broadcast>("select * from native_broadcasts where id=$1 for update", [broadcastId(id)]);
    if (!row) return fail("not_found");
    await allowedOwner(q, row, user);
    if (row.state !== "paid" || row.delete_requested_at) fail("session_state");
    const [paid] = await q.query("select 1 from broadcast_orders where broadcast_id=$1 and state='paid'", [row.id]);
    if (!paid) fail("invoice_not_payable");
    const [capacity] = await q.query<{ n: number }>("select count(*)::int n from native_broadcasts where state in ('starting','live','stopping')");
    if (capacity.n >= 10) fail("stream_limit");
    const [started] = await q.query<Broadcast>(`update native_broadcasts set state='starting', started_at=now(), heartbeat_at=now(),
      expires_at=now()+minutes*interval '1 minute', archive_state=case when mode='live' then 'none' else 'pending' end, updated_at=now()
      where id=$1 returning *`, [row.id]);
    await audit(q, { actorId: user.id, action: "broadcast.start", entity: "native_broadcast", entityId: row.id });
    return started;
  });
  try {
    const room = await p.create({ name: b.room_name, record: b.mode !== "live", key: b.archive_key, maxViewers: b.max_viewers });
    const changed = await db.query("update native_broadcasts set room_sid=$2 where id=$1 and state='starting' and delete_requested_at is null returning id", [b.id, room.sid]);
    if (!changed.length) { await closeRoom(db, b, p); return fail("session_state"); }
    return await joinToken(db, user, b.id, true, p);
  } catch {
    // The remote create may have succeeded despite a timeout. Never issue another create or silently retry a purchase.
    await db.query(`update native_broadcasts set state='stopping',failure='provider_error',cleanup_until=now()+interval '2 minutes'
      where id=$1 and state in ('starting','live')`, [b.id]);
    try { await reconcileBroadcast(db, b.id, p); } catch { /* durable retry by the worker */ }
    return fail("provider_error");
  }
}

export async function broadcastToken(db: Database, user: SessionUser, id: unknown, publisher = false, p = liveBroadcastProvider()) {
  if (user.restricted) fail("account_restricted");
  await gate(db, publisher ? "broadcast.start" : "broadcast.watch", user);
  return joinToken(db, user, id, publisher, p);
}

export async function broadcastHeartbeat(db: Database, user: SessionUser, id: unknown, p = liveBroadcastProvider()) {
  const b = await getBroadcast(db, id);
  await allowedOwner(db, b, user);
  if (!["starting", "live"].includes(b.state) || time(b.expires_at) <= Date.now() || b.delete_requested_at) fail("session_state");
  const live = b.state === "live" || await p.publishing(b.room_name, "host");
  await db.query(`update native_broadcasts set heartbeat_at=now(), state=case when $2 then 'live' else state end
    where id=$1 and state in ('starting','live') and delete_requested_at is null`, [b.id, live]);
  return broadcastPublic(await getBroadcast(db, b.id));
}

export async function stopBroadcast(db: Database, user: SessionUser, id: unknown, remove = false, p?: BroadcastProvider) {
  await db.tx(async q => {
    const [b] = await q.query<Broadcast>("select * from native_broadcasts where id=$1 for update", [broadcastId(id)]);
    if (!b) return fail("not_found");
    if (b.owner_id !== user.id) { if (!isAdmin(user)) fail("forbidden"); requireStepUp(user); }
    const [pending] = await q.query("select 1 from broadcast_orders where broadcast_id=$1 and state='pending'", [b.id]);
    if (pending) fail("checkout_in_progress");
    if (b.state === "deleted") return;
    await q.query(`update native_broadcasts set state=case when state in ('starting','live','stopping') then 'stopping'
      when $2 then 'deleting' else 'ended' end, delete_requested_at=case when $2 then now() else delete_requested_at end,
      cleanup_until=case when started_at is not null then now()+interval '2 minutes' else cleanup_until end,
      ended_at=coalesce(ended_at,now()), updated_at=now() where id=$1`, [b.id, remove]);
    await audit(q, { actorId: user.id, action: remove ? "broadcast.delete" : "broadcast.stop", entity: "native_broadcast", entityId: b.id });
  });
  try { await reconcileBroadcast(db, String(id), p ?? liveBroadcastProvider()); } catch { /* status remains pending until remote cleanup succeeds */ }
  return broadcastPublic(await getBroadcast(db, id));
}

export async function archiveDownload(db: Database, user: SessionUser, id: unknown, p = liveBroadcastProvider()) {
  const b = await getBroadcast(db, id);
  if (b.owner_id !== user.id) fail("forbidden");
  const seconds = Math.floor((time(b.retain_until) - Date.now()) / 1000);
  if (b.archive_state !== "ready" || b.delete_requested_at || b.state !== "ended" || seconds < 1) fail("session_state");
  return { url: await p.download(b.archive_key, Math.min(60, seconds)) };
}

async function closeRoom(db: Queryable, b: Broadcast, p: BroadcastProvider) {
  const seats = await db.query<{ slot: number }>("select slot from broadcast_seats where broadcast_id=$1", [b.id]);
  await p.close(b.room_name, ["host", ...seats.map(s => `viewer-${s.slot}`)]);
}

/** Authoritative provider polling recovers lost webhooks; conditional updates never resurrect deleted/revoked access. */
export async function reconcileBroadcast(db: Database, id: string, p = liveBroadcastProvider()) {
  let b = await getBroadcast(db, id);
  const [owner] = await db.query<{ status: string; suspended: boolean }>(`select status,exists(select 1 from sanctions s where s.user_id=u.id and s.kind='suspension'
    and s.revoked_at is null and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now())) as suspended from users u where id=$1`, [b.owner_id]);
  if (openStates.includes(b.state) && (b.state === "stopping" || b.delete_requested_at || owner?.status !== "active" || owner.suspended ||
    time(b.expires_at) <= Date.now() || Date.now() - time(b.heartbeat_at) > 90000)) {
    await db.query(`update native_broadcasts set state='stopping',ended_at=coalesce(ended_at,now()),
      cleanup_until=coalesce(cleanup_until,now()+interval '2 minutes') where id=$1 and state in ('starting','live','stopping')`, [b.id]);
    await closeRoom(db, b, p);
    await db.query(`update native_broadcasts set state=case when delete_requested_at is not null then 'deleting' else 'ended' end,
      ended_at=coalesce(ended_at,now()),updated_at=now() where id=$1 and state='stopping'`, [b.id]);
    b = await getBroadcast(db, b.id);
  } else if (["ended", "deleting", "deleted"].includes(b.state) && b.started_at && time(b.cleanup_until) > Date.now()) {
    // A recently minted join token must not keep a room recreated during its short expiry window.
    await closeRoom(db, b, p);
  }
  if (b.archive_state === "pending" && ["ended", "deleting"].includes(b.state)) {
    const recording = await p.recording(b.room_name, b.archive_key);
    if (recording.status === "ready") {
      await db.query(`update native_broadcasts set archive_state='ready',egress_id=$2,archive_bytes=$3,
        retain_until=coalesce(retain_until,now()+retention_days*interval '1 day'),updated_at=now()
        where id=$1 and archive_state='pending'`, [b.id, recording.id ?? null, recording.bytes ?? null]);
    } else if (recording.status === "failed" || (recording.status === "none" && Date.now() - time(b.ended_at) > 600000)) {
      await db.query("update native_broadcasts set archive_state='failed',failure='recording_failed' where id=$1 and archive_state='pending'", [b.id]);
    }
    b = await getBroadcast(db, b.id);
  }
  if (b.delete_requested_at || (b.retain_until && time(b.retain_until) <= Date.now()) || b.archive_state === "failed") {
    // Wait for finalization and old join tokens before erasing; otherwise a late writer could recreate the object.
    if (openStates.includes(b.state) || b.archive_state === "pending" || time(b.cleanup_until) > Date.now()) {
      await db.query("update native_broadcasts set updated_at=now() where id=$1", [b.id]);
      return;
    }
    if (b.started_at) await closeRoom(db, b, p);
    await p.remove(b.archive_key);
    await db.query(`update native_broadcasts set archive_state='deleted',state=case when delete_requested_at is not null then 'deleted' else state end,
      title=case when delete_requested_at is not null then '' else title end,updated_at=now() where id=$1`, [b.id]);
  }
  await db.query("update native_broadcasts set updated_at=now() where id=$1", [b.id]);
}

export async function sweepBroadcasts(db: Database, p?: BroadcastProvider) {
  const lock = await db.query("update broadcast_worker set lease_until=now()+interval '55 seconds' where id=true and lease_until<=now() returning id");
  if (!lock.length) return { busy: true };
  let healthy = false, processed = 0, failed = 0;
  try {
    const provider = p ?? liveBroadcastProvider();
    healthy = await provider.healthy();
    const rows = await db.query<{ id: string }>(`select b.id from native_broadcasts b join users u on u.id=b.owner_id where
      b.state in ('stopping','deleting') or (b.state in ('starting','live') and (b.expires_at<=now() or b.heartbeat_at<now()-interval '90 seconds'
        or u.status<>'active' or exists(select 1 from sanctions s where s.user_id=u.id and s.kind='suspension' and s.revoked_at is null
          and s.starts_at<=now() and (s.ends_at is null or s.ends_at>now()))))
      or (b.state='ended' and (b.archive_state in ('pending','failed') or (b.archive_state='ready' and b.retain_until<=now()) or b.cleanup_until>now()))
      order by case when b.state in ('starting','live','stopping') then 0 else 1 end,b.updated_at asc limit 10`);
    const outcomes = await Promise.allSettled(rows.map(b => reconcileBroadcast(db, b.id, provider)));
    processed = outcomes.filter(r => r.status === "fulfilled").length;
    failed = outcomes.length - processed;
    healthy = healthy && !failed;
  } catch { failed++; healthy = false; }
  finally {
    await recordRun(db, "broadcasts", { healthy, processed, failed });
    await db.query("update broadcast_worker set lease_until=now() where id=true");
  }
  return { healthy, processed, failed };
}

export async function eraseBroadcasts(q: Queryable, userId: string) {
  const [paying] = await q.query("select 1 from broadcast_orders where user_id=$1 and state='pending'", [userId]);
  if (paying) fail("checkout_in_progress");
  await q.query("delete from broadcast_api_limits where user_id=$1", [userId]);
  await q.query(`update native_broadcasts set delete_requested_at=now(),title='',
    state=case when state in ('starting','live','stopping') then 'stopping' else 'deleting' end,
    cleanup_until=case when started_at is not null then now()+interval '2 minutes' else cleanup_until end,updated_at=now()
    where owner_id=$1 and state<>'deleted'`, [userId]);
}

export async function limitBroadcastAction(db: Queryable, userId: string, action: string) {
  const [limit] = await db.query<{ hits: number }>(`insert into broadcast_api_limits(user_id,action) values($1,$2)
    on conflict(user_id,action) do update set hits=case when broadcast_api_limits.window_at<now()-interval '1 minute' then 1 else broadcast_api_limits.hits+1 end,
    window_at=case when broadcast_api_limits.window_at<now()-interval '1 minute' then now() else broadcast_api_limits.window_at end returning hits`, [userId, action]);
  if (limit.hits > (["checkout", "resume", "start"].includes(action) ? 6 : 30)) fail("too_many_attempts");
}
