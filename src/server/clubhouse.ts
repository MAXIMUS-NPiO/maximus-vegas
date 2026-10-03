import { createHash, randomBytes } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { activeAccount, manageVenue } from "./product-access.ts";
import { isVenueStaff, passState } from "./venues.ts";
import { fail } from "./errors.ts";
import { seal } from "./secret-box.ts";
import { audit } from "./audit.ts";
import * as v from "./validate.ts";
import { isGame } from "../lib/games.ts";

type Hours = { time_zone: string; opens: number; closes: number; weekdays: number[] };
type Event = { id: string; venue_id: string; title: string; description: string; game: string; kind: string; starts_at: Date; ends_at: Date; capacity: number; status: string };
type Station = { id: string; venue_id: string; name: string; equipment: string; active: boolean };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function timeZone(input: unknown) {
  const zone = v.oneLine(input, 64);
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); } catch { fail("invalid_date"); }
  return zone;
}
function dateRange(input: Record<string, unknown>, maxHours: number, now = Date.now()) {
  const zone = timeZone(input.timeZone);
  const start = v.zonedToUtc(input.startsAt, zone), end = v.zonedToUtc(input.endsAt, zone);
  if (start.getTime() < now || start.getTime() > now + 365 * 86400_000 || end.getTime() <= start.getTime() || end.getTime() - start.getTime() > maxHours * 3600_000) fail("session_time");
  return { start, end };
}
export async function setClubHours(db: Database, user: SessionUser, venueId: string, input: Record<string, unknown>, weekdays: string[]) {
  const zone = timeZone(input.timeZone), opens = v.intIn(input.opens, 0, 1439), closes = v.intIn(input.closes, opens + 1, 1440);
  const days = [...new Set(weekdays.map(x => v.intIn(x, 0, 6)))]; if (!days.length) fail("invalid_input");
  await db.tx(async q => {
    await activeAccount(q, user); await manageVenue(q, user, venueId, true);
    await q.query("insert into clubhouse_settings(venue_id,time_zone,opens,closes,weekdays) values($1,$2,$3,$4,$5) on conflict(venue_id) do update set time_zone=excluded.time_zone,opens=excluded.opens,closes=excluded.closes,weekdays=excluded.weekdays", [venueId, zone, opens, closes, days]);
    await audit(q, { actorId: user.id, action: "club.hours_changed", entity: "venue", entityId: venueId });
  });
}
export async function addStation(db: Database, user: SessionUser, venueId: string, input: Record<string, unknown>) {
  return db.tx(async q => {
    await activeAccount(q, user); await manageVenue(q, user, venueId, true);
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from club_stations where venue_id=$1", [venueId]);
    if (n.n >= 500) fail("venue_limit");
    const [r] = await q.query<{ id: string }>("insert into club_stations(venue_id,name,equipment) values($1,$2,$3) returning id", [venueId, v.displayName(input.name, 60), v.clean(input.equipment, 500)]);
    return r.id;
  });
}
export async function setStationActive(db: Database, user: SessionUser, stationId: string, active: boolean) {
  await db.tx(async q => {
    const [s] = await q.query<Station>("select * from club_stations where id=$1 for update", [stationId]); if (!s) fail("not_found");
    await manageVenue(q, user, s.venue_id, true);
    await q.query("update club_stations set active=$2 where id=$1", [stationId, active]);
    if (!active) {
      await q.query("update station_bookings set status='cancelled' where station_id=$1 and status='reserved' and ends_at>now()", [stationId]);
      await q.query("update venue_passes set status='revoked',revoked_at=now() where station_booking_id in(select id from station_bookings where station_id=$1 and status='cancelled') and status='active'", [stationId]);
    }
    await audit(q, { actorId: user.id, action: "club.station_changed", entity: "station", entityId: stationId, data: { active } });
  });
}
async function issueAccess(q: Queryable, venueId: string, userId: string, start: Date, end: Date, kind: "rsvp" | "booking", ref: string) {
  const token = randomBytes(24).toString("base64url"), sealed = seal("pass", token), col = kind === "rsvp" ? "club_rsvp_id" : "station_booking_id";
  await q.query(`insert into venue_passes(venue_id,user_id,kind,valid_from,valid_until,token_hash,token_sealed,scheme,${col})
    values($1,$2,'guest',$3,$4,$5,$6,$7,$8) on conflict(${col}) do update set status='active',valid_from=excluded.valid_from,valid_until=excluded.valid_until,
    token_hash=excluded.token_hash,token_sealed=excluded.token_sealed,scheme=excluded.scheme,used_at=null,used_by=null,revoked_at=null`,
    [venueId, userId, start, end, hash(token), sealed.value, sealed.scheme, ref]);
}
function insideHours(start: Date, end: Date, hours: Hours) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: hours.time_zone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const parts = (d: Date) => Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
  const a = parts(start), b = parts(new Date(end.getTime() - 1));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(a.weekday);
  return hours.weekdays.includes(day) && a.year === b.year && a.month === b.month && a.day === b.day && Number(a.hour) * 60 + Number(a.minute) >= hours.opens && Number(b.hour) * 60 + Number(b.minute) < hours.closes;
}
export async function bookStation(db: Database, user: SessionUser, stationId: string, input: Record<string, unknown>) {
  const { start, end } = dateRange(input, 8);
  if (start.getTime() > Date.now() + 30 * 86400_000 || end.getTime() - start.getTime() < 30 * 60_000) fail("session_time");
  return db.tx(async q => {
    await q.query("select id from users where id=$1 for update", [user.id]); await activeAccount(q, user);
    const [s] = await q.query<Station & { venue_status: string }>("select s.*,v.status as venue_status from club_stations s join venues v on v.id=s.venue_id where s.id=$1 for update of s", [stationId]);
    if (!s?.active || s.venue_status !== "confirmed") fail("venue_not_confirmed");
    const [hours] = await q.query<Hours>("select * from clubhouse_settings where venue_id=$1", [s.venue_id]);
    if (!hours || !insideHours(start, end, hours)) fail("session_time");
    const [overlap] = await q.query("select 1 from station_bookings where (station_id=$1 or user_id=$2) and status in('reserved','checked_in') and starts_at<$4 and ends_at>$3", [stationId, user.id, start, end]);
    if (overlap) fail("session_overlap");
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from station_bookings where user_id=$1 and status='reserved' and ends_at>now()", [user.id]);
    if (n.n >= 5) fail("request_limit");
    const [b] = await q.query<{ id: string }>("insert into station_bookings(station_id,user_id,starts_at,ends_at) values($1,$2,$3,$4) returning id", [stationId, user.id, start, end]);
    await issueAccess(q, s.venue_id, user.id, new Date(start.getTime() - 15 * 60_000), end, "booking", b.id);
    return b.id;
  });
}
export async function changeBooking(db: Database, user: SessionUser, bookingId: string, status: string) {
  if (!["cancelled", "completed", "no_show"].includes(status)) fail("invalid_input");
  await db.tx(async q => {
    const [b] = await q.query<{ user_id: string; venue_id: string; status: string; starts_at: Date; ends_at: Date }>("select b.*,s.venue_id from station_bookings b join club_stations s on s.id=b.station_id where b.id=$1 for update of b", [bookingId]);
    if (!b) fail("not_found");
    if (status !== "cancelled" || b.user_id !== user.id) await manageVenue(q, user, b.venue_id);
    if (!["reserved", "checked_in"].includes(b.status)) fail("invalid_transition");
    if (status === "no_show" && new Date(b.starts_at).getTime() + 15 * 60_000 > Date.now()) fail("no_show_too_early");
    if (status === "completed" && b.status !== "checked_in") fail("invalid_transition");
    if (b.user_id === user.id && b.status !== "reserved") fail("invalid_transition");
    await q.query("update station_bookings set status=$2 where id=$1", [bookingId, status]);
    await q.query("update venue_passes set status='revoked',revoked_at=now() where station_booking_id=$1 and status='active'", [bookingId]);
    await audit(q, { actorId: user.id, action: "club.booking_changed", entity: "station_booking", entityId: bookingId, data: { status } });
  });
}
export async function createClubEvent(db: Database, user: SessionUser, venueId: string, input: Record<string, unknown>) {
  const { start, end } = dateRange(input, 24 * 7), game = v.oneLine(input.game, 40), kind = v.oneLine(input.kind, 20);
  if (game && !isGame(game)) fail("invalid_game");
  if (!["social", "training", "talent", "competition"].includes(kind)) fail("invalid_input");
  const title = v.displayName(input.title, 100), description = v.clean(input.description, 2000), capacity = v.intIn(input.capacity, 1, 5000);
  if (description.length < 10 || !v.bool(input.freeEntry)) fail("consent_required");
  return db.tx(async q => {
    await activeAccount(q, user); await manageVenue(q, user, venueId, true);
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from club_events where venue_id=$1 and status='published' and ends_at>now()", [venueId]);
    if (n.n >= 100) fail("request_limit");
    const [e] = await q.query<{ id: string }>("insert into club_events(venue_id,title,description,game,kind,starts_at,ends_at,capacity,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id", [venueId, title, description, game, kind, start, end, capacity, user.id]);
    await audit(q, { actorId: user.id, action: "club.event_created", entity: "club_event", entityId: e.id });
    return e.id;
  });
}
export async function rsvpEvent(db: Database, user: SessionUser, eventId: string) {
  return db.tx(async q => {
    await activeAccount(q, user);
    const [e] = await q.query<Event & { venue_status: string }>("select e.*,v.status as venue_status from club_events e join venues v on v.id=e.venue_id where e.id=$1 for update of e", [eventId]);
    if (!e || e.status !== "published" || e.venue_status !== "confirmed" || new Date(e.starts_at).getTime() <= Date.now()) fail("registration_closed");
    const [old] = await q.query<{ status: string }>("select status from club_rsvps where event_id=$1 and user_id=$2", [eventId, user.id]);
    if (old && old.status !== "cancelled") return old.status;
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from club_rsvps where event_id=$1 and status in('reserved','attended')", [eventId]);
    const status = n.n < e.capacity ? "reserved" : "waitlisted";
    const [r] = await q.query<{ id: string }>("insert into club_rsvps(event_id,user_id,status) values($1,$2,$3) on conflict(event_id,user_id) do update set status=excluded.status,created_at=now() returning id", [eventId, user.id, status]);
    if (status === "reserved") await issueAccess(q, e.venue_id, user.id, new Date(new Date(e.starts_at).getTime() - 3600_000), new Date(e.ends_at), "rsvp", r.id);
    return status;
  });
}
export async function cancelRsvp(db: Database, user: SessionUser, eventId: string) {
  await db.tx(async q => {
    const [e] = await q.query<Event>("select * from club_events where id=$1 for update", [eventId]); if (!e) fail("not_found");
    const [r] = await q.query<{ id: string; status: string }>("select id,status from club_rsvps where event_id=$1 and user_id=$2", [eventId, user.id]);
    if (!r || !["reserved", "waitlisted"].includes(r.status)) fail("invalid_transition");
    await q.query("update club_rsvps set status='cancelled' where id=$1", [r.id]);
    await q.query("update venue_passes set status='revoked',revoked_at=now() where club_rsvp_id=$1 and status='active'", [r.id]);
    if (r.status === "reserved" && e.status === "published" && new Date(e.starts_at).getTime() > Date.now()) {
      const [next] = await q.query<{ id: string; user_id: string }>("select r.id,r.user_id from club_rsvps r join users u on u.id=r.user_id where r.event_id=$1 and r.status='waitlisted' and u.status='active' order by r.created_at,r.id limit 1", [eventId]);
      if (next) {
        await q.query("update club_rsvps set status='reserved' where id=$1", [next.id]);
        await issueAccess(q, e.venue_id, next.user_id, new Date(new Date(e.starts_at).getTime() - 3600_000), new Date(e.ends_at), "rsvp", next.id);
      }
    }
  });
}
export async function changeClubEvent(db: Database, user: SessionUser, eventId: string, status: string) {
  if (!["completed", "cancelled"].includes(status)) fail("invalid_input");
  await db.tx(async q => {
    const [e] = await q.query<Event>("select * from club_events where id=$1 for update", [eventId]); if (!e) fail("not_found");
    await manageVenue(q, user, e.venue_id);
    if (e.status !== "published" || (status === "completed" && new Date(e.ends_at).getTime() > Date.now())) fail("invalid_transition");
    await q.query("update club_events set status=$2 where id=$1", [eventId, status]);
    await q.query("update club_rsvps set status='cancelled' where event_id=$1 and status in('reserved','waitlisted')", [eventId]);
    await q.query("update venue_passes set status='revoked',revoked_at=now() where club_rsvp_id in(select id from club_rsvps where event_id=$1) and status='active'", [eventId]);
    await audit(q, { actorId: user.id, action: "club.event_changed", entity: "club_event", entityId: eventId, data: { status } });
  });
}
export async function clubView(q: Queryable, venueId: string, userId?: string) {
  const [hours] = await q.query<Hours>("select * from clubhouse_settings where venue_id=$1", [venueId]);
  const stations = await q.query<Station>("select * from club_stations where venue_id=$1 order by name", [venueId]);
  const events = await q.query<Event & { reserved: number; mine: string | null }>(`select e.*,
    (select count(*)::int from club_rsvps r where r.event_id=e.id and r.status in('reserved','attended')) as reserved,
    (select status from club_rsvps r where r.event_id=e.id and r.user_id=$2) as mine
    from club_events e where e.venue_id=$1 and e.ends_at>now()-interval '7 days' order by e.starts_at limit 100`, [venueId, userId ?? null]);
  const availability = await q.query<{ station_id: string; starts_at: Date; ends_at: Date }>("select b.station_id,b.starts_at,b.ends_at from station_bookings b join club_stations s on s.id=b.station_id where s.venue_id=$1 and b.status in('reserved','checked_in') and b.ends_at>now() order by b.starts_at limit 500", [venueId]);
  const bookings = userId ? await q.query<{ id: string; name: string; starts_at: Date; ends_at: Date; status: string }>("select b.id,s.name,b.starts_at,b.ends_at,b.status from station_bookings b join club_stations s on s.id=b.station_id where s.venue_id=$1 and b.user_id=$2 order by b.starts_at desc limit 50", [venueId, userId]) : [];
  return { hours, stations, events, availability, bookings };
}

/** The browser caches only token hashes and validity, never a roster of names. */
export async function offlineManifest(db: Database, user: SessionUser, venueId: string) {
  return db.tx(async q => {
    await activeAccount(q, user);
    const [venue] = await q.query<{ org_id: string; status: string }>("select org_id,status from venues where id=$1", [venueId]);
    if (!venue || venue.status !== "confirmed" || !(await isVenueStaff(q, venue.org_id, user))) fail("forbidden");
    const passes = await q.query<{ id: string; token_hash: string; valid_from: Date; valid_until: Date }>("select id,token_hash,valid_from,valid_until from venue_passes where venue_id=$1 and status='active' and valid_until>now() and valid_from<now()+interval '4 hours' order by valid_from limit 5000", [venueId]);
    const [m] = await q.query<{ id: string; created_at: Date; expires_at: Date }>("insert into offline_manifests(venue_id,staff_id,passes,expires_at) values($1,$2,$3,now()+interval '4 hours') returning id,created_at,expires_at", [venueId, user.id, JSON.stringify(passes)]);
    await q.query("delete from offline_manifests where staff_id=$1 and expires_at<now()-interval '7 days' and not exists(select 1 from offline_scans s where s.manifest_id=offline_manifests.id)", [user.id]);
    return { ...m, passes };
  });
}
export async function syncOfflineScan(db: Database, user: SessionUser, input: { id: string; manifest: string; token: string; observedAt: string }) {
  if (!/^[a-z0-9_-]{32}$/i.test(input.token) || !/^[0-9a-f-]{36}$/i.test(input.id) || !/^[0-9a-f-]{36}$/i.test(input.manifest)) fail("invalid_input");
  const observed = new Date(input.observedAt); if (!Number.isFinite(observed.getTime())) fail("invalid_date");
  return db.tx(async q => {
    await activeAccount(q, user);
    const [m] = await q.query<{ venue_id: string; staff_id: string; org_id: string; venue_status: string; created_at: Date; expires_at: Date; passes: Array<{ id: string; token_hash: string }> }>("select m.*,v.org_id,v.status as venue_status from offline_manifests m join venues v on v.id=m.venue_id where m.id=$1 for update of m", [input.manifest]);
    if (!m || m.staff_id !== user.id || !(await isVenueStaff(q, m.org_id, user))) fail("forbidden");
    const [old] = await q.query<{ result: string; manifest_id: string }>("select result,manifest_id from offline_scans where id=$1", [input.id]);
    if (old) { if (old.manifest_id !== input.manifest) fail("forbidden"); return old.result; }
    if (m.venue_status !== "confirmed" || Date.now() - new Date(m.expires_at).getTime() > 24 * 3600_000 || observed.getTime() < new Date(m.created_at).getTime() || observed.getTime() > Math.min(Date.now() + 30_000, new Date(m.expires_at).getTime())) fail("pass_expired");
    const entry = m.passes.find(p => p.token_hash === hash(input.token)); if (!entry) return fail("pass_unknown");
    const [p] = await q.query<Parameters<typeof passState>[1] & { club_rsvp_id: string | null; station_booking_id: string | null }>("select * from venue_passes where id=$1 and venue_id=$2 for update", [entry.id, m.venue_id]);
    if (!p) fail("pass_unknown");
    const result = await passState(q, p, observed.getTime());
    if (result === "admitted") {
      await q.query("update venue_passes set status='used',used_at=$2,used_by=$3 where id=$1", [p.id, observed, user.id]);
      await recordClubAdmission(q, p.id);
    }
    await q.query("insert into offline_scans(id,manifest_id,pass_id,observed_at,result) values($1,$2,$3,$4,$5)", [input.id, input.manifest, p.id, observed, result]);
    await q.query("insert into venue_checkins(venue_id,pass_id,staff_id,result) values($1,$2,$3,$4)", [m.venue_id, p.id, user.id, result]);
    await audit(q, { actorId: user.id, action: "club.offline_synced", entity: "venue", entityId: m.venue_id, data: { pass: p.id, result, observedAt: observed.toISOString() } });
    return result;
  });
}
export async function recordClubAdmission(q: Queryable, passId: string) {
  await q.query("update club_rsvps set status='attended' where id=(select club_rsvp_id from venue_passes where id=$1) and status='reserved'", [passId]);
  await q.query("update station_bookings set status='checked_in' where id=(select station_booking_id from venue_passes where id=$1) and status='reserved'", [passId]);
}
export async function eraseClubhouse(q: Queryable, userId: string) {
  await q.query("update station_bookings set status='cancelled' where user_id=$1 and status in('reserved','checked_in')", [userId]);
  // Event capacity is recalculated on the next RSVP; no deleted account retains an admission.
  await q.query("update club_rsvps set status='cancelled' where user_id=$1 and status in('reserved','waitlisted')", [userId]);
}
