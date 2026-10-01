import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openDatabase, type Database } from "../src/server/db.ts";
import { deleteAccount, exportAccount, signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { createTournament, register, transition, withdraw, type TournamentInput } from "../src/server/tournaments.ts";
import {
  admitPass,
  createVenue,
  eventPass,
  issueGuestPass,
  myPasses,
  passByToken,
  publicVenues,
  revokePass,
  reviewVenue,
  setTournamentVenue,
  submitVenue,
  updateVenue,
  venueCheckins,
  venueView,
} from "../src/server/venues.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
let seq = 0;
const PASSWORD = "correct horse battery";
const tokens = new Map<string, string>();
async function mk(name: string): Promise<SessionUser> {
  const s = await signUp(db, { email: `${name}@example.com`, username: name, displayName: name.toUpperCase(), password: PASSWORD, adult: "on", terms: "on" });
  tokens.set(name, s.token);
  return (await sessionUser(db, s.token))!;
}
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}
const base = (over: Partial<TournamentInput> = {}): TournamentInput => ({
  name: `Venue Cup ${++seq}`,
  game: "cs2",
  participantType: "solo",
  teamSize: 1,
  maxParticipants: 8,
  checkInRequired: "",
  region: "",
  startsAt: "2030-01-01T12:00",
  timeZone: "UTC",
  description: "",
  rules: "",
  ...over,
});
const venueInput = (over: Record<string, string> = {}) => ({
  name: "Games House Marina",
  kind: "games_house",
  address: "Marina Walk 12, floor 2",
  city: "Dubai",
  country: "AE",
  description: "Тридцать станций, сцена.",
  website: "https://example.org/house",
  ...over,
});
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().slice(0, 16);

let owner: SessionUser;
let staff: SessionUser;
let orgId: string;

test.before(async () => {
  process.env.MFA_SECRET_KEY = "venue-test-secret-key-0123456789abcdef";
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  owner = await mk("vn_owner");
  const s = await mk("vn_staff");
  await db.query("insert into user_roles (user_id, role) values ($1, 'support')", [s.id]);
  staff = (await sessionUser(db, tokens.get("vn_staff")))!;
  orgId = (await createOrg(db, owner, { name: "Venue Space", description: "" })).id;
});
test.after(async () => {
  await db.close();
  delete process.env.MFA_SECRET_KEY;
});

test("venues: public only after confirmation; a new address goes back for confirmation", async () => {
  const stranger = await mk("vn_x");
  await rejects(createVenue(db, stranger, orgId, venueInput()), "forbidden");
  await rejects(createVenue(db, owner, orgId, venueInput({ address: "x" })), "venue_address");
  await rejects(createVenue(db, owner, orgId, venueInput({ website: "http://example.org" })), "invalid_url");
  await rejects(createVenue(db, owner, orgId, venueInput({ kind: "shared_desk" })), "invalid_input");
  const v = await createVenue(db, owner, orgId, venueInput());
  assert.equal(await venueView(db, v.slug, null), null, "a draft is not public");
  assert.equal((await venueView(db, v.slug, owner))?.manager, true);
  await rejects(reviewVenue(db, staff, v.id, "confirm", ""), "venue_state");
  await submitVenue(db, owner, v.id);
  await rejects(reviewVenue(db, owner, v.id, "confirm", ""), "forbidden");
  await rejects(reviewVenue(db, staff, v.id, "reject", "нет"), "invalid_input");
  await reviewVenue(db, staff, v.id, "reject", "Адрес не совпадает с фото вывески.");
  await submitVenue(db, owner, v.id);
  await reviewVenue(db, staff, v.id, "confirm", "");
  assert.ok((await publicVenues(db)).some((x) => x.id === v.id));
  assert.ok(await venueView(db, v.slug, null));
  assert.deepEqual(await updateVenue(db, owner, v.id, venueInput({ description: "Сорок станций." })), { resubmitted: false });
  assert.deepEqual(await updateVenue(db, owner, v.id, venueInput({ description: "Сорок станций.", address: "Marina Walk 14" })), { resubmitted: true });
  assert.equal(await venueView(db, v.slug, null), null, "hidden until the new address is confirmed");
  assert.ok(!(await publicVenues(db)).some((x) => x.id === v.id));
  await reviewVenue(db, staff, v.id, "confirm", "");
  await reviewVenue(db, staff, v.id, "suspend", "Площадка закрыта на ремонт до весны.");
  assert.equal(await venueView(db, v.slug, null), null);
});

async function confirmedVenue(name: string) {
  const v = await createVenue(db, owner, orgId, venueInput({ name }));
  await submitVenue(db, owner, v.id);
  await reviewVenue(db, staff, v.id, "confirm", "");
  return v;
}

test("event pass: participants only, one per player; admitted once; expired, early, revoked and withdrawn refused", async () => {
  const venue = await confirmedVenue("Arena North");
  const draftVenue = await createVenue(db, owner, orgId, venueInput({ name: "Not Yet Venue" }));
  const otherOwner = await mk("vn_other");
  const otherOrg = await createOrg(db, otherOwner, { name: "Other Venue Space", description: "" });
  const foreign = await createVenue(db, otherOwner, otherOrg.id, venueInput({ name: "Foreign Hall" }));
  const t = await createTournament(db, owner, orgId, base({ startsAt: at(60), timeZone: "UTC" }));
  await rejects(setTournamentVenue(db, owner, t.id, draftVenue.id), "venue_not_confirmed");
  await rejects(setTournamentVenue(db, owner, t.id, foreign.id), "not_found");
  await setTournamentVenue(db, owner, t.id, venue.id);
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  const [p1, p2, outsider] = [await mk("vn_p1"), await mk("vn_p2"), await mk("vn_out")];
  await register(db, p1, t.id);
  await register(db, p2, t.id);
  await rejects(eventPass(db, outsider, t.id), "pass_not_participant");
  const pass = await eventPass(db, p1, t.id);
  assert.deepEqual(await eventPass(db, p1, t.id), pass, "one pass per player and event");
  const [mine] = await myPasses(db, p1.id);
  assert.equal(mine.id, pass.id);
  assert.match(mine.token!, /^[A-Za-z0-9_-]{32}$/);
  const [row] = await db.query<{ token_hash: string; token_sealed: string; scheme: string }>(
    "select token_hash, token_sealed, scheme from venue_passes where id = $1",
    [pass.id],
  );
  assert.equal(row.token_hash, createHash("sha256").update(mine.token!).digest("hex"));
  assert.equal(row.scheme, "aes-256-gcm");
  assert.ok(!row.token_sealed.includes(mine.token!), "the token is sealed at rest");
  // Only the venue's space (or portal staff) admits.
  await rejects(admitPass(db, outsider, mine.token), "forbidden");
  await rejects(admitPass(db, owner, "x".repeat(32)), "pass_unknown");
  await rejects(admitPass(db, owner, "short"), "pass_unknown");
  // Valid from three hours before the start: an hour before the start it admits once.
  assert.deepEqual((await admitPass(db, owner, mine.token)).result, "admitted");
  assert.deepEqual((await admitPass(db, staff, mine.token)).result, "used", "a reused QR is refused");
  assert.equal((await passByToken(db, mine.token))?.status, "used");
  assert.equal((await myPasses(db, p1.id))[0].token, null, "a used pass shows no QR");
  // Two scans at the same moment: one admits, the other finds it used.
  const second = await eventPass(db, p2, t.id);
  const token2 = (await myPasses(db, p2.id))[0].token!;
  const results = (await Promise.all([admitPass(db, owner, token2), admitPass(db, staff, token2)])).map((r) => r.result).sort();
  assert.deepEqual(results, ["admitted", "used"]);
  // Early, expired, revoked, withdrawn.
  const later = await createTournament(db, owner, orgId, base({ startsAt: at(6 * 60), timeZone: "UTC" }));
  await setTournamentVenue(db, owner, later.id, venue.id);
  await transition(db, owner, later.id, "PUBLISHED");
  await transition(db, owner, later.id, "REGISTRATION_OPEN");
  const [q1, q2, q3] = [await mk("vn_q1"), await mk("vn_q2"), await mk("vn_q3")];
  for (const q of [q1, q2, q3]) await register(db, q, later.id);
  const early = await eventPass(db, q1, later.id);
  const earlyToken = (await myPasses(db, q1.id))[0].token!;
  assert.equal((await admitPass(db, owner, earlyToken)).result, "not_yet", "six hours before the start is too early");
  await db.query("update venue_passes set valid_from = now() - interval '2 days', valid_until = now() - interval '1 hour' where id = $1", [early.id]);
  assert.equal((await admitPass(db, owner, earlyToken)).result, "expired");
  await eventPass(db, q2, later.id);
  const revoked = (await myPasses(db, q2.id))[0];
  await revokePass(db, owner, revoked.id);
  await db.query("update venue_passes set valid_from = now() - interval '1 hour' where id = $1", [revoked.id]);
  assert.equal((await admitPass(db, owner, revoked.token)).result, "revoked");
  const gone = await eventPass(db, q3, later.id);
  const goneToken = (await myPasses(db, q3.id))[0].token!;
  await db.query("update venue_passes set valid_from = now() - interval '1 hour' where id = $1", [gone.id]);
  await withdraw(db, q3, later.id);
  assert.equal((await admitPass(db, owner, goneToken)).result, "withdrawn", "a withdrawn entry no longer admits");
  const log = (await venueCheckins(db, venue.id)).map((c) => c.result);
  for (const r of ["admitted", "used", "not_yet", "expired", "revoked", "withdrawn"]) assert.ok(log.includes(r as never), r);
  assert.ok(second.id);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("guest passes: issued by the venue's managers for up to 7 days; deletion revokes passes; export lists them", async () => {
  const venue = await confirmedVenue("Club South");
  const guest = await mk("vn_guest");
  const outsider = await mk("vn_g_out");
  const input = { username: guest.username, from: at(-10), until: at(120), tz: "UTC", note: "Визит команды" };
  await rejects(issueGuestPass(db, outsider, venue.id, input), "forbidden");
  await rejects(issueGuestPass(db, owner, venue.id, { ...input, until: at(8 * 24 * 60) }), "pass_window");
  await rejects(issueGuestPass(db, owner, venue.id, { ...input, from: at(-120), until: at(-60) }), "pass_window");
  const pass = await issueGuestPass(db, owner, venue.id, input);
  const [n] = await db.query<{ kind: string }>("select kind from notifications where user_id = $1 order by created_at desc limit 1", [guest.id]);
  assert.equal(n.kind, "pass_issued");
  const data = (await exportAccount(db, guest)) as unknown as { venuePasses: unknown[] };
  assert.equal(data.venuePasses.length, 1);
  const token = (await myPasses(db, guest.id))[0].token!;
  await deleteAccount(db, guest, PASSWORD);
  assert.equal((await admitPass(db, owner, token)).result, "revoked", "a deleted account's pass stops working");
  assert.ok(pass.id);
});
