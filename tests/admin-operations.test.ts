import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { saveGame, listGames, findGame } from "../src/server/catalog.ts";
import { createOrg, createTeam } from "../src/server/teams.ts";
import {
  createTournament,
  updateTournament,
  cloneTournament,
  register,
  transition,
} from "../src/server/tournaments.ts";
import {
  searchEvents,
  adminTransition,
  decideApplication,
  searchApplications,
  setOrganizerAccess,
  staffProfile,
  searchDecisions,
  trustDashboard,
} from "../src/server/admin-operations.ts";
import {
  issueSanction,
  fileAppeal,
  assignAppeal,
  decideAppeal,
  conductQueue,
  publicCount,
  publishRule,
} from "../src/server/conduct.ts";
import {
  createSponsor,
  updateSponsor,
  attachSponsor,
} from "../src/server/sponsors.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { DomainError } from "../src/server/errors.ts";
import { gameRosterLabel, gameModeLabel } from "../src/lib/catalog-labels.ts";
let db: Database, admin: SessionUser, support: SessionUser, player: SessionUser;
async function account(name: string, roles: SessionUser["roles"] = []) {
  const s = await signUp(db, {
    email: `${name}@example.test`,
    username: name,
    displayName: name,
    password: "correct horse battery",
    adult: true,
    terms: true,
  });
  const u = (await sessionUser(db, s.token))!;
  for (const role of roles)
    await db.query("insert into user_roles(user_id,role) values($1,$2)", [
      u.id,
      role,
    ]);
  return { ...u, roles, mfaAt: new Date() };
}
const rejects = (p: Promise<unknown>, code: string) =>
  assert.rejects(
    p,
    (e: unknown) => e instanceof DomainError && e.code === code,
  );
const gameInput = (extra: Record<string, unknown> = {}) => ({
  slug: "custom-arena",
  name: "Custom Arena",
  teamSize: 3,
  mode: "battle_royale",
  platforms: ["pc"],
  formats: ["ffa", "leaderboard"],
  genreRu: "Арена",
  genreEn: "Arena",
  reason: "Verified catalog correction by the administrator",
  version: 0,
  ...extra,
});
const tournamentInput = (extra: Record<string, unknown> = {}) => ({
  name: "Admin Operations Cup",
  game: "custom-arena",
  format: "leaderboard",
  participantType: "solo",
  teamSize: 1,
  maxParticipants: 8,
  checkInRequired: "",
  region: "",
  startsAt: "2030-05-01T12:00",
  timeZone: "UTC",
  description: "",
  rules: "",
  ...extra,
});
test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  admin = await account("ao_admin", ["admin"]);
  support = await account("ao_support", ["support"]);
  player = await account("ao_player");
});
test.after(async () => {
  await db.close();
});

test("catalog is persisted, admin-only, MFA protected, mode/roster/formats independent and stale writes refused", async () => {
  assert.equal((await listGames(db)).length, 16);
  await rejects(saveGame(db, support, gameInput()), "forbidden");
  await rejects(
    saveGame(db, { ...admin, mfaAt: null }, gameInput()),
    "step_up_required",
  );
  await rejects(
    saveGame(db, admin, gameInput({ platforms: ["unsupported"] })),
    "invalid_input",
  );
  const g = await saveGame(db, admin, gameInput());
  assert.equal(g.version, 1);
  assert.equal(gameRosterLabel(g, "en"), "3 players per roster");
  assert.equal(gameModeLabel(g.mode, "en"), "Battle royale");
  assert.deepEqual((await findGame(db, g.slug))?.formats, [
    "ffa",
    "leaderboard",
  ]);
  await rejects(saveGame(db, admin, gameInput()), "not_editable");
  const edited = await saveGame(
    db,
    admin,
    gameInput({
      version: 1,
      mode: "racing",
      teamSize: 1,
      formats: ["leaderboard"],
    }),
  );
  assert.equal(edited.version, 2);
  assert.equal(edited.scoring, "racing");
  assert.equal(edited.bracket, false);
});

test("new catalog game works through tournament creation, registration and management; retirement preserves old events and blocks new copies", async () => {
  const org = await createOrg(db, admin, {
    name: "Operations Space",
    description: "",
  });
  await rejects(
    createTournament(
      db,
      admin,
      org.id,
      tournamentInput({ format: "single_elimination" }) as never,
    ),
    "format_not_supported",
  );
  const t = await createTournament(
    db,
    admin,
    org.id,
    tournamentInput() as never,
  );
  await adminTransition(
    db,
    admin,
    t.id,
    "PUBLISHED",
    "Publish after reviewing all tournament settings",
  );
  await adminTransition(
    db,
    admin,
    t.id,
    "REGISTRATION_OPEN",
    "Registration approved for the published event",
  );
  await register(db, player, t.id);
  const found = await searchEvents(db, admin, {
    game: "custom-arena",
    format: "leaderboard",
    q: "Operations",
  });
  assert.equal(found.total, 1);
  assert.equal(found.rows[0].registered, 1);
  assert.equal(found.rows[0].checked_in, 0);
  assert.equal(
    (await searchEvents(db, admin, { q: "%" })).total,
    0,
    "wildcards are literal",
  );
  await rejects(
    adminTransition(
      db,
      support,
      t.id,
      "CANCELLED",
      "Cannot bypass administrator authorization",
    ),
    "forbidden",
  );
  await rejects(
    adminTransition(
      db,
      admin,
      t.id,
      "COMPLETED",
      "Cannot bypass completion and results checks",
    ),
    "invalid_transition",
  );
  await saveGame(
    db,
    admin,
    gameInput({
      version: 2,
      retired: true,
      mode: "racing",
      teamSize: 1,
      formats: ["leaderboard"],
    }),
  );
  assert.equal(
    (await listGames(db)).some((g) => g.slug === "custom-arena"),
    false,
  );
  await rejects(
    createTournament(db, admin, org.id, tournamentInput() as never),
    "invalid_game",
  );
  await rejects(
    createTeam(db, player, {
      name: "Retired Team",
      tag: "RT",
      game: "custom-arena",
    }),
    "invalid_game",
  );
  await rejects(cloneTournament(db, admin, t.id, {}), "invalid_game");
  await updateTournament(
    db,
    admin,
    t.id,
    tournamentInput({
      description:
        "Existing tournament remains editable after catalog retirement",
    }) as never,
  );
  assert.equal(
    (await searchEvents(db, admin, { game: "custom-arena" })).rows.length,
    1,
  );
  const actions = await searchDecisions(db, admin, {
    action: "tournament.admin_transition",
    id: t.id,
  });
  assert.equal(actions.rows.length, 2);
});

test("organizer is space-scoped, private profile/history/accounts remain protected, owner cannot be replaced", async () => {
  const org = await createOrg(db, admin, {
    name: "Scoped Organizer Space",
    description: "",
  });
  await rejects(
    setOrganizerAccess(
      db,
      support,
      player.id,
      org.id,
      "admin",
      "Proposed organizer authorization",
    ),
    "forbidden",
  );
  await setOrganizerAccess(
    db,
    admin,
    player.id,
    org.id,
    "admin",
    "Approved local organizer authorization",
  );
  await db.query("update users set profile_public=false where id=$1", [
    player.id,
  ]);
  await db.query(
    "insert into linked_game_accounts(user_id,game,handle) values($1,'cs2','User supplied name')",
    [player.id],
  );
  const p = await staffProfile(db, support, player.username);
  assert.ok(p);
  assert.equal(p.spaces.find((o) => o.id === org.id)?.role, "admin");
  assert.equal(p.accounts[0].verified, false);
  await rejects(staffProfile(db, player, player.username), "forbidden");
  await rejects(
    setOrganizerAccess(
      db,
      admin,
      admin.id,
      org.id,
      "remove",
      "Cannot strip ownership through organizer tools",
    ),
    "last_owner",
  );
  await setOrganizerAccess(
    db,
    admin,
    player.id,
    org.id,
    "remove",
    "Organizer responsibilities transferred elsewhere",
  );
  assert.equal(
    (await db.query("select 1 from user_roles where user_id=$1", [player.id]))
      .length,
    0,
    "space access never grants platform admin",
  );
});

test("application decisions are real, reasoned, step-up protected, version-bound and never provision services", async () => {
  const [a] = await db.query<{ id: string }>(
    "insert into applications(kind,name,email,lang,message) values('cloud_gaming','Operations Test','local@example.test','en','Local isolated inquiry') returning id",
  );
  await rejects(
    decideApplication(db, player, a.id, {
      status: "approved",
      reason: "Reviewed sufficient information",
      version: 1,
    }),
    "forbidden",
  );
  await rejects(
    decideApplication(db, { ...support, mfaAt: null }, a.id, {
      status: "approved",
      reason: "Reviewed sufficient information",
      version: 1,
    }),
    "step_up_required",
  );
  await decideApplication(db, support, a.id, {
    status: "approved",
    reason: "Reviewed sufficient information; service is not provisioned",
    version: 1,
  });
  await rejects(
    decideApplication(db, admin, a.id, {
      status: "rejected",
      reason: "Old form must not override colleague",
      version: 1,
    }),
    "not_editable",
  );
  const r = await searchApplications(db, support, {
    kind: "cloud_gaming",
    status: "approved",
  });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0].version, 2);
  assert.equal(r.rows[0].decider, support.username);
  assert.equal(
    (
      await searchDecisions(db, admin, {
        action: "application.decided",
        id: a.id,
      })
    ).rows.length,
    1,
  );
});

test("appeals route to another active staff member; original issuer, appellant and unassigned colleague cannot decide", async () => {
  const reviewer = await account("ao_reviewer", ["moderation"]);
  const s = await issueSanction(db, admin, {
    username: player.username,
    kind: "warning",
    protective: false,
    rule: "CHEATING",
    ruleVersion: 1,
    confidence: "high",
    days: "",
    hours: "",
    evidence: "https://example.test/evidence — isolated test evidence",
    decision: "Reviewed evidence under the specific rule version",
    report: "",
  });
  const a = await fileAppeal(
    db,
    player,
    s.id,
    "Please independently review the complete evidence and context",
    "https://example.test/appeal",
  );
  const q = (await conductQueue(db)).appeals.find((x) => x.id === a.id)!;
  assert.ok(q.assigned_to);
  assert.notEqual(q.assigned_to, admin.id);
  assert.notEqual(q.assigned_to, player.id);
  await rejects(
    assignAppeal(
      db,
      admin,
      a.id,
      reviewer.id,
      "Original issuer must not control appeal routing",
    ),
    "appeal_needs_other_reviewer",
  );
  await rejects(
    assignAppeal(
      db,
      support,
      a.id,
      admin.id,
      "Issuer cannot be independent reviewer",
    ),
    "appeal_needs_other_reviewer",
  );
  await assignAppeal(
    db,
    support,
    a.id,
    reviewer.id,
    "Assigned to independent moderation colleague",
  );
  await rejects(
    decideAppeal(
      db,
      admin,
      a.id,
      true,
      "Issuer cannot decide their own appeal",
    ),
    "appeal_needs_other_reviewer",
  );
  await rejects(
    decideAppeal(
      db,
      support,
      a.id,
      true,
      "Only the assigned independent colleague decides",
    ),
    "appeal_needs_other_reviewer",
  );
  await decideAppeal(
    db,
    reviewer,
    a.id,
    true,
    "Independent review found insufficient evidence; revoke the warning",
  );
  const [outcome] = await db.query<{
    status: string;
    assigned_to: string;
    decided_by: string;
  }>("select status,assigned_to,decided_by from sanction_appeals where id=$1", [
    a.id,
  ]);
  assert.equal(outcome.status, "granted");
  assert.equal(outcome.assigned_to, outcome.decided_by);
  const dash = await trustDashboard(db, admin);
  assert.equal(dash.report.counts.appeals_granted, 1);
  assert.equal(publicCount(1), null);
  await publishRule(db, admin, {
    code: "CHEATING",
    titleRu: "Честная игра",
    titleEn: "Fair play",
    bodyRu: "Запрещено использовать нечестные преимущества",
    bodyEn: "Do not use unfair advantages in competition",
    sourceRu: "Правила",
    sourceEn: "Rules",
  });
  await rejects(
    issueSanction(db, admin, {
      username: player.username,
      kind: "warning",
      protective: false,
      rule: "CHEATING",
      ruleVersion: 1,
      confidence: "high",
      days: "",
      hours: "",
      evidence: "https://example.test/evidence",
      decision: "Stale rule version must require a fresh review",
      report: "",
    }),
    "not_editable",
  );
});

test("sponsor record editing is version-bound and tournament attachment can be removed without deleting history", async () => {
  const marketer = await account("ao_marketer", ["marketing"]);
  const id = await createSponsor(db, marketer, {
    name: "Test sponsor",
    tier: "partner",
    website: "https://example.test",
  });
  await rejects(
    updateSponsor(db, support, id, {
      name: "Wrong role",
      tier: "gold",
      version: 1,
      reason: "Insufficient role for editing sponsor",
    }),
    "forbidden",
  );
  await updateSponsor(db, marketer, id, {
    name: "Reviewed sponsor",
    tier: "gold",
    website: "https://example.test/partner",
    active: "1",
    version: 1,
    reason: "Partner details verified in isolated acceptance",
  });
  await rejects(
    updateSponsor(db, marketer, id, {
      name: "Stale name",
      tier: "gold",
      version: 1,
      reason: "Stale editing form cannot overwrite changes",
    }),
    "not_editable",
  );
  const [{ id: event }] = await db.query<{ id: string }>(
    "select id from tournaments limit 1",
  );
  await attachSponsor(db, marketer, event, id, true);
  assert.equal(
    (
      await db.query("select * from tournament_sponsors where sponsor_id=$1", [
        id,
      ])
    ).length,
    1,
  );
  await attachSponsor(db, marketer, event, id, false);
  assert.equal(
    (
      await db.query("select * from tournament_sponsors where sponsor_id=$1", [
        id,
      ])
    ).length,
    0,
  );
  assert.equal(
    (await searchDecisions(db, admin, { action: "sponsor.updated", id })).rows
      .length,
    1,
  );
});

test("decision search uses literal filters; verifier detects a modified stored decision and integrity restores only after exact restoration", async () => {
  assert.equal((await verifyAuditChain(db)).valid, true);
  await rejects(searchDecisions(db, support, {}), "forbidden");
  assert.equal(
    (await searchDecisions(db, admin, { actor: "%" })).rows.length,
    0,
  );
  const [row] = await db.query<{ id: string; data: unknown }>(
    "select id,data from audit_log where action='application.decided' limit 1",
  );
  await db.query("update audit_log set data=$2 where id=$1", [
    row.id,
    JSON.stringify({ tampered: true }),
  ]);
  const report = await verifyAuditChain(db);
  assert.equal(report.valid, false);
  assert.equal(report.brokenAt, Number(row.id));
  await db.query("update audit_log set data=$2 where id=$1", [
    row.id,
    JSON.stringify(row.data),
  ]);
  assert.equal((await verifyAuditChain(db)).valid, true);
});
