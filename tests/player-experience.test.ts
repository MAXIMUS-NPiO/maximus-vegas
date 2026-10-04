import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { openDatabase, type Database } from "../src/server/db.ts";
import type { SessionUser } from "../src/server/auth.ts";
import { DomainError } from "../src/server/errors.ts";
import { beginSteamVerification, completeSteamVerification, connectExperience, disconnectExperience, disconnectSteamIdentity, eraseExperience, experienceAvailability, experienceExport, fetchExperienceResource, profileExperience, publicExperienceBadges, refreshExperience, setExperienceSharing, setPartnerExperienceSharing, steamAccountId, syncExperience, syncOwnExperience } from "../src/server/player-experience.ts";
import { dotaRankName } from "../src/lib/player-experience.ts";

let db: Database, seq = 0;
const env = { NODE_ENV: "test" as const, NEXT_PUBLIC_SITE_URL: "https://experience.example.test", STEAM_WEB_API_KEY: "fixture-steam-key", FACEIT_API_KEY: "fixture-faceit-key" };
const ns = "http://specs.openid.net/auth/2.0";
const reject = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof DomainError && error.code === code);
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetcher = (fn: (url: URL, init: RequestInit) => Response | Promise<Response>) => (async (url: string | URL | Request, init?: RequestInit) => fn(new URL(String(url)), init ?? {})) as typeof fetch;
async function account(database = db): Promise<SessionUser> {
  const id = randomUUID(), username = `exp${Date.now().toString(36)}${++seq}`.slice(0, 24);
  await database.query("insert into users(id,email,username,display_name,password_hash,adult_confirmed_at) values($1,$2,$3,$3,'fixture',now())", [id, `${username}@example.test`, username]);
  return { id, username, email: `${username}@example.test`, displayName: username, sessionId: randomUUID(), roles: [] };
}
function claims(authUrl: string, steamId: string, now = Date.now(), nonce = `${new Date(now).toISOString().slice(0, 19)}Z${randomUUID()}`) {
  const returnTo = new URL(authUrl).searchParams.get("openid.return_to")!;
  return new URLSearchParams({ state: new URL(returnTo).searchParams.get("state")!, "openid.ns": ns, "openid.mode": "id_res", "openid.op_endpoint": "https://steamcommunity.com/openid/login", "openid.claimed_id": `https://steamcommunity.com/openid/id/${steamId}`, "openid.identity": `https://steamcommunity.com/openid/id/${steamId}`, "openid.return_to": returnTo, "openid.response_nonce": nonce, "openid.assoc_handle": "fixture-association", "openid.signed": "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle", "openid.sig": "fixture-signature" });
}
const verifyFetch = fetcher((url, init) => {
  assert.equal(url.toString(), "https://steamcommunity.com/openid/login"); assert.equal(init.method, "POST");
  assert.equal(new URLSearchParams(String(init.body)).get("openid.mode"), "check_authentication");
  assert.equal(init.redirect, "error");
  return new Response(`ns:${ns}\nis_valid:true\n`);
});
async function identity(user: SessionUser, database = db, steamId = String(76561197960265728n + BigInt(100000 + ++seq))) {
  const start = await beginSteamVerification(database, user, { lang: "en", consent: true }, { env });
  await completeSteamVerification(database, user, claims(start.url, steamId), { env, fetch: verifyFetch });
  return steamId;
}
function dotaFetch(steamId: string, options: { private?: boolean; mismatch?: boolean; status?: number } = {}) {
  return fetcher((url, init) => {
    assert.equal(url.hostname, "api.opendota.com"); assert.equal(init.redirect, "error"); assert.equal(init.cache, "no-store"); assert.ok(init.signal);
    if (options.status) return response({}, options.status);
    if (url.pathname.endsWith("/wl")) return response({ win: 320, lose: 280 });
    if (url.pathname.endsWith("/recentMatches")) return response(Array.from({ length: 25 }, (_, i) => ({ match_id: 10000000 + i, start_time: Math.floor(Date.now() / 1000) - 3600 - i, player_slot: i % 2 === 0 ? 0 : 128, radiant_win: true, kills: 10, deaths: 4, assists: 9, duration: 2100 })));
    return response({ profile: options.private ? null : { account_id: steamAccountId(steamId), steamid: options.mismatch ? "76561197960265729" : steamId, personaname: "Experienced Dota player", profileurl: "http://127.0.0.1/admin" }, rank_tier: 64, leaderboard_rank: null });
  });
}
async function linked(user: SessionUser, provider: "steam" | "opendota" | "faceit", shared = false, database = db) {
  return connectExperience(database, user, { provider, consent: true, shared }, { env });
}
test.before(async () => { db = await openDatabase({ embedded: true, dataDir: "memory://" }); });
test.beforeEach(async () => { await db.query("delete from player_experience_budgets"); });
test.after(async () => { await db.close(); });

test("imports require explicit consent, configured access and Steam ownership; typed handles never verify ownership", async () => {
  const user = await account();
  await db.query("insert into linked_game_accounts(user_id,game,handle,verified) values($1,'dota2','76561197960265729',true)", [user.id]);
  await reject(beginSteamVerification(db, user, { lang: "en", consent: false }, { env }), "consent_required");
  await reject(connectExperience(db, user, { provider: "opendota", consent: true }, { env }), "consent_required");
  assert.equal(experienceAvailability({ NEXT_PUBLIC_SITE_URL: env.NEXT_PUBLIC_SITE_URL }).find(x => x.provider === "opendota")?.available, true);
  assert.equal(experienceAvailability({ NEXT_PUBLIC_SITE_URL: env.NEXT_PUBLIC_SITE_URL }).find(x => x.provider === "steam")?.reason, "provider_not_configured");
  assert.equal(experienceAvailability({}).every(x => !x.available), true);
  assert.equal(experienceAvailability({ ...env, MV_EXPERIENCE_DISABLED: "1" }).every(x => !x.available), true);
  assert.equal(experienceAvailability({ ...env, NEXT_PUBLIC_SITE_URL: "http://public.example", NODE_ENV: "production" }).every(x => !x.available), true);
  await identity(user);
  await reject(connectExperience(db, user, { provider: "opendota", consent: false }, { env }), "consent_required");
  await reject(connectExperience(db, user, { provider: "universal-gamer-api", consent: true }, { env }), "invalid_input");
  await reject(connectExperience(db, user, { provider: "faceit", consent: true }, { env: { NEXT_PUBLIC_SITE_URL: env.NEXT_PUBLIC_SITE_URL } }), "offer_unavailable");
  const id = await linked(user, "opendota"); assert.ok(id);
  await reject(linked(user, "opendota"), "already_registered");
  assert.equal((await profileExperience(db, user.id, user.id)).hasImportedExperience, false);
  assert.equal(steamAccountId("76561202255233023"), 4294967295);
  assert.throws(() => steamAccountId("76561202255233024"), /token_invalid/);
});

test("Steam assertions bind exact return URL, session, signed fields, provider validation, nonce and one user; callbacks cannot replay", async () => {
  const a = await account(), b = await account(), steamId = "76561198011110001", now = Date.now();
  const start = await beginSteamVerification(db, a, { lang: "en", consent: true }, { env, now });
  const assertion = claims(start.url, steamId, now);
  await reject(completeSteamVerification(db, b, assertion, { env, fetch: verifyFetch, now }), "token_invalid");
  await reject(completeSteamVerification(db, { ...a, sessionId: randomUUID() }, assertion, { env, fetch: verifyFetch, now }), "token_invalid");
  assert.deepEqual(await completeSteamVerification(db, a, assertion, { env, fetch: verifyFetch, now }), { steamId, lang: "en" });
  await reject(completeSteamVerification(db, a, assertion, { env, fetch: verifyFetch, now }), "token_invalid");
  const other = await beginSteamVerification(db, b, { lang: "en", consent: true }, { env, now });
  await reject(completeSteamVerification(db, b, claims(other.url, steamId, now), { env, fetch: verifyFetch, now }), "already_registered");
  const repeat = await beginSteamVerification(db, a, { lang: "en", consent: true }, { env, now });
  await reject(completeSteamVerification(db, a, claims(repeat.url, steamId, now, assertion.get("openid.response_nonce")!), { env, fetch: verifyFetch, now }), "already_registered");
  for (const mutation of [
    (p: URLSearchParams) => p.set("openid.return_to", "https://attacker.example/callback"),
    (p: URLSearchParams) => p.set("openid.op_endpoint", "https://attacker.example/openid"),
    (p: URLSearchParams) => p.set("openid.signed", "identity,return_to,response_nonce"),
    (p: URLSearchParams) => p.append("openid.identity", "duplicate"),
    (p: URLSearchParams) => p.set("openid.response_nonce", "2000-01-01T00:00:00Zold"),
  ]) {
    const user = await account(), request = await beginSteamVerification(db, user, { lang: "en", consent: true }, { env, now });
    const bad = claims(request.url, "76561198011110002", now); mutation(bad);
    await reject(completeSteamVerification(db, user, bad, { env, fetch: fetcher(() => { assert.fail("invalid assertion must not reach network"); }), now }), "token_invalid");
  }
  const rejected = await account(), request = await beginSteamVerification(db, rejected, { lang: "ru", consent: true }, { env, now });
  await reject(completeSteamVerification(db, rejected, claims(request.url, "76561198011110003", now), { env, now, fetch: fetcher(() => new Response(`ns:${ns}\nis_valid:false\n`)) }), "token_invalid");
  const expired = await beginSteamVerification(db, rejected, { lang: "ru", consent: true }, { env, now });
  await reject(completeSteamVerification(db, rejected, claims(expired.url, "76561198011110003", now + 11 * 60_000), { env, now: now + 11 * 60_000, fetch: verifyFetch }), "token_invalid");
  assert.equal((await profileExperience(db, rejected.id, rejected.id)).steamIdentity, null);
});

test("Steam public playtime is attributed, private game details clear saved data, and missing key blocks refresh", async () => {
  const user = await account(), steamId = await identity(user), id = await linked(user, "steam", true), now = Date.now();
  let privateProfile = false, hiddenGames = false, calls = 0;
  const source = fetcher(url => {
    calls++; assert.equal(url.hostname, "api.steampowered.com"); assert.equal(url.searchParams.get("key"), env.STEAM_WEB_API_KEY);
    if (url.pathname.includes("GetPlayerSummaries")) return response({ response: { players: [{ steamid: steamId, communityvisibilitystate: privateProfile ? 1 : 3, personaname: "Veteran" }] } });
    const query = JSON.parse(url.searchParams.get("input_json")!); assert.equal(query.steamid, steamId); assert.equal(query.include_played_free_games, true);
    return response({ response: hiddenGames ? {} : { game_count: 2, games: [{ appid: 730, playtime_forever: 120000 }, { appid: 570, playtime_forever: 60000 }] } });
  });
  await refreshExperience(db, user, id, { env, now, fetch: source }); assert.equal(calls, 2);
  const imported = await profileExperience(db, user.id);
  assert.equal(imported.hasImportedExperience, true); assert.equal(imported.connections[0].records[0].metrics.playtimeMinutes, 120000); assert.equal(imported.connections[0].records[0].rank, null);
  assert.equal(imported.steamIdentity, null, "public passport must not expose the separate identity record");
  await reject(refreshExperience(db, user, id, { env, now: now + 1000, fetch: source }), "request_limit");
  hiddenGames = true;
  await refreshExperience(db, user, id, { env, now: now + 16 * 60_000, fetch: source });
  let own = await profileExperience(db, user.id, user.id); assert.equal(own.connections[0].status, "private"); assert.equal(own.connections[0].records.length, 0); assert.equal(own.hasImportedExperience, false);
  privateProfile = true;
  await refreshExperience(db, user, id, { env, now: now + 32 * 60_000, fetch: source });
  own = await profileExperience(db, user.id, user.id); assert.equal(own.connections[0].issue, "private_profile"); assert.equal(own.connections[0].displayName, "");
  await reject(refreshExperience(db, user, id, { env: { NEXT_PUBLIC_SITE_URL: env.NEXT_PUBLIC_SITE_URL }, now: now + 48 * 60_000, fetch: source }), "offer_unavailable");
  assert.equal((await db.query("select * from xp_events where user_id=$1", [user.id])).length, 0);
});

test("OpenDota imports only the owned account, readable source rank and 20 recent matches; sharing and directory privacy hold", async () => {
  const user = await account(), other = await account(), steamId = await identity(user), id = await linked(user, "opendota"), now = Date.now();
  await refreshExperience(db, user, id, { env, now, fetch: dotaFetch(steamId) });
  let own = await profileExperience(db, user.id, user.id), source = own.connections[0];
  assert.equal(own.hasImportedExperience, true); assert.equal(source.records[0].rank, "Ancient IV"); assert.equal(dotaRankName(64, "ru"), "Властелин IV"); assert.equal(dotaRankName(80), "Immortal"); assert.equal(dotaRankName(69), null);
  assert.equal(source.records[0].metrics.matches, 600); assert.equal(source.records[0].recentMatches.length, 20); assert.equal(source.records[0].recentMatches[0].result, "win"); assert.equal(source.records[0].recentMatches[1].result, "loss");
  assert.equal(source.records[0].sourceUrl, `https://www.opendota.com/players/${steamAccountId(steamId)}`);
  assert.equal((await profileExperience(db, user.id, other.id)).connections.length, 0); assert.equal((await publicExperienceBadges(db, [user.username])).size, 0);
  await reject(setExperienceSharing(db, other, id, true), "not_found");
  await setExperienceSharing(db, user, id, true);
  assert.deepEqual((await publicExperienceBadges(db, [user.username, "' or 1=1"])).get(user.username), ["OpenDota"]);
  assert.equal((await profileExperience(db, user.id)).hasImportedExperience, true);
  await db.query("update users set profile_public=false where id=$1", [user.id]);
  assert.equal((await profileExperience(db, user.id)).connections.length, 0); assert.equal((await publicExperienceBadges(db, [user.username])).size, 0);
  assert.equal((await profileExperience(db, user.id, user.id)).connections.length, 1);
  await db.query("update users set profile_public=true where id=$1", [user.id]);
  await refreshExperience(db, user, id, { env, now: now + 16 * 60_000, fetch: dotaFetch(steamId, { mismatch: true }) });
  own = await profileExperience(db, user.id, user.id); source = own.connections[0];
  assert.equal(source.issue, "identity_mismatch"); assert.equal(source.records.length, 0); assert.equal(source.verifiedAt, null); assert.equal((await publicExperienceBadges(db, [user.username])).size, 0);
  assert.equal((await db.query("select * from xp_events where user_id=$1", [user.id])).length, 0);
});

test("FACEIT binds both Steam fields, preserves game-specific Elo and imports prefixed match IDs", async () => {
  const user = await account(), steamId = await identity(user), id = await linked(user, "faceit", true), now = Date.now(), playerId = randomUUID(), matchId = `1-${randomUUID()}`;
  let mismatched = false, calls = 0;
  const source = fetcher((url, init) => {
    calls++; assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${env.FACEIT_API_KEY}`);
    if (url.pathname.endsWith("/stats/cs2")) return response({ lifetime: { Matches: "540", Wins: "295", "untrusted arbitrary field": "text" } });
    if (url.pathname.endsWith("/history")) return response({ items: [{ match_id: matchId, game_id: "cs2", finished_at: Math.floor(now / 1000) - 100, teams: { faction1: { players: [{ player_id: playerId, game_player_id: steamId }] }, faction2: { players: [] } }, results: { winner: "faction1" } }, { match_id: "../bad", game_id: "cs2", finished_at: Math.floor(now / 1000) - 100 }] });
    assert.equal(url.searchParams.get("game_player_id"), steamId); assert.equal(url.searchParams.get("game"), "cs2");
    return response({ player_id: playerId, steam_id_64: steamId, nickname: "Fixture-player", games: { cs2: { game_player_id: mismatched ? "wrong" : steamId, skill_level: 10, faceit_elo: 2450 } }, faceit_url: "https://evil.example" });
  });
  await refreshExperience(db, user, id, { env, now, fetch: source }); assert.equal(calls, 3);
  let view = (await profileExperience(db, user.id)).connections[0]; assert.equal(view.records[0].rank, "FACEIT level 10"); assert.equal(view.records[0].metrics.faceitElo, 2450); assert.equal(view.records[0].recentMatches[0].id, matchId); assert.equal(view.records[0].recentMatches[0].result, "win"); assert.equal(view.records[0].recentMatches.length, 1);
  mismatched = true;
  await refreshExperience(db, user, id, { env, now: now + 16 * 60_000, fetch: source });
  view = (await profileExperience(db, user.id, user.id)).connections[0]; assert.equal(view.issue, "identity_mismatch"); assert.equal(view.records.length, 0); assert.equal(calls, 4, "identity mismatch prevents all later calls");
});

test("transient and rate errors retain dated stale evidence; unavailable profiles do not turn a player into a novice", async () => {
  const user = await account(), steamId = await identity(user), id = await linked(user, "opendota", true), now = Date.now();
  await refreshExperience(db, user, id, { env, now, fetch: dotaFetch(steamId) });
  const before = (await profileExperience(db, user.id)).connections[0];
  await refreshExperience(db, user, id, { env, now: now + 16 * 60_000, fetch: dotaFetch(steamId, { status: 503 }) });
  let state = (await profileExperience(db, user.id)).connections[0]; assert.equal(state.status, "stale"); assert.deepEqual(state.records, before.records); assert.equal(state.lastSuccessAt, before.lastSuccessAt);
  await refreshExperience(db, user, id, { env, now: now + 32 * 60_000, fetch: dotaFetch(steamId, { status: 429 }) });
  state = (await profileExperience(db, user.id)).connections[0]; assert.equal(state.issue, "rate_limited"); assert.equal(state.status, "stale");
  await refreshExperience(db, user, id, { env, now: now + 48 * 60_000, fetch: dotaFetch(steamId, { private: true }) });
  state = (await profileExperience(db, user.id, user.id)).connections[0]; assert.equal(state.status, "unavailable"); assert.equal(state.records.length, 0); assert.equal(state.verifiedAt, null);
  assert.equal((await profileExperience(db, user.id)).connections.length, 0);
  await refreshExperience(db, user, id, { env, now: now + 64 * 60_000, fetch: dotaFetch(steamId) });
  await db.query("update player_experience_connections set last_success_at=now()-interval '4 days' where id=$1", [id]);
  assert.equal((await profileExperience(db, user.id)).connections[0].status, "stale");
});

test("SSRF allowlist, redirect policy, size caps and deadlines fail closed without exposing provider credentials", async () => {
  let calls = 0; const never = fetcher(() => { calls++; return response({}); });
  for (const url of ["http://api.opendota.com/api/players/1", "https://api.opendota.com.evil.example/api/players/1", "https://127.0.0.1/api/players/1", "https://user:pass@api.opendota.com/api/players/1", "https://api.opendota.com/api/players/1/../../admin", "https://open.faceit.com/data/v4/players/../keys"]) await assert.rejects(fetchExperienceResource(new URL(url), {}, { fetch: never }), /endpoint_rejected/);
  assert.equal(calls, 0);
  const url = new URL("https://api.opendota.com/api/players/1");
  await assert.rejects(fetchExperienceResource(url, {}, { fetch: never, deadline: Date.now() - 1 }), /timeout/); assert.equal(calls, 0);
  await assert.rejects(fetchExperienceResource(url, {}, { fetch: fetcher((_url, init) => { assert.equal(init.redirect, "error"); return new Response("", { status: 302, headers: { location: "http://127.0.0.1" } }); }) }), /provider_unavailable/);
  await assert.rejects(fetchExperienceResource(url, {}, { fetch: fetcher(() => new Response("x".repeat(500001))) }), /response_too_large/);
  await assert.rejects(fetchExperienceResource(url, {}, { fetch: fetcher(() => new Response("{}", { headers: { "Content-Length": "999999" } })) }), /response_too_large/);
  await assert.rejects(fetchExperienceResource(url, {}, { fetch: fetcher(() => { throw new Error("credential https://service/?key=do-not-leak"); }) }), error => error instanceof Error && error.message === "provider_unavailable");
});

test("durable source-wide minute/day/month budgets and cron batch limit bound requests, including failures", async () => {
  const user = await account(), steamId = await identity(user), id = await linked(user, "opendota"), now = Date.now();
  for (const [window, length, limit, offset] of [["minute", 16, 20, 0], ["day", 10, 900, 16], ["month", 7, 15000, 32]] as const) {
    const bucket = `${window}:${new Date(now + offset * 60_000).toISOString().slice(0, length)}`;
    await db.query("delete from player_experience_budgets where provider='opendota'");
    await db.query("insert into player_experience_budgets(provider,bucket,requests,expires_at) values('opendota',$1,$2,$3)", [bucket, limit, new Date(now + 86400_000)]);
    let calls = 0;
    const result = await refreshExperience(db, user, id, { env, now: now + offset * 60_000, fetch: fetcher(() => { calls++; return response({}); }) });
    assert.equal(result.status, "error"); assert.equal(calls, 0); assert.equal((await profileExperience(db, user.id, user.id)).connections[0].issue, "rate_limited");
  }
  await db.query("delete from player_experience_budgets");
  const future = now + 40 * 86400_000;
  const result = await syncExperience(db, 999, { env, now: future, fetch: dotaFetch(steamId, { status: 503 }) });
  assert.ok(result.dueSelected <= 5); assert.ok(result.processed <= 5);
  const budgets = await db.query<{ requests: number }>("select requests from player_experience_budgets where provider='opendota' and bucket like 'minute:%'"); assert.ok(budgets.every(b => b.requests <= 20));
});

test("disconnect and erasure stop future sync; exports omit states, nonces, leases and keys; private sharing stays scoped", async () => {
  const user = await account(), other = await account(), steamId = await identity(user), id = await linked(user, "opendota", true);
  await refreshExperience(db, user, id, { env, fetch: dotaFetch(steamId) });
  const exported = JSON.stringify(await experienceExport(db, user.id));
  assert.ok(exported.includes(steamId)); assert.ok(exported.includes("Ancient IV"));
  for (const secret of ["state_hash", "session_hash", "nonce_hash", "lease_token", env.STEAM_WEB_API_KEY, env.FACEIT_API_KEY]) assert.equal(exported.includes(secret), false);
  await disconnectExperience(db, other, id); assert.equal((await profileExperience(db, user.id, user.id)).connections.length, 1);
  await setPartnerExperienceSharing(db, user, true);
  await disconnectExperience(db, user, id); await reject(refreshExperience(db, user, id, { env }), "not_found");
  const source = await linked(user, "opendota"); assert.ok(source);
  await disconnectSteamIdentity(db, user);
  let view = await profileExperience(db, user.id, user.id); assert.equal(view.steamIdentity, null); assert.equal(view.connections.length, 0); assert.equal(view.sharePartner, false);
  for (const table of ["states", "nonces", "identities", "connections", "settings"]) assert.equal((await db.query(`select 1 from player_experience_${table} where user_id=$1`, [user.id])).length, 0);
  await identity(user); await linked(user, "opendota"); await db.tx(q => eraseExperience(q, user.id)); view = await profileExperience(db, user.id, user.id); assert.equal(view.connections.length, 0);
});

test("in-flight import cannot recreate disconnected data, and only one competing refresh obtains a lease", async () => {
  const user = await account(), steamId = await identity(user), id = await linked(user, "opendota");
  let started!: () => void, release!: () => void;
  const waitStarted = new Promise<void>(resolve => { started = resolve; }), waitRelease = new Promise<void>(resolve => { release = resolve; });
  const base = dotaFetch(steamId);
  const source = fetcher(async (url, init) => { started(); await waitRelease; return base(url, init); });
  const first = refreshExperience(db, user, id, { env, fetch: source }); await waitStarted;
  await reject(refreshExperience(db, user, id, { env, fetch: source }), "request_limit");
  await disconnectExperience(db, user, id); release(); assert.equal((await first).status, "disconnected");
  assert.equal((await profileExperience(db, user.id, user.id)).connections.length, 0);
  const newId = await linked(user, "opendota");
  const sync = await syncOwnExperience(db, user, { env, fetch: dotaFetch(steamId) }); assert.equal(sync.processed, 1);
  assert.equal((await syncOwnExperience(db, user, { env, fetch: dotaFetch(steamId) })).processed, 0);
  assert.ok((await profileExperience(db, user.id, user.id)).connections.some(c => c.id === newId && c.status === "available"));
});

test("withdrawing Steam consent during provider verification prevents a late callback from relinking", async () => {
  const user = await account(), auth = await beginSteamVerification(db, user, { lang: "en", consent: true }, { env });
  let started!: () => void, release!: () => void;
  const waiting = new Promise<void>(r => { started = r; }), pending = new Promise<void>(r => { release = r; });
  const result = completeSteamVerification(db, user, claims(auth.url, "76561198022220001"), { env, fetch: fetcher(async (url, init) => { started(); await pending; return verifyFetch(url, init); }) });
  await waiting; await disconnectSteamIdentity(db, user); release(); await reject(result, "token_invalid");
  assert.equal((await profileExperience(db, user.id, user.id)).steamIdentity, null);
});

test("partner history only exposes approved, verified and organiser-confirmed records with separate sharing consent", async () => {
  const user = await account(), orgId = randomUUID(), sourceId = randomUUID(), observationId = randomUUID();
  await db.query("insert into organizations(id,slug,name,created_by) values($1,$2,'Fixture source org',$3)", [orgId, `exp-${randomUUID()}`, user.id]);
  await db.query("insert into stats_sources(id,org_id,name,games,public_key,evidence_url,status,created_by) values($1,$2,'Fixture signed source',array['cs2'],'fixture','https://source.example/evidence','approved',$3)", [sourceId, orgId, user.id]);
  await db.query("insert into stats_links(source_id,user_id,game,handle,status,challenge_hash,challenge_sealed,expires_at,verified_at) values($1,$2,'cs2','fixture','verified','','',now(),now())", [sourceId, user.id]);
  await db.query("insert into stats_observations(id,source_id,user_id,game,match_ref,played_at,metrics,digest,signed_body,signature,public_key,status) values($1,$2,$3,'cs2','reviewed-fixture',now(),'{\"kills\":25}','fixture','fixture','fixture','fixture','confirmed')", [observationId, sourceId, user.id]);
  assert.equal((await profileExperience(db, user.id, user.id)).partnerRecords.length, 1);
  assert.equal((await profileExperience(db, user.id)).partnerRecords.length, 0);
  await setPartnerExperienceSharing(db, user, true);
  assert.equal((await profileExperience(db, user.id)).partnerRecords.length, 1);
  for (const [sql, reset] of [
    ["update stats_sources set status='suspended' where id=$1", "update stats_sources set status='approved' where id=$1"],
    ["update stats_links set status='revoked' where source_id=$1", "update stats_links set status='verified' where source_id=$1"],
    ["update stats_observations set status='pending' where source_id=$1", "update stats_observations set status='confirmed' where source_id=$1"],
  ]) { await db.query(sql, [sourceId]); assert.equal((await profileExperience(db, user.id)).partnerRecords.length, 0); await db.query(reset, [sourceId]); }
  await setPartnerExperienceSharing(db, user, false); assert.equal((await profileExperience(db, user.id)).hasImportedExperience, false);
});

test("real PostgreSQL serializes competing ownership bindings and source refresh leases", { skip: !process.env.PG_TEST_URL }, async () => {
  const pg = await openDatabase({ url: process.env.PG_TEST_URL });
  try {
    const a = await account(pg), b = await account(pg), steamId = String(76561197960265728n + BigInt(2_000_000_000 + Math.floor(Math.random() * 1_000_000_000)));
    const [sa, sb] = await Promise.all([beginSteamVerification(pg, a, { lang: "en", consent: true }, { env }), beginSteamVerification(pg, b, { lang: "en", consent: true }, { env })]);
    const outcomes = await Promise.allSettled([completeSteamVerification(pg, a, claims(sa.url, steamId), { env, fetch: verifyFetch }), completeSteamVerification(pg, b, claims(sb.url, steamId), { env, fetch: verifyFetch })]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    const owner = outcomes[0].status === "fulfilled" ? a : b, id = await linked(owner, "opendota", false, pg);
    let started!: () => void, release!: () => void; const waiting = new Promise<void>(r => { started = r; }), pending = new Promise<void>(r => { release = r; });
    const base = dotaFetch(steamId), first = refreshExperience(pg, owner, id, { env, fetch: fetcher(async (url, init) => { started(); await pending; return base(url, init); }) });
    await waiting; await reject(refreshExperience(pg, owner, id, { env, fetch: base }), "request_limit"); await disconnectExperience(pg, owner, id); release(); assert.equal((await first).status, "disconnected");
    assert.equal((await profileExperience(pg, owner.id, owner.id)).connections.length, 0);
    await pg.tx(async q => { await eraseExperience(q, a.id); await eraseExperience(q, b.id); });
  } finally { await pg.close(); }
});
