/** Disposable local acceptance data. Never opens a configured production/preview database. */
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import {
  startEnrolment,
  confirmEnrolment,
  base32Decode,
  totp,
} from "../src/server/mfa.ts";
import { createOrg } from "../src/server/teams.ts";
import {
  createTournament,
  transition,
  register,
} from "../src/server/tournaments.ts";
import { createSponsor, attachSponsor } from "../src/server/sponsors.ts";
import {
  fileReport,
  issueSanction,
  fileAppeal,
} from "../src/server/conduct.ts";
const dataDir = process.env.MV_DATA_DIR;
if (!dataDir?.startsWith("/tmp/c33-"))
  throw new Error("An isolated /tmp/c33- data directory is required");
if (
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.NEON_DATABASE_URL
)
  throw new Error("Unset external database settings before local acceptance");
const db = await openDatabase({ embedded: true, dataDir });
try {
  await mkdir("artifacts", { recursive: true });
  const accounts: Record<
    string,
    { username: string; token: string; id: string }
  > = {};
  async function account(
    name: string,
    roles: SessionUser["roles"] = [],
    enroll = true,
  ) {
    const a = await signUp(db, {
      email: `${name}@example.test`,
      username: name,
      displayName: name,
      password: `fixture-${randomUUID()}`,
      adult: true,
      terms: true,
    });
    let u = (await sessionUser(db, a.token))!;
    for (const r of roles)
      await db.query("insert into user_roles(user_id,role) values($1,$2)", [
        u.id,
        r,
      ]);
    u = (await sessionUser(db, a.token))!;
    if (roles.length && enroll) {
      const f = await startEnrolment(db, u);
      await confirmEnrolment(db, u, totp(base32Decode(f.secret)));
      u = (await sessionUser(db, a.token))!;
    }
    accounts[name] = { username: name, token: a.token, id: u.id };
    return u;
  }
  const admin = await account("admin_acceptance", ["admin"]),
    reviewer = await account("review_acceptance", ["moderation"]),
    support = await account("support_acceptance", ["support"]),
    player = await account("player_acceptance");
  const org = await createOrg(db, admin, {
    name: "Acceptance Organizer",
    description: "Isolated operational admin acceptance",
  });
  const defaults = {
    participantType: "solo",
    teamSize: 1,
    maxParticipants: 8,
    checkInRequired: "",
    region: "Test",
    startsAt: "2030-10-05T12:00",
    timeZone: "UTC",
    description: "Disposable local tournament",
    rules: "Review all submitted results",
  };
  const event = await createTournament(db, admin, org.id, {
    ...defaults,
    name: "CS2 Admin Acceptance",
    game: "cs2",
    format: "double_elimination",
  } as never);
  const leaderboard = await createTournament(db, admin, org.id, {
    ...defaults,
    name: "Apex Review Leaderboard",
    game: "apex",
    format: "leaderboard",
  } as never);
  for (const t of [event, leaderboard]) {
    await transition(db, admin, t.id, "PUBLISHED");
    await transition(db, admin, t.id, "REGISTRATION_OPEN");
    await register(db, player, t.id);
  }
  const second = await account("second_acceptance");
  await register(db, second, event.id);
  await transition(db, admin, event.id, "REGISTRATION_CLOSED");
  await transition(db, admin, event.id, "IN_PROGRESS");
  await db.query(
    "insert into linked_game_accounts(user_id,game,handle) values($1,'cs2','Acceptance handle')",
    [player.id],
  );
  await db.query("update users set profile_public=false where id=$1", [
    player.id,
  ]);
  const [application] = await db.query<{ id: string }>(
    "insert into applications(kind,name,email,company,message,lang) values('venue','Acceptance Venue','venue@example.test','Test venue','Please review this disposable venue inquiry. No infrastructure is provisioned.','en') returning id",
  );
  const sponsor = await createSponsor(db, admin, {
    name: "Acceptance Partner",
    tier: "partner",
    website: "https://example.test",
  });
  await attachSponsor(db, admin, event.id, sponsor, true);
  const report = await fileReport(db, second, {
    username: player.username,
    rule: "CHEATING",
    context: "",
    description: "Please review this isolated acceptance report and evidence",
    evidence: "https://example.test/report",
  } as never);
  const sanction = await issueSanction(db, admin, {
    username: player.username,
    kind: "warning",
    protective: false,
    rule: "CHEATING",
    confidence: "medium",
    days: "",
    hours: "",
    evidence: "https://example.test/evidence — disposable local evidence",
    decision: "Test warning for independent review of the supplied evidence",
    report: "",
  });
  const appeal = await fileAppeal(
    db,
    player,
    sanction.id,
    "I request an independent review of the complete local test evidence",
    "https://example.test/appeal",
  );
  await account("unverified_acceptance", ["admin"], false);
  const stale = await account("stale_acceptance", ["admin"]);
  await db.query(
    "update sessions set mfa_at=now()-interval '20 minutes' where id=$1",
    [stale.sessionId],
  );
  await writeFile(
    "artifacts/c33-fixture.json",
    JSON.stringify(
      {
        accounts,
        org,
        event,
        leaderboard,
        application,
        sponsor,
        report,
        appeal,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log("Isolated admin acceptance fixture prepared.");
} finally {
  await db.close();
}
