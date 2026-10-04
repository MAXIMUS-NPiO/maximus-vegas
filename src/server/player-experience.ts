import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { activeAccount } from "./product-access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { audit } from "./audit.ts";
import { siteOrigin } from "../lib/site.ts";
import { EXPERIENCE_PROVIDERS, EXPERIENCE_STALE_MS, dotaRankName, hasExperience, isExperienceProvider, type ExperienceAvailability, type ExperienceConnection, type ExperienceMatch, type ExperienceProvider, type ExperienceRecord, type ProfileExperience } from "../lib/player-experience.ts";

const CONSENT_VERSION = "player-experience-2026-10-04";
const STEAM_OPENID = "https://steamcommunity.com/openid/login";
const OPENID_NS = "http://specs.openid.net/auth/2.0";
const STEAM_BASE = 76561197960265728n;
const MANUAL_COOLDOWN = 15 * 60_000;
const SYNC_INTERVAL = 24 * 60 * 60_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const iso = (value: Date | string | null) => value ? new Date(value).toISOString() : null;
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
type Runtime = { fetch?: typeof fetch; now?: number; deadline?: number; env?: Partial<NodeJS.ProcessEnv> };
type ConnectionRow = {
  id: string; user_id: string; provider: ExperienceProvider; external_id: string | null; display_name: string;
  status: "pending" | "available" | "private" | "unavailable" | "error"; issue: string; shared: boolean;
  verified_at: Date | null; last_attempt_at: Date | null; last_success_at: Date | null; next_sync_at: Date;
  lease_token: string | null; lease_until: Date | null; failures: number; records: ExperienceRecord[];
};
type ImportResult = { status: "available" | "private" | "unavailable"; issue: string; externalId: string | null; displayName: string; records: ExperienceRecord[] };
class SourceError extends Error {
  issue: string;
  constructor(issue: string) { super(issue); this.issue = issue; }
}
const sourceError = (issue: string): never => { throw new SourceError(issue); };
function configuredOrigin(env: Partial<NodeJS.ProcessEnv> = process.env) {
  const raw = env === process.env ? siteOrigin() : env.NEXT_PUBLIC_SITE_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.username || u.password || (u.protocol !== "https:" && !(u.protocol === "http:" && env.NODE_ENV !== "production" && ["127.0.0.1", "localhost"].includes(u.hostname)))) return null;
    return u.origin;
  } catch { return null; }
}
export function experienceAvailability(env: Partial<NodeJS.ProcessEnv> = process.env): ExperienceAvailability[] {
  return EXPERIENCE_PROVIDERS.map(provider => ({ provider, available: Boolean(configuredOrigin(env)) && env.MV_EXPERIENCE_DISABLED !== "1" && (provider === "opendota" || Boolean(env[provider === "steam" ? "STEAM_WEB_API_KEY" : "FACEIT_API_KEY"]?.trim())),
    reason: env.MV_EXPERIENCE_DISABLED === "1" ? "disabled" : !configuredOrigin(env) ? "site_not_configured" : provider !== "opendota" && !env[provider === "steam" ? "STEAM_WEB_API_KEY" : "FACEIT_API_KEY"]?.trim() ? "provider_not_configured" : "ready" }));
}
function requireProvider(provider: unknown, runtime: Runtime = {}): ExperienceProvider {
  if (!isExperienceProvider(provider)) return fail("invalid_input");
  if (!experienceAvailability(runtime.env).find(p => p.provider === provider)?.available) fail("offer_unavailable");
  return provider;
}
export function steamAccountId(steamId: string) {
  if (!/^\d{17}$/.test(steamId)) return fail("token_invalid");
  const id = BigInt(steamId) - STEAM_BASE;
  if (id < 1n || id > 4294967295n) return fail("token_invalid");
  return Number(id);
}

/** Fixed hosts and endpoint shapes; no URL supplied by a player is fetched. */
export async function fetchExperienceResource(url: URL, init: RequestInit = {}, runtime: Runtime = {}, textResponse = false): Promise<unknown> {
  const allowed = url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash && (
    (url.hostname === "steamcommunity.com" && url.pathname === "/openid/login") ||
    (url.hostname === "api.steampowered.com" && ["/ISteamUser/GetPlayerSummaries/v0002/", "/IPlayerService/GetOwnedGames/v0001/"].includes(url.pathname)) ||
    (url.hostname === "api.opendota.com" && /^\/api\/players\/\d{1,10}(?:\/wl|\/recentMatches)?$/.test(url.pathname)) ||
    (url.hostname === "open.faceit.com" && /^\/data\/v4\/players(?:\/[0-9a-f-]{36}(?:\/stats\/cs2|\/history)?)?$/.test(url.pathname))
  );
  if (!allowed) return sourceError("endpoint_rejected");
  const timeout = Math.min(5000, (runtime.deadline ?? Infinity) - Date.now());
  if (timeout <= 0) return sourceError("timeout");
  try {
    const response = await (runtime.fetch ?? fetch)(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeout), headers: { Accept: textResponse ? "text/plain" : "application/json", ...init.headers } });
    if (response.status === 429) return sourceError("rate_limited");
    if (response.status === 401 || response.status === 403) return sourceError("access_denied");
    if (response.status === 404) return sourceError("not_found");
    if (!response.ok) return sourceError("provider_unavailable");
    const max = textResponse ? 4096 : 500_000;
    if (Number(response.headers.get("content-length") ?? "0") > max) return sourceError("response_too_large");
    const reader = response.body?.getReader();
    if (!reader) return sourceError("invalid_response");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); return sourceError("response_too_large"); }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    if (textResponse) return body;
    try { return JSON.parse(body); } catch { return sourceError("invalid_response"); }
  } catch (error) {
    if (error instanceof SourceError) throw error;
    // Never expose request URLs, key-bearing headers or upstream bodies to logs or clients.
    return sourceError("provider_unavailable");
  }
}

/** Shared, durable budgets include failed attempts and every HTTP request. */
async function spendBudget(db: Database, provider: string, now: number) {
  const date = new Date(now).toISOString();
  const windows = [{ bucket: `minute:${date.slice(0, 16)}`, limit: 20, ttl: 120_000 }, { bucket: `day:${date.slice(0, 10)}`, limit: 900, ttl: 2 * 86400_000 }, { bucket: `month:${date.slice(0, 7)}`, limit: 15000, ttl: 32 * 86400_000 }];
  const ok = await db.tx(async q => {
    await q.query("select pg_advisory_xact_lock(7471301)");
    for (const window of windows) {
      const [old] = await q.query<{ requests: number }>("select requests from player_experience_budgets where provider=$1 and bucket=$2", [provider, window.bucket]);
      if ((old?.requests ?? 0) >= window.limit) return false;
    }
    for (const window of windows) await q.query("insert into player_experience_budgets(provider,bucket,requests,expires_at) values($1,$2,1,$3) on conflict(provider,bucket) do update set requests=player_experience_budgets.requests+1", [provider, window.bucket, new Date(now + window.ttl)]);
    return true;
  });
  if (!ok) sourceError("rate_limited");
}

export async function beginSteamVerification(db: Database, user: SessionUser, input: { lang: "ru" | "en"; consent: boolean }, runtime: Runtime = {}) {
  if (!input.consent) fail("consent_required");
  const origin = configuredOrigin(runtime.env), now = runtime.now ?? Date.now();
  if (!origin || (runtime.env ?? process.env).MV_EXPERIENCE_DISABLED === "1") return fail("offer_unavailable");
  const state = randomBytes(32).toString("base64url"), returnTo = `${origin}/api/experience/steam/callback?state=${state}&lang=${input.lang}`;
  await db.tx(async q => {
    await activeAccount(q, user);
    await q.query("select id from users where id=$1 for update", [user.id]);
    const [count] = await q.query<{ n: number }>("select count(*)::int n from player_experience_states where user_id=$1 and created_at>$2", [user.id, new Date(now - 15 * 60_000)]);
    if (count.n >= 5) fail("request_limit");
    await q.query("update player_experience_states set used_at=$2 where user_id=$1 and used_at is null", [user.id, new Date(now)]);
    await q.query("insert into player_experience_states(state_hash,user_id,session_hash,return_to,lang,created_at,expires_at) values($1,$2,$3,$4,$5,$6,$7)", [hash(state), user.id, hash(user.sessionId), returnTo, input.lang, new Date(now), new Date(now + 10 * 60_000)]);
  });
  const url = new URL(STEAM_OPENID);
  Object.entries({ "openid.ns": OPENID_NS, "openid.mode": "checkid_setup", "openid.return_to": returnTo, "openid.realm": origin, "openid.identity": "http://specs.openid.net/auth/2.0/identifier_select", "openid.claimed_id": "http://specs.openid.net/auth/2.0/identifier_select" }).forEach(([k, value]) => url.searchParams.set(k, value));
  return { url: url.toString() };
}

export async function completeSteamVerification(db: Database, user: SessionUser, params: URLSearchParams, runtime: Runtime = {}) {
  const now = runtime.now ?? Date.now(), state = params.get("state") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || params.toString().length > 10000) return fail("token_invalid");
  for (const key of new Set(params.keys())) if (params.getAll(key).length !== 1) fail("token_invalid");
  const stateRow = await db.tx(async q => {
    await activeAccount(q, user);
    const [row] = await q.query<{ return_to: string; lang: "ru" | "en" }>(`update player_experience_states set used_at=$4 where state_hash=$1 and user_id=$2 and session_hash=$3 and used_at is null and expires_at>$4 returning return_to,lang`, [hash(state), user.id, hash(user.sessionId), new Date(now)]);
    if (!row) return fail("token_invalid"); return row;
  });
  const requiredSigned = ["op_endpoint", "claimed_id", "identity", "return_to", "response_nonce", "assoc_handle"];
  const signed = (params.get("openid.signed") ?? "").split(",");
  const claimed = params.get("openid.claimed_id") ?? "", steamId = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(claimed)?.[1];
  const nonce = params.get("openid.response_nonce") ?? "", nonceTime = Date.parse(nonce.slice(0, 20));
  if (params.get("openid.ns") !== OPENID_NS || params.get("openid.mode") !== "id_res" || ![STEAM_OPENID, "https://steamcommunity.com/openid/"].includes(params.get("openid.op_endpoint") ?? "") || params.get("openid.return_to") !== stateRow.return_to || claimed !== params.get("openid.identity") || !steamId || requiredSigned.some(key => !signed.includes(key)) || !params.get("openid.sig") || !params.get("openid.assoc_handle") || nonce.length < 21 || nonce.length > 255 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/.test(nonce) || !Number.isFinite(nonceTime) || Math.abs(now - nonceTime) > 5 * 60_000) return fail("token_invalid");
  steamAccountId(steamId);
  await spendBudget(db, "steam-openid", now);
  const validation = new URLSearchParams();
  for (const [key, value] of params) if (key.startsWith("openid.")) validation.set(key, value);
  validation.set("openid.mode", "check_authentication");
  let body: string;
  try { body = await fetchExperienceResource(new URL(STEAM_OPENID), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: validation.toString() }, runtime, true) as string; }
  catch { return fail("provider_error"); }
  const fields = new Map(body.split(/\r?\n/).filter(Boolean).map(line => { const i = line.indexOf(":"); return [line.slice(0, i), line.slice(i + 1)] as const; }));
  if (fields.get("is_valid") !== "true" || fields.get("ns") !== OPENID_NS) return fail("token_invalid");
  try {
    await db.tx(async q => {
      await activeAccount(q, user);
      await q.query("select id from users where id=$1 for update", [user.id]);
      const [stillConsented] = await q.query("select state_hash from player_experience_states where state_hash=$1 and user_id=$2 and expires_at>$3", [hash(state), user.id, new Date(runtime.now ?? Date.now())]);
      if (!stillConsented) fail("token_invalid");
      const [old] = await q.query<{ steam_id: string }>("select steam_id from player_experience_identities where user_id=$1 for update", [user.id]);
      if (old && old.steam_id !== steamId) fail("already_registered");
      await q.query("insert into player_experience_nonces(nonce_hash,user_id,expires_at) values($1,$2,$3)", [hash(nonce), user.id, new Date(now + 86400_000)]);
      await q.query("insert into player_experience_identities(user_id,steam_id,verified_at,consent_version,consented_at) values($1,$2,$3,$4,$3) on conflict(user_id) do update set verified_at=excluded.verified_at", [user.id, steamId, new Date(now), CONSENT_VERSION]);
      await audit(q, { actorId: user.id, action: "experience.identity_verified", entity: "user", entityId: user.id });
    });
  } catch (error) { if (isUniqueViolation(error)) return fail("already_registered"); throw error; }
  return { lang: stateRow.lang, steamId };
}

export async function connectExperience(db: Database, user: SessionUser, input: { provider: unknown; consent: boolean; shared?: boolean }, runtime: Runtime = {}) {
  if (!input.consent) fail("consent_required");
  const provider = requireProvider(input.provider, runtime);
  return db.tx(async q => {
    await activeAccount(q, user);
    const [identity] = await q.query("select user_id from player_experience_identities where user_id=$1 for update", [user.id]);
    if (!identity) return fail("consent_required");
    const [old] = await q.query("select id from player_experience_connections where user_id=$1 and provider=$2", [user.id, provider]);
    if (old) return fail("already_registered");
    const [row] = await q.query<{ id: string }>("insert into player_experience_connections(user_id,provider,consent_version,shared) values($1,$2,$3,$4) returning id", [user.id, provider, CONSENT_VERSION, input.shared === true]);
    await audit(q, { actorId: user.id, action: "experience.source_connected", entity: "experience_connection", entityId: row.id, data: { provider, shared: input.shared === true } });
    return row.id;
  });
}

function obj(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : sourceError("invalid_response"); }
function integer(value: unknown, max = 1e9): number | null { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null; }
const label = (value: unknown) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100) : "";
const unavailable = (issue: string, externalId: string | null = null): ImportResult => ({ status: "unavailable", issue, externalId, displayName: "", records: [] });
function matchTime(value: unknown, now: number) { const n = integer(value, 1e11); return n !== null && n > 946684800 && n * 1000 <= now + 300_000 ? new Date(n * 1000).toISOString() : null; }
async function importSource(db: Database, connection: ConnectionRow, steamId: string, runtime: Runtime): Promise<ImportResult> {
  const now = runtime.now ?? Date.now(), env = runtime.env ?? process.env, provider = connection.provider;
  const get = async (url: URL) => { await spendBudget(db, provider, now); return fetchExperienceResource(url, provider === "faceit" ? { headers: { Authorization: `Bearer ${env.FACEIT_API_KEY!.trim()}` } } : {}, runtime); };
  if (provider === "steam") {
    const summaryUrl = new URL("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/"); summaryUrl.search = new URLSearchParams({ key: env.STEAM_WEB_API_KEY!.trim(), steamids: steamId }).toString();
    const players = obj(obj(await get(summaryUrl)).response).players;
    if (!Array.isArray(players) || players.length !== 1) return unavailable("profile_unavailable");
    const player = obj(players[0]); if (player.steamid !== steamId) return sourceError("identity_mismatch");
    if (player.communityvisibilitystate !== 3) return { status: "private", issue: "private_profile", externalId: steamId, displayName: "", records: [] };
    const apps: Record<number, string> = { 10: "cs16", 240: "css", 440: "tf2", 570: "dota2", 730: "cs2", 578080: "pubg", 1172470: "apex", 252950: "rocket-league", 1422450: "deadlock" };
    const gamesUrl = new URL("https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/");
    gamesUrl.search = new URLSearchParams({ key: env.STEAM_WEB_API_KEY!.trim(), input_json: JSON.stringify({ steamid: steamId, include_appinfo: true, include_played_free_games: true, appids_filter: Object.keys(apps).map(Number) }) }).toString();
    const response = obj(obj(await get(gamesUrl)).response);
    if (response.game_count === undefined) return { status: "private", issue: "game_details_hidden", externalId: steamId, displayName: label(player.personaname), records: [] };
    if (integer(response.game_count) === null || (response.games !== undefined && !Array.isArray(response.games))) return sourceError("invalid_response");
    const records: ExperienceRecord[] = [];
    for (const raw of (response.games as unknown[] | undefined) ?? []) {
      const game = obj(raw), appid = integer(game.appid), minutes = integer(game.playtime_forever);
      if (appid === null || !apps[appid]) continue;
      if (minutes === null) return sourceError("invalid_response");
      records.push({ game: apps[appid], sourceUrl: `https://steamcommunity.com/profiles/${steamId}/games/?tab=all`, rank: null, metrics: { playtimeMinutes: minutes }, recentMatches: [] });
    }
    return { status: "available", issue: records.length ? "" : "no_supported_games", externalId: steamId, displayName: label(player.personaname), records };
  }
  if (provider === "opendota") {
    const accountId = steamAccountId(steamId), base = `https://api.opendota.com/api/players/${accountId}`;
    const details = obj(await get(new URL(base)));
    if (!details.profile) return unavailable("profile_unavailable", String(accountId));
    const profile = obj(details.profile);
    if (profile.steamid !== steamId || profile.account_id !== accountId) return sourceError("identity_mismatch");
    const wl = obj(await get(new URL(`${base}/wl`))), recent = await get(new URL(`${base}/recentMatches`));
    const wins = integer(wl.win), losses = integer(wl.lose);
    if (wins === null || losses === null || !Array.isArray(recent)) return sourceError("invalid_response");
    const matches: ExperienceMatch[] = [];
    for (const raw of recent.slice(0, 20)) {
      const m = obj(raw), id = integer(m.match_id, Number.MAX_SAFE_INTEGER), playedAt = matchTime(m.start_time, now), slot = integer(m.player_slot, 255);
      if (!id || !playedAt || slot === null) continue;
      const metrics: Record<string, number> = {};
      for (const key of ["kills", "deaths", "assists", "duration"]) { const n = integer(m[key]); if (n !== null) metrics[key === "duration" ? "durationSeconds" : key] = n; }
      matches.push({ id: String(id), playedAt, sourceUrl: `https://www.opendota.com/matches/${id}`, metrics, ...(typeof m.radiant_win === "boolean" ? { result: (m.radiant_win === (slot < 128) ? "win" : "loss") as "win" | "loss" } : {}) });
    }
    const rank = integer(details.rank_tier, 99), leaderboard = integer(details.leaderboard_rank);
    return { status: "available", issue: "", externalId: String(accountId), displayName: label(profile.personaname), records: [{ game: "dota2", sourceUrl: `https://www.opendota.com/players/${accountId}`, rank: dotaRankName(rank), ...(rank && dotaRankName(rank) ? { rankCode: rank } : {}), metrics: { matches: wins + losses, wins, losses, ...(leaderboard ? { leaderboardRank: leaderboard } : {}) }, recentMatches: matches }] };
  }
  const lookup = new URL("https://open.faceit.com/data/v4/players"); lookup.search = new URLSearchParams({ game: "cs2", game_player_id: steamId }).toString();
  const player = obj(await get(lookup)), game = obj(obj(player.games).cs2);
  if (player.steam_id_64 !== steamId || game.game_player_id !== steamId || typeof player.player_id !== "string" || !uuid(player.player_id)) return sourceError("identity_mismatch");
  if (connection.external_id && connection.external_id !== player.player_id) return sourceError("identity_mismatch");
  const id = player.player_id, nickname = label(player.nickname), level = integer(game.skill_level, 10), elo = integer(game.faceit_elo, 100000);
  const statistics = obj(await get(new URL(`https://open.faceit.com/data/v4/players/${id}/stats/cs2`))), lifetime = obj(statistics.lifetime);
  const historyUrl = new URL(`https://open.faceit.com/data/v4/players/${id}/history`); historyUrl.search = "game=cs2&offset=0&limit=20";
  const history = obj(await get(historyUrl)); if (!Array.isArray(history.items)) return sourceError("invalid_response");
  const metrics: Record<string, number> = {}; if (elo !== null) metrics.faceitElo = elo;
  for (const [key, output] of [["Matches", "matches"], ["Wins", "wins"]]) { const value = lifetime[key], n = typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : integer(value); if (n !== null) metrics[output] = n; }
  const matches: ExperienceMatch[] = [];
  for (const raw of history.items.slice(0, 20)) {
    const m = obj(raw), playedAt = matchTime(m.finished_at, now);
    if (m.game_id !== "cs2" || typeof m.match_id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(m.match_id) || !playedAt) continue;
    const teams = obj(m.teams); let ownTeam: string | null = null;
    for (const [teamId, value] of Object.entries(teams)) { const team = obj(value); if (Array.isArray(team.players) && team.players.some(p => obj(p).player_id === id && obj(p).game_player_id === steamId)) ownTeam = teamId; }
    if (!ownTeam) continue;
    const winner = m.results ? obj(m.results).winner : null;
    matches.push({ id: m.match_id, playedAt, sourceUrl: `https://www.faceit.com/en/cs2/room/${m.match_id}`, metrics: {}, ...(typeof winner === "string" && winner ? { result: (winner === ownTeam ? "win" : "loss") as "win" | "loss" } : {}) });
  }
  return { status: "available", issue: "", externalId: id, displayName: nickname, records: [{ game: "cs2", sourceUrl: `https://www.faceit.com/en/players/${encodeURIComponent(nickname)}`, rank: level ? `FACEIT level ${level}` : null, metrics, recentMatches: matches }] };
}

export async function refreshExperience(db: Database, user: SessionUser, connectionId: string, runtime: Runtime = {}, scheduled = false) {
  if (!uuid(connectionId)) return fail("invalid_input");
  const now = runtime.now ?? Date.now(), lease = randomUUID();
  const claim = await db.tx(async q => {
    await activeAccount(q, user);
    const [connection] = await q.query<ConnectionRow>("select * from player_experience_connections where id=$1 and user_id=$2 for update", [connectionId, user.id]);
    if (!connection) return fail("not_found");
    requireProvider(connection.provider, runtime);
    if ((connection.lease_until && new Date(connection.lease_until).getTime() > now) || (connection.last_attempt_at && now - new Date(connection.last_attempt_at).getTime() < MANUAL_COOLDOWN) || (scheduled && new Date(connection.next_sync_at).getTime() > now)) return fail("request_limit");
    const [identity] = await q.query<{ steam_id: string }>("select steam_id from player_experience_identities where user_id=$1", [user.id]);
    if (!identity || !connection) return fail("consent_required");
    await q.query("update player_experience_connections set lease_token=$2,lease_until=$3,last_attempt_at=$4 where id=$1", [connectionId, lease, new Date(now + 2 * 60_000), new Date(now)]);
    return { connection, steamId: identity.steam_id };
  });
  let result: ImportResult | null = null, issue = "";
  try { result = await importSource(db, claim.connection, claim.steamId, runtime); }
  catch (error) { issue = error instanceof SourceError ? error.issue : "invalid_response"; }
  return db.tx(async q => {
    // Disconnect/erase during network I/O invalidates the lease and never recreates deleted data.
    const [current] = await q.query<ConnectionRow>("select * from player_experience_connections where id=$1 and user_id=$2 and lease_token=$3 for update", [connectionId, user.id, lease]);
    if (!current) return { status: "disconnected" as const };
    const [active] = await q.query("select id from users where id=$1 and status='active'", [user.id]);
    if (!active) { await q.query("delete from player_experience_connections where id=$1", [connectionId]); return { status: "disconnected" as const }; }
    if (result) {
      try {
        await q.query(`update player_experience_connections set external_id=$3,display_name=$4,status=$5,issue=$6,records=$7,verified_at=case when $5='unavailable' then null else coalesce(verified_at,$8) end,last_success_at=case when $5='available' then $8 else last_success_at end,next_sync_at=$9,lease_token=null,lease_until=null,failures=0 where id=$1 and lease_token=$2`, [connectionId, lease, result.externalId, result.displayName, result.status, result.issue, JSON.stringify(result.records), new Date(now), new Date(now + SYNC_INTERVAL)]);
      } catch (error) { if (isUniqueViolation(error)) return fail("already_registered"); throw error; }
      return { status: result.status };
    }
    const invalidate = issue === "identity_mismatch" || issue === "access_denied" || issue === "not_found";
    await q.query(`update player_experience_connections set status=$3,issue=$4,records=case when $5 then '[]'::jsonb else records end,verified_at=case when $5 then null else verified_at end,lease_token=null,lease_until=null,failures=failures+1,next_sync_at=$6 where id=$1 and lease_token=$2`, [connectionId, lease, issue === "not_found" ? "unavailable" : "error", issue, invalidate, new Date(now + Math.min(SYNC_INTERVAL, 3600_000 * 2 ** Math.min(current.failures, 5)))]);
    return { status: "error" as const, issue };
  });
}

export async function setExperienceSharing(db: Database, user: SessionUser, connectionId: string, shared: boolean) {
  if (!uuid(connectionId)) fail("invalid_input");
  await db.tx(async q => { await activeAccount(q, user); const rows = await q.query("update player_experience_connections set shared=$3 where id=$1 and user_id=$2 returning id", [connectionId, user.id, shared]); if (!rows.length) fail("not_found"); });
}
export async function setPartnerExperienceSharing(db: Database, user: SessionUser, shared: boolean) {
  await db.tx(async q => { await activeAccount(q, user); await q.query("insert into player_experience_settings(user_id,share_partner) values($1,$2) on conflict(user_id) do update set share_partner=excluded.share_partner", [user.id, shared]); });
}
export async function disconnectExperience(db: Database, user: SessionUser, connectionId: string) {
  if (!uuid(connectionId)) fail("invalid_input");
  await db.tx(async q => { await q.query("delete from player_experience_connections where id=$1 and user_id=$2", [connectionId, user.id]); await audit(q, { actorId: user.id, action: "experience.source_disconnected", entity: "experience_connection", entityId: connectionId }); });
}
export async function disconnectSteamIdentity(db: Database, user: SessionUser) {
  await db.tx(async q => { await eraseExperience(q, user.id); await audit(q, { actorId: user.id, action: "experience.identity_disconnected", entity: "user", entityId: user.id }); });
}

export async function profileExperience(q: Queryable, userId: string, viewerId?: string): Promise<ProfileExperience> {
  const canManage = userId === viewerId;
  const empty: ProfileExperience = { canManage, connections: [], partnerRecords: [], steamIdentity: null, sharePartner: false, hasImportedExperience: false };
  const [owner] = await q.query<{ profile_public: boolean; status: string }>("select profile_public,status from users where id=$1", [userId]);
  if (!owner || owner.status !== "active" || (!canManage && !owner.profile_public)) return empty;
  const [identity] = canManage ? await q.query<{ steam_id: string; verified_at: Date }>("select steam_id,verified_at from player_experience_identities where user_id=$1", [userId]) : [];
  const [settings] = await q.query<{ share_partner: boolean }>("select share_partner from player_experience_settings where user_id=$1", [userId]);
  const rows = await q.query<ConnectionRow>("select * from player_experience_connections where user_id=$1 and ($2 or (shared and verified_at is not null)) order by provider", [userId, canManage]);
  const connections: ExperienceConnection[] = rows.map(row => ({ id: row.id, provider: row.provider, externalId: row.external_id, displayName: row.display_name, status: row.records.length && row.last_success_at && (Date.now() - new Date(row.last_success_at).getTime() > EXPERIENCE_STALE_MS || row.status === "error") ? "stale" : row.status, issue: row.issue, shared: row.shared, verifiedAt: iso(row.verified_at), lastAttemptAt: iso(row.last_attempt_at), lastSuccessAt: iso(row.last_success_at), nextSyncAt: iso(row.next_sync_at)!, records: row.records }));
  const partner = canManage || settings?.share_partner ? await q.query<{ id: string; source: string; game: string; match_ref: string; played_at: Date; metrics: Record<string, number>; source_url: string }>(`select o.id,s.name source,o.game,o.match_ref,o.played_at,o.metrics,s.evidence_url source_url from stats_observations o join stats_sources s on s.id=o.source_id join stats_links l on l.source_id=o.source_id and l.user_id=o.user_id and l.game=o.game where o.user_id=$1 and o.status='confirmed' and s.status='approved' and l.status='verified' order by o.played_at desc limit 20`, [userId]) : [];
  const partnerRecords = partner.map(row => ({ id: row.id, source: row.source, game: row.game, matchRef: row.match_ref, playedAt: iso(row.played_at)!, metrics: row.metrics, sourceUrl: row.source_url }));
  return { canManage, connections, partnerRecords, steamIdentity: identity ? { steamId: identity.steam_id, verifiedAt: iso(identity.verified_at)! } : null, sharePartner: settings?.share_partner ?? false, hasImportedExperience: connections.some(c => Boolean(c.verifiedAt) && hasExperience(c.records)) || partnerRecords.length > 0 };
}

export async function experienceExport(q: Queryable, userId: string) {
  return { version: CONSENT_VERSION, identity: await q.query("select steam_id,verified_at,consent_version,consented_at from player_experience_identities where user_id=$1", [userId]), connections: await q.query("select provider,external_id,display_name,status,issue,shared,consent_version,consented_at,verified_at,last_attempt_at,last_success_at,next_sync_at,records from player_experience_connections where user_id=$1", [userId]), settings: await q.query("select share_partner from player_experience_settings where user_id=$1", [userId]) };
}
/** One bounded query for public directory cards; no private identities or records escape. */
export async function publicExperienceBadges(q: Queryable, usernames: string[]): Promise<Map<string, string[]>> {
  const names = [...new Set(usernames.map(name => name.toLowerCase()).filter(name => /^[a-z0-9_]{3,24}$/.test(name)))].slice(0, 100);
  const badges = new Map<string, string[]>(); if (!names.length) return badges;
  const rows = await q.query<{ username: string; provider: ExperienceProvider; records: ExperienceRecord[] }>(`select u.username,c.provider,c.records from users u join player_experience_connections c on c.user_id=u.id where u.username=any($1) and u.status='active' and u.profile_public and c.shared and c.verified_at is not null order by u.username,c.provider limit 300`, [names]);
  const labels = { steam: "Steam", opendota: "OpenDota", faceit: "FACEIT" };
  for (const row of rows) if (hasExperience(row.records)) badges.set(row.username, [...(badges.get(row.username) ?? []), labels[row.provider]]);
  return badges;
}
export async function eraseExperience(q: Queryable, userId: string) {
  // Same lock order as identity verification prevents consent withdrawal racing a late callback.
  await q.query("select id from users where id=$1 for update", [userId]);
  await q.query("delete from player_experience_states where user_id=$1", [userId]);
  await q.query("delete from player_experience_nonces where user_id=$1", [userId]);
  await q.query("delete from player_experience_connections where user_id=$1", [userId]);
  await q.query("delete from player_experience_identities where user_id=$1", [userId]);
  await q.query("delete from player_experience_settings where user_id=$1", [userId]);
}
export async function syncExperience(db: Database, limit = 5, runtime: Runtime = {}) {
  const now = runtime.now ?? Date.now(), deadline = Date.now() + 45_000;
  const available = experienceAvailability(runtime.env).filter(p => p.available).map(p => p.provider);
  const rows = await db.query<{ id: string; user_id: string }>(`select c.id,c.user_id from player_experience_connections c join users u on u.id=c.user_id where u.status='active' and c.provider=any($1) and c.next_sync_at<=$2 and (c.lease_until is null or c.lease_until<$2) and not exists(select 1 from sanctions s where s.user_id=u.id and s.kind='suspension' and s.revoked_at is null and s.starts_at<=$2 and (s.ends_at is null or s.ends_at>$2)) order by c.next_sync_at,c.id limit $3`, [available, new Date(now), Math.max(1, Math.min(5, Math.trunc(limit) || 5))]);
  let processed = 0, failed = 0;
  for (const row of rows) {
    if (Date.now() > deadline - 1000) break;
    try { const result = await refreshExperience(db, { id: row.user_id, sessionId: "", email: "", username: "", displayName: "", roles: [] }, row.id, { ...runtime, deadline }, true); processed++; if (result.status === "error") failed++; }
    catch { failed++; }
  }
  await db.query("delete from player_experience_states where expires_at<$1", [new Date(now - 86400_000)]);
  await db.query("delete from player_experience_nonces where expires_at<$1", [new Date(now)]);
  await db.query("delete from player_experience_budgets where expires_at<$1", [new Date(now)]);
  return { processed, failed, dueSelected: rows.length };
}
/** Consented sources belonging to this viewer only; called after rendering their management page. */
export async function syncOwnExperience(db: Database, user: SessionUser, runtime: Runtime = {}) {
  const now = runtime.now ?? Date.now(), deadline = Date.now() + 40_000;
  const available = experienceAvailability(runtime.env).filter(p => p.available).map(p => p.provider);
  const rows = await db.query<{ id: string }>("select id from player_experience_connections where user_id=$1 and provider=any($2) and next_sync_at<=$3 and (lease_until is null or lease_until<$3) order by next_sync_at limit 3", [user.id, available, new Date(now)]);
  let processed = 0;
  for (const row of rows) { if (Date.now() > deadline - 1000) break; try { await refreshExperience(db, user, row.id, { ...runtime, deadline }, true); processed++; } catch { /* The card keeps its saved state; a later due run can retry. */ } }
  return { processed };
}
