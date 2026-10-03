/**
 * Physical venues and QR passes (MV-PASS-1).
 *
 * - A venue belongs to an organising space. Its owners and admins create it and send it for confirmation;
 *   portal staff confirm, reject or suspend it. Only a confirmed venue is public, can host a tournament or
 *   issue passes; a change of its name, address, city or country sends it back for confirmation.
 * - A pass admits one person to one venue in a time window, once. An event pass belongs to a participant of
 *   a tournament held at the venue (from 3 hours before the start to 24 hours after it); a guest pass is issued
 *   by the venue's managers for up to 7 days.
 * - The QR holds a link with a random token. The database keeps its SHA-256 for lookup and the token sealed
 *   (AES-256-GCM when MFA_SECRET_KEY is set) so the holder's QR can be shown again.
 * - Admission is online only: the venue's staff open the link and confirm; the pass row is locked and marked
 *   used in one transaction, so a second scan, at the same moment or later, is refused as "already used".
 *   There is no offline mode, so no cached QR can admit twice. Every scan is logged with its result.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { canManageOrg, canStaff, notify, requireSection, staffWith } from "./access.ts";
import { fail } from "./errors.ts";
import { seal, unseal } from "./secret-box.ts";
import { uniqueSlug } from "./teams.ts";
import { isCountry } from "../lib/countries.ts";
import * as v from "./validate.ts";

export const VENUE_KINDS = ["club", "arena", "games_house", "clubhouse", "other"] as const;
export type VenueKind = (typeof VENUE_KINDS)[number];
export const PASS_EARLY_HOURS = 3;
export const PASS_EVENT_HOURS = 24;
export const GUEST_MAX_DAYS = 7;
export type ScanResult = "admitted" | "used" | "expired" | "not_yet" | "revoked" | "withdrawn";

const isId = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const LIVE = "('PUBLISHED','REGISTRATION_OPEN','REGISTRATION_CLOSED','IN_PROGRESS','PAUSED')";

export type Venue = {
  id: string;
  org_id: string;
  slug: string;
  name: string;
  kind: VenueKind;
  address: string;
  city: string;
  country_code: string | null;
  description: string;
  website: string;
  status: "draft" | "submitted" | "confirmed" | "rejected" | "suspended";
  review_note: string;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type VenueInput = { name: unknown; kind: unknown; address: unknown; city: unknown; country: unknown; description: unknown; website: unknown };

function parseVenue(input: VenueInput) {
  const name = v.displayName(input.name, 80);
  const kind = (VENUE_KINDS as readonly string[]).includes(String(input.kind)) ? (String(input.kind) as VenueKind) : fail("invalid_input");
  const address = v.oneLine(input.address, 200);
  if (address.length < 5) fail("venue_address");
  const city = v.oneLine(input.city, 80);
  if (city.length < 2) fail("venue_address");
  const country = v.oneLine(input.country, 2).toUpperCase();
  if (country && !isCountry(country)) fail("invalid_input");
  const website = v.optionalUrl(input.website);
  if (website && !website.startsWith("https://")) fail("invalid_url");
  return { name, kind, address, city, country: country || null, description: v.clean(input.description, 1000), website };
}

async function lockVenue(q: Queryable, venueId: unknown): Promise<Venue> {
  if (!isId(venueId)) fail("not_found");
  const [venue] = await q.query<Venue>("select * from venues where id = $1 for update", [venueId]);
  if (!venue) fail("not_found");
  return venue;
}

async function managedVenue(q: Queryable, user: SessionUser, venueId: unknown): Promise<Venue> {
  const venue = await lockVenue(q, venueId);
  if (!(await canManageOrg(q, venue.org_id, user))) fail("forbidden");
  return venue;
}

const staffIds = (q: Queryable) => staffWith(q, "venues");
const orgManagers = async (q: Queryable, orgId: string) =>
  (await q.query<{ user_id: string }>("select user_id from org_members where org_id = $1 and role in ('owner','admin')", [orgId])).map((r) => r.user_id);

// ---------- Venues ----------

export async function createVenue(db: Database, user: SessionUser, orgId: unknown, input: VenueInput): Promise<{ id: string; slug: string }> {
  const data = parseVenue(input);
  if (!isId(orgId)) fail("not_found");
  return db.tx(async (q) => {
    const [org] = await q.query<{ id: string }>("select id from organizations where id = $1", [orgId]);
    if (!org) fail("not_found");
    if (!(await canManageOrg(q, org.id, user))) fail("forbidden");
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from venues where org_id = $1", [org.id]);
    if ((n?.n ?? 0) >= 20) fail("venue_limit");
    const slug = await uniqueSlug(q, "venues", data.name);
    const [row] = await q.query<{ id: string; slug: string }>(
      `insert into venues (org_id, slug, name, kind, address, city, country_code, description, website, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id, slug`,
      [org.id, slug, data.name, data.kind, data.address, data.city, data.country, data.description, data.website, user.id],
    );
    await audit(q, { actorId: user.id, action: "venue.created", entity: "venue", entityId: row.id, data: { org: org.id, name: data.name } });
    return row;
  });
}

/** Edits a venue; a confirmed venue whose name or address changes goes back for confirmation. */
export async function updateVenue(db: Database, user: SessionUser, venueId: unknown, input: VenueInput): Promise<{ resubmitted: boolean }> {
  const data = parseVenue(input);
  return db.tx(async (q) => {
    const venue = await managedVenue(q, user, venueId);
    const identity = venue.name !== data.name || venue.address !== data.address || venue.city !== data.city || (venue.country_code ?? null) !== data.country;
    const resubmitted = venue.status === "confirmed" && identity;
    await q.query(
      `update venues set name = $2, kind = $3, address = $4, city = $5, country_code = $6, description = $7, website = $8,
              status = case when $9 then 'submitted' else status end, updated_at = now() where id = $1`,
      [venue.id, data.name, data.kind, data.address, data.city, data.country, data.description, data.website, resubmitted],
    );
    if (resubmitted) await notify(q, await staffIds(q), "venue_submitted", { venue: data.name, adminTab: "venues" });
    await audit(q, { actorId: user.id, action: "venue.updated", entity: "venue", entityId: venue.id, data: { resubmitted } });
    return { resubmitted };
  });
}

export async function submitVenue(db: Database, user: SessionUser, venueId: unknown) {
  await db.tx(async (q) => {
    const venue = await managedVenue(q, user, venueId);
    if (!["draft", "rejected", "suspended"].includes(venue.status)) fail("venue_state");
    await q.query("update venues set status = 'submitted', updated_at = now() where id = $1", [venue.id]);
    await notify(q, await staffIds(q), "venue_submitted", { venue: venue.name, adminTab: "venues" });
    await audit(q, { actorId: user.id, action: "venue.submitted", entity: "venue", entityId: venue.id });
  });
}

/** Portal staff confirm or reject a submitted venue, or suspend a confirmed one (with a reason). */
export async function reviewVenue(db: Database, staff: SessionUser, venueId: unknown, decision: unknown, noteInput: unknown) {
  requireSection(staff, "venues");
  const note = v.clean(noteInput, 500);
  await db.tx(async (q) => {
    const venue = await lockVenue(q, venueId);
    let status: Venue["status"];
    if (decision === "confirm" && venue.status === "submitted") status = "confirmed";
    else if (decision === "reject" && venue.status === "submitted") status = "rejected";
    else if (decision === "suspend" && venue.status === "confirmed") status = "suspended";
    else return fail("venue_state");
    if (status !== "confirmed" && note.length < 10) fail("invalid_input");
    await q.query("update venues set status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now(), updated_at = now() where id = $1", [
      venue.id,
      status,
      note,
      staff.id,
    ]);
    const [org] = await q.query<{ slug: string }>("select slug from organizations where id = $1", [venue.org_id]);
    await notify(q, await orgManagers(q, venue.org_id), `venue_${status}`, { venue: venue.name, orgSlug: org?.slug ?? "" });
    await audit(q, { actorId: staff.id, action: `venue.${status}`, entity: "venue", entityId: venue.id, data: { note } });
  });
}

export async function orgVenues(q: Queryable, orgId: string): Promise<Venue[]> {
  return q.query<Venue>("select * from venues where org_id = $1 order by status = 'confirmed' desc, name", [orgId]);
}

export async function publicVenues(q: Queryable, city = ""): Promise<(Venue & { upcoming: number })[]> {
  const term = v.oneLine(city, 80);
  return q.query<Venue & { upcoming: number }>(
    `select v.*, (select count(*)::int from tournaments t where t.venue_id = v.id and t.status in ${LIVE}) as upcoming
       from venues v where v.status = 'confirmed' and ($1 = '' or lower(v.city) = lower($1)) order by v.city, v.name limit 200`,
    [term],
  );
}

export async function venueCities(q: Queryable): Promise<string[]> {
  return (await q.query<{ city: string }>("select distinct city from venues where status = 'confirmed' order by city")).map((r) => r.city);
}

/** A venue for its page: confirmed for everyone, otherwise only for its space's managers and portal staff. */
export async function venueView(q: Queryable, slug: string, user: SessionUser | null): Promise<{ venue: Venue; manager: boolean } | null> {
  const [venue] = await q.query<Venue>("select * from venues where slug = $1", [slug]);
  if (!venue) return null;
  const manager = Boolean(user && ((await canManageOrg(q, venue.org_id, user)) || canStaff(user, "venues")));
  if (venue.status !== "confirmed" && !manager) return null;
  return { venue, manager };
}

export async function venueTournaments(q: Queryable, venueId: string) {
  return q.query<{ slug: string; name: string; game: string; status: string; starts_at: Date | null }>(
    `select slug, name, game, status, starts_at from tournaments where venue_id = $1 and status in ${LIVE}
      order by starts_at asc nulls last limit 30`,
    [venueId],
  );
}

export async function venueReviewQueue(q: Queryable) {
  return q.query<Venue & { org_name: string; org_slug: string }>(
    `select v.*, o.name as org_name, o.slug as org_slug from venues v join organizations o on o.id = v.org_id
      where v.status in ('submitted','confirmed','suspended') order by v.status = 'submitted' desc, v.updated_at desc limit 100`,
  );
}

/** A tournament is held at a confirmed venue of its own space, or online (null). */
export async function setTournamentVenue(db: Database, user: SessionUser, tournamentId: unknown, venueInput: unknown) {
  if (!isId(tournamentId)) fail("not_found");
  const venueId = venueInput ? (isId(venueInput) ? venueInput : fail("not_found")) : null;
  await db.tx(async (q) => {
    const [t] = await q.query<{ id: string; org_id: string; venue_id: string | null }>(
      "select id, org_id, venue_id from tournaments where id = $1 for update",
      [tournamentId],
    );
    if (!t) fail("not_found");
    const { canManageTournament } = await import("./tournaments.ts");
    if (!(await canManageTournament(q, t, user))) fail("forbidden");
    if (venueId) {
      const [venue] = await q.query<{ org_id: string; status: string }>("select org_id, status from venues where id = $1", [venueId]);
      if (!venue || venue.org_id !== t.org_id) fail("not_found");
      if (venue.status !== "confirmed") fail("venue_not_confirmed");
    }
    await q.query("update tournaments set venue_id = $2, updated_at = now() where id = $1", [t.id, venueId]);
    await audit(q, { actorId: user.id, action: "tournament.venue_set", entity: "tournament", entityId: t.id, data: { venue: venueId } });
  });
}

// ---------- Passes ----------

export type Pass = {
  id: string;
  venue_id: string;
  user_id: string;
  tournament_id: string | null;
  kind: "event" | "guest";
  valid_from: Date;
  valid_until: Date;
  token_sealed: string;
  scheme: string;
  status: "active" | "used" | "revoked";
  used_at: Date | null;
  note: string;
  created_at: Date;
};

function newToken() {
  const token = randomBytes(24).toString("base64url");
  const sealed = seal("pass", token);
  return { token, hash: sha256(token), sealed: sealed.value, scheme: sealed.scheme };
}

/** Is the user still in the event: a registered solo entry or a roster place of a registered team? */
async function inEvent(q: Queryable, tournamentId: string, userId: string) {
  const [row] = await q.query(
    `select 1 from registrations r where r.tournament_id = $1 and r.status = 'registered'
        and (r.user_id = $2 or exists (select 1 from roster_entries re where re.registration_id = r.id and re.user_id = $2)) limit 1`,
    [tournamentId, userId],
  );
  return Boolean(row);
}

/** A participant's pass to a tournament held at a confirmed venue (created once, then shown again). */
export async function eventPass(db: Database, user: SessionUser, tournamentId: unknown): Promise<{ id: string }> {
  if (!isId(tournamentId)) fail("not_found");
  return db.tx(async (q) => {
    const [t] = await q.query<{ id: string; venue_id: string | null; starts_at: Date | null; status: string }>(
      "select id, venue_id, starts_at, status from tournaments where id = $1 for update",
      [tournamentId],
    );
    if (!t) fail("not_found");
    if (!t.venue_id || !t.starts_at) return fail("pass_no_venue");
    const venueId = t.venue_id;
    const [venue] = await q.query<{ status: string }>("select status from venues where id = $1", [venueId]);
    if (venue?.status !== "confirmed") fail("venue_not_confirmed");
    if (!["PUBLISHED", "REGISTRATION_OPEN", "REGISTRATION_CLOSED", "IN_PROGRESS", "PAUSED"].includes(t.status)) fail("pass_closed");
    if (!(await inEvent(q, t.id, user.id))) fail("pass_not_participant");
    const [existing] = await q.query<{ id: string }>("select id from venue_passes where tournament_id = $1 and user_id = $2", [t.id, user.id]);
    if (existing) return existing;
    const start = new Date(t.starts_at!).getTime();
    const tok = newToken();
    const [row] = await q.query<{ id: string }>(
      `insert into venue_passes (venue_id, user_id, tournament_id, kind, valid_from, valid_until, token_hash, token_sealed, scheme)
       values ($1, $2, $3, 'event', $4, $5, $6, $7, $8) returning id`,
      [
        venueId,
        user.id,
        t.id,
        new Date(start - PASS_EARLY_HOURS * 3_600_000),
        new Date(start + PASS_EVENT_HOURS * 3_600_000),
        tok.hash,
        tok.sealed,
        tok.scheme,
      ],
    );
    await audit(q, { actorId: user.id, action: "pass.issued", entity: "venue", entityId: venueId, data: { pass: row.id, tournament: t.id } });
    return row;
  });
}

/** A guest pass issued by the venue's managers, for up to 7 days. */
export async function issueGuestPass(
  db: Database,
  user: SessionUser,
  venueId: unknown,
  input: { username: unknown; from: unknown; until: unknown; tz: unknown; note: unknown },
): Promise<{ id: string }> {
  const username = v.username(input.username);
  const from = v.zonedToUtc(input.from, input.tz);
  const until = v.zonedToUtc(input.until, input.tz);
  const note = v.oneLine(input.note, 200);
  if (until <= from || until.getTime() <= Date.now() || until.getTime() - from.getTime() > GUEST_MAX_DAYS * 86_400_000) fail("pass_window");
  return db.tx(async (q) => {
    const venue = await managedVenue(q, user, venueId);
    if (venue.status !== "confirmed") fail("venue_not_confirmed");
    const [holder] = await q.query<{ id: string }>("select id from users where username = $1 and status = 'active'", [username]);
    if (!holder) fail("not_found");
    const tok = newToken();
    const [row] = await q.query<{ id: string }>(
      `insert into venue_passes (venue_id, user_id, kind, valid_from, valid_until, token_hash, token_sealed, scheme, note, issued_by)
       values ($1, $2, 'guest', $3, $4, $5, $6, $7, $8, $9) returning id`,
      [venue.id, holder.id, from, until, tok.hash, tok.sealed, tok.scheme, note, user.id],
    );
    await notify(q, [holder.id], "pass_issued", { venue: venue.name, passes: "1" });
    await audit(q, { actorId: user.id, action: "pass.issued", entity: "venue", entityId: venue.id, data: { pass: row.id, holder: holder.id, kind: "guest" } });
    return row;
  });
}

export async function revokePass(db: Database, user: SessionUser, passId: unknown) {
  if (!isId(passId)) fail("not_found");
  await db.tx(async (q) => {
    const [p] = await q.query<{ venue_id: string; status: string }>("select venue_id, status from venue_passes where id = $1 for update", [passId]);
    if (!p) fail("not_found");
    const venue = await managedVenue(q, user, p.venue_id);
    if (p.status !== "active") fail("pass_state");
    await q.query("update venue_passes set status = 'revoked', revoked_at = now(), revoked_by = $2 where id = $1", [passId, user.id]);
    await audit(q, { actorId: user.id, action: "pass.revoked", entity: "venue", entityId: venue.id, data: { pass: passId } });
  });
}

export type PassView = Pass & {
  venue_name: string;
  venue_slug: string;
  venue_address: string;
  venue_city: string;
  org_id: string;
  holder_username: string;
  holder_name: string;
  tournament_name: string | null;
  tournament_slug: string | null;
  used_by_username: string | null;
};

const PASS_SELECT = `select p.*, v.name as venue_name, v.slug as venue_slug, v.address as venue_address, v.city as venue_city, v.org_id,
    u.username as holder_username, u.display_name as holder_name, t.name as tournament_name, t.slug as tournament_slug, s.username as used_by_username
  from venue_passes p join venues v on v.id = p.venue_id join users u on u.id = p.user_id
  left join tournaments t on t.id = p.tournament_id left join users s on s.id = p.used_by`;

const tokenOk = (token: unknown): token is string => typeof token === "string" && /^[A-Za-z0-9_-]{32}$/.test(token);

export async function passByToken(q: Queryable, token: unknown): Promise<PassView | null> {
  if (!tokenOk(token)) return null;
  const [p] = await q.query<PassView>(`${PASS_SELECT} where p.token_hash = $1`, [sha256(token)]);
  return p ?? null;
}

/** May this user admit people at the venue: a member of its space, or portal staff. */
export async function isVenueStaff(q: Queryable, orgId: string, user: SessionUser | null) {
  if (!user) return false;
  if (canStaff(user, "venues")) return true;
  const [m] = await q.query("select 1 from org_members where org_id = $1 and user_id = $2", [orgId, user.id]);
  return Boolean(m);
}

/** What a scan would do now, without changing anything. */
export async function passState(q: Queryable, p: Pass, now = Date.now()): Promise<ScanResult> {
  if (p.status === "revoked") return "revoked";
  if (p.status === "used") return "used";
  if (now < new Date(p.valid_from).getTime()) return "not_yet";
  if (now > new Date(p.valid_until).getTime()) return "expired";
  if (p.tournament_id && !(await inEvent(q, p.tournament_id, p.user_id))) return "withdrawn";
  const [available] = await q.query(`select 1 from venue_passes p join venues v on v.id=p.venue_id join users u on u.id=p.user_id
    where p.id=$1 and v.status='confirmed' and u.status='active'
      and (p.club_rsvp_id is null or exists(select 1 from club_rsvps r join club_events e on e.id=r.event_id where r.id=p.club_rsvp_id and r.status='reserved' and e.status='published'))
      and (p.station_booking_id is null or exists(select 1 from station_bookings b join club_stations s on s.id=b.station_id where b.id=p.station_booking_id and b.status='reserved' and s.active))`, [p.id]);
  if (!available) return "withdrawn";
  return "admitted";
}

/**
 * Admits the holder once. The pass row is locked, checked and marked used in one transaction: a second scan,
 * concurrent or later, finds it used. Every attempt is logged.
 */
export async function admitPass(db: Database, staff: SessionUser, token: unknown): Promise<{ result: ScanResult; passId: string }> {
  if (!tokenOk(token)) fail("pass_unknown");
  return db.tx(async (q) => {
    const [p] = await q.query<Pass & { org_id: string }>(
      "select p.*, v.org_id from venue_passes p join venues v on v.id = p.venue_id where p.token_hash = $1 for update of p",
      [sha256(token as string)],
    );
    if (!p) fail("pass_unknown");
    if (!(await isVenueStaff(q, p.org_id, staff))) fail("forbidden");
    const result = await passState(q, p);
    if (result === "admitted") {
      await q.query("update venue_passes set status = 'used', used_at = now(), used_by = $2 where id = $1", [p.id, staff.id]);
      await q.query("update club_rsvps set status='attended' where id=(select club_rsvp_id from venue_passes where id=$1) and status='reserved'", [p.id]);
      await q.query("update station_bookings set status='checked_in' where id=(select station_booking_id from venue_passes where id=$1) and status='reserved'", [p.id]);
    }
    await q.query("insert into venue_checkins (venue_id, pass_id, staff_id, result) values ($1, $2, $3, $4)", [p.venue_id, p.id, staff.id, result]);
    await audit(q, { actorId: staff.id, action: "pass.scanned", entity: "venue", entityId: p.venue_id, data: { pass: p.id, result } });
    return { result, passId: p.id };
  });
}

/** The holder's passes, newest window first; the token is opened only for passes that can still be used. */
export async function myPasses(q: Queryable, userId: string): Promise<(PassView & { token: string | null })[]> {
  const rows = await q.query<PassView>(`${PASS_SELECT} where p.user_id = $1 order by p.valid_from desc limit 50`, [userId]);
  return rows.map((p) => ({
    ...p,
    token: p.status === "active" && new Date(p.valid_until).getTime() > Date.now() ? unseal("pass", p.token_sealed, p.scheme) : null,
  }));
}

export async function eventPassFor(q: Queryable, tournamentId: string, userId: string) {
  const [p] = await q.query<{ id: string; status: string }>("select id, status from venue_passes where tournament_id = $1 and user_id = $2", [
    tournamentId,
    userId,
  ]);
  return p ?? null;
}

export async function venuePasses(q: Queryable, venueId: string) {
  return q.query<PassView>(`${PASS_SELECT} where p.venue_id = $1 and p.status = 'active' and p.valid_until > now() order by p.valid_from limit 100`, [venueId]);
}

export async function venueCheckins(q: Queryable, venueId: string, limit = 30) {
  return q.query<{ id: string; result: ScanResult; at: Date; holder: string | null; staff: string }>(
    `select c.id, c.result, c.at, u.username as holder, s.username as staff
       from venue_checkins c left join venue_passes p on p.id = c.pass_id left join users u on u.id = p.user_id join users s on s.id = c.staff_id
      where c.venue_id = $1 order by c.at desc limit $2`,
    [venueId, limit],
  );
}

/** Account deletion: the account's passes stop working. */
export async function revokePassesOf(q: Queryable, userId: string) {
  await q.query("update venue_passes set status = 'revoked', revoked_at = now() where user_id = $1 and status = 'active'", [userId]);
}

export async function passExport(q: Queryable, userId: string) {
  return q.query(
    `select v.name as venue, p.kind, p.valid_from, p.valid_until, p.status, p.used_at, p.created_at
       from venue_passes p join venues v on v.id = p.venue_id where p.user_id = $1 order by p.created_at`,
    [userId],
  );
}
