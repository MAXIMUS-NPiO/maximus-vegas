import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { saveSocialProfile, discover, likeProfile, blockProfile, withdrawSocialProfile, socialExport, eraseSocial, closeMatch, GAMING_CONSENT } from "../src/server/social.ts";
import { socialCallAction, callIceConfiguration, socialCallsAvailable, expireSocialCalls } from "../src/server/social-calls.ts";
import { DomainError } from "../src/server/errors.ts";
import { issueSanction } from "../src/server/conduct.ts";
import { gate } from "../src/server/system.ts";
let db: Database;
const profile = { intent: "gaming", age: 28, game: "cs2", city: "C26", bio: "Isolated consenting profile", consent: true };
const secret = "isolated-domain-fixture-relay-secret-32";
async function account(database = db) {
  const username = `s26_${randomUUID().slice(0, 8)}`;
  const session = await signUp(database, { username, displayName: username, email: `${username}@example.com`, password: "isolated secure passphrase", adult: true, terms: true });
  const user = (await sessionUser(database, session.token))!;
  await saveSocialProfile(database, user, profile); return user;
}
async function pair(database = db) {
  const a = await account(database), b = await account(database);
  await likeProfile(database, a, b.id); const matchId = (await likeProfile(database, b, a.id))!;
  return { a, b, matchId, da: randomUUID(), dbb: randomUUID() };
}
const reject = (value: Promise<unknown>, code: string) => assert.rejects(value, (e: unknown) => e instanceof DomainError && e.code === code);
const sdp = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 AA:BB\r\n";
const relay = { candidate: "candidate:1 1 udp 1234 203.0.113.2 50000 typ relay raddr 0.0.0.0 rport 0", sdpMid: "0", sdpMLineIndex: 0 };
test.before(async () => { process.env.MV_TURN_URLS = "turn:127.0.0.1:3478"; process.env.MV_TURN_SECRET = secret; db = await openDatabase({ embedded: true, dataDir: "memory://" }); });
test.after(async () => { await db.close(); });

test("Gaming ranking requires separate bilateral consent, excludes zero-match data and reveals no exact ratings", async () => {
  const a = await account(), b = await account(), c = await account();
  for (const u of [a, b, c]) await db.query("insert into ratings(user_id,game,rating,matches) values($1,'cs2',$2,4)", [u.id, u.id === c.id ? 1700 : 1000]);
  assert.equal((await discover(db, a)).find(p => p.user_id === b.id)?.gaming_points, 0);
  await saveSocialProfile(db, a, { ...profile, gamingConsent: true });
  assert.equal((await discover(db, a)).find(p => p.user_id === b.id)?.gaming_points, 0);
  for (const u of [b, c]) await saveSocialProfile(db, u, { ...profile, gamingConsent: true });
  const rows = await discover(db, a), fit = rows.find(p => p.user_id === b.id)!;
  assert.equal(fit.gaming_points, 25); assert.equal(rows[0].user_id, b.id);
  assert.equal(rows.find(p => p.user_id === c.id)?.gaming_points, 15);
  assert.deepEqual(Object.keys(fit.gaming_fit[0]).sort(), ["game", "points", "recent", "similar"]);
  assert.equal("rating" in fit, false); assert.equal("gaming_consented_at" in fit, false);
  await db.query("update ratings set matches=0 where user_id=$1", [b.id]);
  assert.equal((await discover(db, a)).find(p => p.user_id === b.id)?.gaming_points, 0);
  const own = await socialExport(db, a.id); assert.equal(own.profile?.gaming_consent_version, GAMING_CONSENT);
  await saveSocialProfile(db, a, profile);
  assert.equal((await discover(db, a)).every(p => p.gaming_points === 0 && p.gaming_fit.length === 0), true);
});

test("Gaming fit caps at three disciplines, retains filters and removes withdrawn or blocked candidates", async () => {
  const a = await account(), b = await account();
  for (const u of [a, b]) {
    await saveSocialProfile(db, u, { ...profile, gamingConsent: true });
    for (const game of ["cs2", "dota2", "valorant", "lol"]) await db.query("insert into ratings(user_id,game,matches) values($1,$2,1)", [u.id, game]);
  }
  assert.equal((await discover(db, a)).find(p => p.user_id === b.id)?.gaming_points, 75);
  assert.equal((await discover(db, a, { city: "Elsewhere" })).length, 0);
  assert.equal((await discover(db, a, { minAge: "40" })).some(p => p.user_id === b.id), false);
  await blockProfile(db, b, a.id); assert.equal((await discover(db, a)).some(p => p.user_id === b.id), false);
  await blockProfile(db, b, a.id, true); await withdrawSocialProfile(db, b);
  assert.equal((await discover(db, a)).some(p => p.user_id === b.id), false);
  assert.equal((await socialExport(db, b.id)).profile?.gaming_consent, false);
});

test("Gaming fit is ordered before the page limit, even for an older profile", async () => {
  const a = await account(), b = await account();
  for (const u of [a, b]) {
    await saveSocialProfile(db, u, { ...profile, city: "Ranking limit", gamingConsent: true });
    await db.query("insert into ratings(user_id,game,matches) values($1,'cs2',1)", [u.id]);
  }
  await db.query("update social_profiles set updated_at='2000-01-01' where user_id=$1", [b.id]);
  for (let i = 0; i < 41; i++) { const other = await account(); await saveSocialProfile(db, other, { ...profile, city: "Ranking limit" }); }
  const rows = await discover(db, a, { city: "Ranking limit" });
  assert.equal(rows.length, 40); assert.equal(rows[0].user_id, b.id);
});

test("Relay configuration is mandatory, opaque, bounded and relay-only", () => {
  const time = 1_800_000_000_000, config = callIceConfiguration(time), server = config.iceServers[0];
  assert.equal(config.iceTransportPolicy, "relay"); assert.equal(Number(server.username.split(":")[0]), time / 1000 + 1920);
  assert.equal(server.credential, createHmac("sha1", secret).update(server.username).digest("base64"));
  delete process.env.MV_TURN_SECRET; assert.equal(socialCallsAvailable(), false); assert.throws(() => callIceConfiguration(), DomainError);
  process.env.MV_TURN_SECRET = secret;
  for (const invalid of ["stun:example.com", "turn:user:password@example.com", "turn:example.com:99999", "turn:example.com?wrong=1"]) {
    process.env.MV_TURN_URLS = invalid; assert.equal(socialCallsAvailable(), false);
  }
  process.env.MV_TURN_URLS = "turn:127.0.0.1:3478";
});

test("Calls require a mutual match, explicit recipient acceptance and one owning browser per participant", async () => {
  const p = await pair(), outsider = await account();
  await reject(socialCallAction(db, outsider, { action: "poll", matchId: p.matchId, device: randomUUID() }), "not_found");
  const start = await socialCallAction(db, p.a, { action: "start", matchId: p.matchId, device: p.da, mode: "audio" });
  assert.equal(start.call?.state, "ringing"); assert.equal(start.ice, undefined);
  assert.equal((await socialCallAction(db, p.a, { action: "start", matchId: p.matchId, device: p.da, mode: "audio" })).call?.id, start.call?.id);
  const callId = start.call!.id;
  await reject(socialCallAction(db, p.a, { action: "accept", matchId: p.matchId, callId, device: p.da }), "forbidden");
  const accepted = await socialCallAction(db, p.b, { action: "accept", matchId: p.matchId, callId, device: p.dbb });
  assert.equal(accepted.call?.state, "accepted"); assert.equal(accepted.ice?.iceTransportPolicy, "relay");
  await reject(socialCallAction(db, p.b, { action: "accept", matchId: p.matchId, callId, device: randomUUID() }), "session_overlap");
  const otherTab = await socialCallAction(db, p.b, { action: "poll", matchId: p.matchId, device: randomUUID() });
  assert.equal(otherTab.call?.owned, false); assert.equal(otherTab.ice, undefined); assert.deepEqual(otherTab.signals, []);
  const exported = JSON.stringify(await socialExport(db, p.a.id)); assert.ok(!/candidate:|fingerprint|credential|caller_client|callee_client/.test(exported));
  await socialCallAction(db, p.b, { action: "end", matchId: p.matchId, callId, device: p.dbb });
});

test("Signalling validates role, mode, relay candidates, device, replay scope and private cursors", async () => {
  const p = await pair();
  const callId = (await socialCallAction(db, p.a, { action: "start", matchId: p.matchId, device: p.da, mode: "audio" })).call!.id;
  const offer = { action: "signal", matchId: p.matchId, callId, device: p.da, kind: "offer", payload: { type: "offer", sdp }, clientId: randomUUID() };
  await reject(socialCallAction(db, p.a, offer), "request_state");
  await socialCallAction(db, p.b, { action: "accept", matchId: p.matchId, callId, device: p.dbb });
  await reject(socialCallAction(db, p.b, { ...offer, device: p.dbb }), "forbidden");
  await reject(socialCallAction(db, p.a, { ...offer, payload: { type: "offer", sdp: sdp + "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n" } }), "invalid_input");
  await db.query("select setval(pg_get_serial_sequence('social_call_signals','id'),98,false)");
  await socialCallAction(db, p.a, offer); await socialCallAction(db, p.a, offer);
  await reject(socialCallAction(db, p.a, { ...offer, payload: { type: "offer", sdp: sdp + "a=sendrecv\r\n" } }), "invalid_input");
  await reject(socialCallAction(db, p.a, { ...offer, clientId: randomUUID() }), "request_state");
  const ice = { ...offer, kind: "ice", clientId: randomUUID(), payload: relay };
  await reject(socialCallAction(db, p.a, { ...ice, payload: { ...relay, candidate: relay.candidate.replace("typ relay", "typ host") } }), "invalid_input");
  await reject(socialCallAction(db, p.a, { ...ice, payload: { ...relay, candidate: relay.candidate.replace("raddr 0.0.0.0", "raddr 192.168.1.2") } }), "invalid_input");
  await socialCallAction(db, p.a, ice);
  await socialCallAction(db, p.a, { ...ice, clientId: randomUUID(), payload: { ...relay, candidate: relay.candidate.replace("50000", "50001") } });
  const poll = await socialCallAction(db, p.b, { action: "poll", matchId: p.matchId, device: p.dbb }); assert.deepEqual(poll.signals.map(s => s.id), ["98", "99", "100"], "numeric order must survive a decimal boundary");
  assert.equal((await socialCallAction(db, p.a, { action: "poll", matchId: p.matchId, device: p.da })).signals.length, 0);
  assert.equal((await socialCallAction(db, p.b, { action: "poll", matchId: p.matchId, device: p.dbb, after: Number(poll.signals.at(-1)!.id) })).signals.length, 0);
  await blockProfile(db, p.b, p.a.id);
  assert.equal((await db.query("select 1 from social_call_signals where call_id=$1", [callId])).length, 0);
  assert.equal((await db.query("select 1 from social_call_members where call_id=$1", [callId])).length, 0);
  assert.equal((await socialCallAction(db, p.a, { action: "poll", matchId: p.matchId, device: p.da })).call?.state, "ended");
});

test("Decline, withdrawal, unmatch, erasure and missing relay clean up live reservations", async () => {
  for (const action of ["decline", "withdraw", "close", "erase", "relay"] as const) {
    const p = await pair(), start = await socialCallAction(db, p.a, { action: "start", matchId: p.matchId, device: p.da, mode: "video" }), callId = start.call!.id;
    if (action === "decline") await socialCallAction(db, p.b, { action, callId, matchId: p.matchId, device: p.dbb });
    if (action === "withdraw") await withdrawSocialProfile(db, p.b);
    if (action === "close") await closeMatch(db, p.b, p.matchId);
    if (action === "erase") await db.tx(async q => { await q.query("select id from users where id=$1 for update", [p.b.id]); await eraseSocial(q, p.b.id); });
    if (action === "relay") { delete process.env.MV_TURN_SECRET; await socialCallAction(db, p.a, { action: "poll", matchId: p.matchId, device: p.da }); process.env.MV_TURN_SECRET = secret; }
    assert.equal((await db.query("select 1 from social_call_members where call_id=$1", [callId])).length, 0);
    if (action === "erase") assert.equal((await socialExport(db, p.b.id)).calls.length, 0);
  }
});

test("A platform suspension ends accepted media control immediately", async () => {
  const p = await pair(), moderator = { ...(await account()), roles: ["moderation"] } as SessionUser;
  const callId = (await socialCallAction(db, p.a, { action: "start", matchId: p.matchId, device: p.da, mode: "audio" })).call!.id;
  await socialCallAction(db, p.b, { action: "accept", matchId: p.matchId, callId, device: p.dbb });
  const [rule] = await db.query<{ code: string }>("select code from conduct_rules where retired_at is null limit 1");
  await issueSanction(db, moderator, { username: p.a.username, kind: "suspension", confidence: "high", rule: rule.code, days: 1, protective: false, hours: "", report: "", decision: "Independently reviewed isolated call test", evidence: "https://example.com/isolated-evidence" });
  assert.equal((await db.query<{ state: string }>("select state from social_calls where id=$1", [callId]))[0].state, "ended");
  assert.equal((await db.query("select 1 from social_call_members where call_id=$1", [callId])).length, 0);
});

test("Dead clients and unanswered invitations expire; safety actions remain available in maintenance", async () => {
  const p = await pair();
  const first = await socialCallAction(db, p.a, { action: "start", matchId: p.matchId, device: p.da, mode: "audio" });
  await db.query("update social_calls set expires_at=now()-interval '1 second' where id=$1", [first.call!.id]);
  await expireSocialCalls(db); assert.equal((await db.query("select 1 from social_call_members where call_id=$1", [first.call!.id])).length, 0);
  const callId = (await socialCallAction(db, p.a, { action: "start", matchId: p.matchId, device: randomUUID(), mode: "audio" })).call!.id;
  await socialCallAction(db, p.b, { action: "accept", matchId: p.matchId, callId, device: p.dbb });
  await db.query("update social_calls set caller_seen=now()-interval '31 seconds' where id=$1", [callId]);
  assert.equal((await socialCallAction(db, p.b, { action: "poll", matchId: p.matchId, device: p.dbb })).call?.state, "ended");
  await db.query("insert into feature_flags(key,enabled,note) values('maintenance',true,'Isolated test')");
  for (const action of ["social.call_end", "social.block", "social.withdraw", "social.close", "social.report"]) await gate(db, action, p.a);
  await reject(gate(db, "social.call_start", p.a), "maintenance");
});

const pgUrl = process.env.PG_TEST_URL;
if (pgUrl && (!['localhost','127.0.0.1'].includes(new URL(pgUrl).hostname) || !/^\/c2[56]_/.test(new URL(pgUrl).pathname))) throw Error("Calls concurrency requires a local c25_ or c26_ database");
test("PostgreSQL: reciprocal starts, cross-match starts, acceptance/block and signal/end races preserve consent", { skip: !pgUrl }, async () => {
  const pg = await openDatabase({ url: pgUrl });
  try {
    const p = await pair(pg), c = await account(pg);
    await likeProfile(pg, p.a, c.id); const otherMatch = (await likeProfile(pg, c, p.a.id))!;
    const starts = await Promise.allSettled([
      socialCallAction(pg, p.a, { action: "start", matchId: p.matchId, device: p.da, mode: "audio" }),
      socialCallAction(pg, p.b, { action: "start", matchId: p.matchId, device: p.dbb, mode: "audio" }),
      socialCallAction(pg, c, { action: "start", matchId: otherMatch, device: randomUUID(), mode: "audio" }),
    ]);
    assert.equal(starts.filter(x => x.status === "fulfilled").length, 1);
    const [row] = await pg.query<{ id: string; match_id: string; caller_id: string; callee_id: string }>("select * from social_calls where state<>'ended' and $1 in(caller_id,callee_id)", [p.a.id]);
    const callee = [p.a, p.b, c].find(u => u.id === row.callee_id)!;
    await Promise.allSettled([
      socialCallAction(pg, callee, { action: "accept", callId: row.id, matchId: row.match_id, device: randomUUID() }),
      blockProfile(pg, callee, row.caller_id),
    ]);
    assert.equal((await pg.query<{ state: string }>("select state from social_calls where id=$1", [row.id]))[0].state, "ended");
    assert.equal((await pg.query("select 1 from social_call_members where call_id=$1", [row.id])).length, 0);
    const z = await pair(pg), id = (await socialCallAction(pg, z.a, { action: "start", matchId: z.matchId, device: z.da, mode: "audio" })).call!.id;
    await socialCallAction(pg, z.b, { action: "accept", callId: id, matchId: z.matchId, device: z.dbb });
    await Promise.allSettled([
      socialCallAction(pg, z.a, { action: "signal", callId: id, matchId: z.matchId, device: z.da, clientId: randomUUID(), kind: "offer", payload: { type: "offer", sdp } }),
      closeMatch(pg, z.b, z.matchId),
    ]);
    assert.equal((await pg.query("select 1 from social_call_signals where call_id=$1", [id])).length, 0);
  } finally { await pg.close(); }
});
