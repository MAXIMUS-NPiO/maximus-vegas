import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { createTournament, register, transition } from "../src/server/tournaments.ts";
import { submitScore, reviewScore, scoreLog } from "../src/server/leaderboard.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
import { optionalUrl } from "../src/server/validate.ts";

const code = (value: string) => (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === value);
let db: Database, owner: SessionUser, player: SessionUser, reviewer: SessionUser, outsider: SessionUser, org: string, serial = 0;
test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  const users: SessionUser[] = [];
  for (const name of ["fixowner", "fixplayer", "fixreviewer", "fixoutsider"]) {
    const signed = await signUp(db, { email: `${name}@example.test`, username: name, displayName: name, password: "isolated correction fixture", adult: true, terms: true });
    users.push((await sessionUser(db, signed.token))!);
  }
  [owner, player, reviewer, outsider] = users;
  org = (await createOrg(db, owner, { name: "Correction fixture", description: "" })).id;
  await db.query("insert into org_members(org_id,user_id,role) values($1,$2,'referee')", [org, reviewer.id]);
});
test.after(async () => { await db.close(); });
async function event() {
  const t = await createTournament(db, owner, org, { name: `Correction ${++serial}`, game: "pubg", format: "leaderboard", participantType: "solo", teamSize: 1, maxParticipants: 2, startsAt: "2030-01-01T12:00", timeZone: "UTC", checkInRequired: "", region: "", description: "", rules: "" });
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  for (const u of [player, reviewer]) await register(db, u, t.id);
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  const [reg] = await db.query<{ id: string }>("select id from registrations where tournament_id=$1 and user_id=$2", [t.id, player.id]);
  return { t, registration: reg.id };
}
const input = (matchRef: string) => ({ matchRef, kills: 3, evidenceUrl: "https://evidence.example.test/proof" });
async function snapshot(tournament: string) {
  return {
    entries: await db.query("select * from score_entries where tournament_id=$1 order by id", [tournament]),
    history: await db.query("select h.* from score_entry_revisions h join score_entries e on e.id=h.entry_id where e.tournament_id=$1 order by h.entry_id,h.revision", [tournament]),
    xp: await db.query("select * from xp_events where ref=$1 order by id", [tournament]),
    audit: await db.query("select * from audit_log where entity_id=$1 order by id", [tournament]),
  };
}

test("expired submission, rejection, organizer correction of one entry, and independent approval", async () => {
  const { t, registration } = await event(), original = input("expired-correction");
  const entry = await submitScore(db, player, t.id, original);
  await db.query("update tournaments set submission_deadline=now()-interval '1 hour' where id=$1", [t.id]);
  await reviewScore(db, reviewer, entry.id, "reject", "Replay shows a different score", 1);
  const corrected = { ...original, registration, replaces: entry.id, expectedRevision: 1, correctionReason: "Corrected against original replay", kills: 4 };
  const beforeInvalid = await snapshot(t.id);
  await assert.rejects(submitScore(db, player, t.id, corrected), code("submission_closed"));
  await assert.rejects(submitScore(db, outsider, t.id, corrected, true), code("forbidden"));
  const [otherReg] = await db.query<{ id: string }>("select id from registrations where tournament_id=$1 and user_id=$2", [t.id, reviewer.id]);
  await assert.rejects(submitScore(db, owner, t.id, { ...corrected, registration: otherReg.id }, true), code("not_found"));
  await assert.rejects(submitScore(db, owner, t.id, { ...corrected, replaces: "00000000-0000-4000-8000-000000000000" }, true), code("not_found"));
  await assert.rejects(submitScore(db, owner, t.id, { ...corrected, correctionReason: "" }, true), code("invalid_input"));
  assert.deepEqual(await snapshot(t.id), beforeInvalid, "invalid or unauthorized corrections leave every dependent record unchanged");
  const saved = await submitScore(db, owner, t.id, corrected, true);
  assert.equal(saved.id, entry.id);
  const beforeRetry = await snapshot(t.id);
  assert.equal(beforeRetry.entries.length, 1);
  assert.equal(beforeRetry.entries[0].revision, 2);
  assert.equal(beforeRetry.entries[0].review, "pending");
  assert.equal(beforeRetry.entries[0].submitted_by, owner.id);
  assert.equal(beforeRetry.entries[0].source, "organizer");
  const reviewLine = (await scoreLog(db, t.id, { pendingOnly: true })).find(l => l.id === entry.id)!;
  assert.equal(reviewLine.correction_reason, corrected.correctionReason);
  assert.equal(reviewLine.previous_values?.kills, 3);
  assert.equal(beforeRetry.history.length, 1);
  assert.equal((beforeRetry.history[0].previous as { kills: number }).kills, 3);
  assert.equal(beforeRetry.history[0].reason, corrected.correctionReason);
  assert.equal(beforeRetry.history[0].actor_id, owner.id);
  assert.equal(beforeRetry.xp.length, 0);
  await submitScore(db, owner, t.id, corrected, true);
  await assert.rejects(submitScore(db, owner, t.id, { ...corrected, kills: 5 }, true), code("stale_submission"));
  await assert.rejects(submitScore(db, owner, t.id, { ...corrected, expectedRevision: 2, matchRef: "different-match" }, true), code("invalid_input"));
  for (const decision of ["approve", "reject"]) await assert.rejects(reviewScore(db, reviewer, entry.id, decision, "Stale form", 1), code("stale_submission"));
  assert.deepEqual(await snapshot(t.id), beforeRetry, "retries and stale forms never write history, XP or audit");
  await reviewScore(db, reviewer, entry.id, "approve", "Independent check of revision two", 2);
  const approved = await snapshot(t.id);
  assert.equal(approved.entries[0].review, "approved");
  assert.equal(approved.entries[0].reviewed_by, reviewer.id);
  assert.equal(approved.xp.length, 1);
  await submitScore(db, owner, t.id, corrected, true);
  assert.deepEqual(await snapshot(t.id), approved);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("an exact retry of a historical HTTP payload stays read-only", async () => {
  const { t } = await event(), original = input("historical-http-retry");
  const entry = await submitScore(db, player, t.id, original);
  const historical = { ...original, evidenceUrl: "http://evidence.example.test/proof" };
  // Reproduce the payload stored by the pre-HTTPS boundary with all parseLine defaults.
  const line = { kills: 3, assists: 0, deaths: 0, headshots: 0, damage: 0, distance: 0, placement: null };
  const payload = createHash("sha256").update(JSON.stringify({ line, evidence: historical.evidenceUrl, actor: player.id, asOrganizer: false })).digest("hex");
  await db.query("update score_entries set evidence_url=$2,payload_hash=$3 where id=$1", [entry.id, historical.evidenceUrl, payload]);
  for (const status of ["pending", "approved"]) {
    if (status === "approved") await reviewScore(db, reviewer, entry.id, "approve", "Original historical proof", 1);
    const before = await snapshot(t.id);
    assert.equal((await submitScore(db, player, t.id, historical)).id, entry.id);
    await assert.rejects(submitScore(db, player, t.id, { ...historical, kills: 4 }), code("invalid_evidence"));
    await assert.rejects(submitScore(db, player, t.id, { ...historical, matchRef: "copied-http-retry" }), code("invalid_evidence"));
    assert.deepEqual(await snapshot(t.id), before);
  }
});

test("new score evidence requires HTTPS for participants and organizers only at the score boundary", async () => {
  const { t, registration } = await event();
  for (const asOrganizer of [false, true]) {
    const actor = asOrganizer ? owner : player;
    await assert.rejects(submitScore(db, actor, t.id, { ...input(`http-${asOrganizer}`), registration, evidenceUrl: "http://evidence.example.test/proof" }, asOrganizer), code("invalid_evidence"));
    for (const evidenceUrl of ["https://user:pass@evidence.example.test/proof", "https://user@evidence.example.test/proof"]) await assert.rejects(submitScore(db, actor, t.id, { ...input(`credentials-${asOrganizer}`), registration, evidenceUrl }, asOrganizer), code("invalid_evidence"));
    for (const evidenceUrl of ["javascript:alert(1)", "ftp://evidence.example.test/proof", "not a URL"]) {
      await assert.rejects(submitScore(db, actor, t.id, { ...input(`bad-${asOrganizer}`), registration, evidenceUrl }, asOrganizer), code("invalid_url"));
    }
    await submitScore(db, actor, t.id, { ...input(`https-${asOrganizer}`), registration }, asOrganizer);
  }
  await assert.rejects(submitScore(db, player, t.id, { ...input("no-proof-player"), evidenceUrl: "" }), code("invalid_evidence"));
  await submitScore(db, owner, t.id, { ...input("no-proof-organizer"), evidenceUrl: "", registration }, true);
  assert.equal((await scoreLog(db, t.id)).length, 3);
  assert.equal(optionalUrl("http://example.test/unrelated"), "http://example.test/unrelated", "the shared URL validator retains its contract");
});

test("historical HTTP evidence survives reads and unrelated corrections but cannot be introduced or replaced with HTTP", async () => {
  const { t, registration } = await event();
  for (const [i, evidenceUrl] of [undefined, "", "http://legacy.example.test/raw"].entries()) {
    const original = input(`legacy-evidence-${i}`), entry = await submitScore(db, player, t.id, original);
    await db.query("update score_entries set evidence_url=$2 where id=$1", [entry.id, "http://legacy.example.test/raw"]);
    assert.equal((await scoreLog(db, t.id)).find(e => e.id === entry.id)?.evidence_url, "http://legacy.example.test/raw");
    await reviewScore(db, reviewer, entry.id, "reject", "Fix only the game statistics", 1);
    const corrected = { ...original, evidenceUrl, kills: 4, registration, replaces: entry.id, expectedRevision: 1, correctionReason: "Statistics corrected from the same evidence" };
    const before = await snapshot(t.id);
    await assert.rejects(submitScore(db, owner, t.id, { ...corrected, evidenceUrl: "http://different.example.test/proof" }, true), code("invalid_evidence"));
    assert.deepEqual(await snapshot(t.id), before);
    await submitScore(db, i === 0 ? player : owner, t.id, corrected, i !== 0);
    const [stored] = await db.query<{ evidence_url: string }>("select evidence_url from score_entries where id=$1", [entry.id]);
    assert.equal(stored.evidence_url, "http://legacy.example.test/raw");
    const [history] = await db.query<{ previous: { evidence_url: string } }>("select previous from score_entry_revisions where entry_id=$1", [entry.id]);
    assert.equal(history.previous.evidence_url, stored.evidence_url);
    await reviewScore(db, reviewer, entry.id, "approve", "Independent evidence check", 2);
    await reviewScore(db, reviewer, entry.id, "reject", "Use the migrated HTTPS replay", 2);
    await submitScore(db, owner, t.id, { ...corrected, expectedRevision: 2, evidenceUrl: "https://legacy.example.test/raw" }, true);
    assert.equal((await scoreLog(db, t.id)).find(e => e.id === entry.id)?.evidence_url, "https://legacy.example.test/raw");
  }
  await assert.rejects(submitScore(db, owner, t.id, { ...input("copied-history"), evidenceUrl: "http://legacy.example.test/raw", registration }, true), code("invalid_evidence"));
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("pending review reaches old entries beyond the history cap and drains every batch", async () => {
  const { t, registration } = await event();
  // Legacy fixture: scoreLog must remain operable even with historical rows above today's entry cap.
  await db.query(`insert into score_entries(tournament_id,registration_id,submitted_by,source,kills,assists,deaths,headshots,damage,distance,match_ref,evidence_url,review,created_at)
    select $1,$2,$3,'participant',1,0,0,0,0,0,'queue-'||n,'https://example.test/proof',
      case when n <= 501 then 'pending' else 'approved' end, timestamp '2025-01-01' + n * interval '1 second'
    from generate_series(1,1101) as n`, [t.id,registration,player.id]);
  const latest = await scoreLog(db,t.id);
  assert.equal(latest.length,500);
  assert.equal(latest.some(l=>l.review==="pending"),false,"old pending rows lie beyond the recent-history window");
  const first = await scoreLog(db,t.id,{pendingOnly:true});
  assert.equal(first.length,500); assert.equal(first[0].match_ref,"queue-1"); assert.equal(first[499].match_ref,"queue-500");
  const [page2,page3] = await Promise.all([scoreLog(db,t.id,{page:2}),scoreLog(db,t.id,{page:3})]);
  assert.equal(page2.length,500); assert.equal(page3.length,101);
  assert.equal(new Set([...latest,...page2,...page3].map(l=>l.id)).size,1101,"every history row is reachable without duplication");
  await db.query("update score_entries set review='approved' where id=any($1::uuid[])",[first.map(l=>l.id)]);
  const next = await scoreLog(db,t.id,{pendingOnly:true});
  assert.equal(next.length,1); assert.equal(next[0].match_ref,"queue-501");
  await reviewScore(db,reviewer,next[0].id,"approve","Queue reached the oldest remaining result",1);
  assert.equal((await scoreLog(db,t.id,{pendingOnly:true})).length,0);
});

test("a playing referee must supply evidence and cannot approve their own roster result", async () => {
  for (const asOrganizer of [false,true]) {
    const { t } = await event();
    const [ownReg] = await db.query<{id:string}>("select id from registrations where tournament_id=$1 and user_id=$2",[t.id,reviewer.id]);
    const score = {...input(`referee-own-${asOrganizer}`),registration:ownReg.id};
    await assert.rejects(submitScore(db,reviewer,t.id,{...score,evidenceUrl:""},asOrganizer),code("invalid_evidence"));
    const entry=await submitScore(db,reviewer,t.id,score,asOrganizer);
    assert.equal(entry.review,"pending");
    const before=await snapshot(t.id);
    await assert.rejects(reviewScore(db,reviewer,entry.id,"approve","My own score",1),code("forbidden"));
    assert.deepEqual(await snapshot(t.id),before,"self-approval never changes score, XP or audit");
    await reviewScore(db,owner,entry.id,"approve","Reviewed by staff outside this roster",1);
    const after=await snapshot(t.id);
    assert.equal(after.entries[0].review,"approved");
    assert.equal(after.entries[0].reviewed_by,owner.id);
    assert.equal(after.xp.length,1);
  }
});
