#!/usr/bin/env node
// End-to-end check over real HTTP against a running build:
// public pages → sign-up → onboarding → team → single- and double-elimination, round-robin and Swiss tournaments →
// a circuit season (points, qualification, close) → results →
// challenges and quick match → objectives → membership application → staff second factor, roles, messages,
// switches and maintenance (with OWNER_CODE).
// Usage: BASE=http://127.0.0.1:3100 [OWNER_CODE=…] node scripts/e2e.mjs   (creates uniquely named test records)
// Never point it at production: it creates accounts and records.
import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const BASE = (process.env.BASE || "http://127.0.0.1:3100").replace(/\/$/, "");
const target = new URL(BASE);
if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname) || target.username || target.password) throw new Error("Acceptance creates test records and requires an isolated loopback server");
const RUN = Date.now().toString(36).slice(-5);
const PASSWORD = "e2e-password-" + RUN;
const log = (...a) => console.log("•", ...a);

class Client {
  constructor(name) {
    this.name = name;
    this.jar = new Map();
  }
  get cookie() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  store(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (!v || /Max-Age=0/i.test(line)) this.jar.delete(k);
      else this.jar.set(k, v);
    }
  }
  async get(path) {
    const res = await fetch(BASE + path, { headers: { cookie: this.cookie }, redirect: "manual" });
    this.store(res);
    return { status: res.status, text: await res.text(), location: res.headers.get("location") };
  }
  async post(action, fields, { origin = BASE } = {}) {
    const body = new URLSearchParams({ lang: "ru", back: "/ru" });
    // An array value is sent as a repeated field (checkbox groups).
    for (const [k, v] of Object.entries(fields)) {
      if (!Array.isArray(v)) body.set(k, v);
      else {
        body.delete(k);
        for (const x of v) body.append(k, x);
      }
    }
    const res = await fetch(`${BASE}/api/a/${action}?lang=ru`, {
      method: "POST",
      headers: { cookie: this.cookie, origin, "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
    });
    this.store(res);
    const location = res.headers.get("location") || "";
    const url = new URL(location, BASE);
    return { status: res.status, location, ok: url.searchParams.get("ok"), e: url.searchParams.get("e"), path: url.pathname, url };
  }
}

const uuidAfter = (html, name) => {
  const m = new RegExp(`name="${name}" value="([0-9a-f-]{36})"`).exec(html);
  return m?.[1];
};

function totp(base32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32.replace(/\s+/g, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const bytes = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac("sha1", bytes).update(counter).digest();
  const o = mac[mac.length - 1] & 0x0f;
  const code = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | mac[o + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

async function signup(name) {
  const c = new Client(name);
  const r = await c.post("auth.signup", {
    email: `${name}.${RUN}@example.com`,
    username: `${name}_${RUN}`,
    displayName: `${name} ${RUN}`,
    password: PASSWORD,
    adult: "on",
    terms: "on",
    back: "/ru/signup",
  });
  assert.equal(r.status, 303);
  assert.equal(r.ok, "welcome", `signup ${name}: ${r.location}`);
  assert.equal(r.path, "/ru/welcome", "new accounts land on onboarding");
  assert.ok(c.jar.get("mv_session"), "session cookie set");
  c.username = `${name}_${RUN}`;
  return c;
}

/** Plays every open match of the players' hubs through the UI actions until nothing is left. */
async function playOut(players, maxPasses = 40) {
  let passes = 0;
  for (; passes < maxPasses; passes++) {
    let acted = false;
    for (const p of players) {
      const hub = (await p.get("/ru/hub")).text;
      const ids = [...new Set([...hub.matchAll(/\/ru\/matches\/([0-9a-f-]{36})/g)].map((m) => m[1]))];
      for (const id of ids) {
        const c = await p.post("match.confirm", { match: id, back: `/ru/matches/${id}` });
        if (c.ok === "result_confirmed") {
          acted = true;
          continue;
        }
        if (c.e === "no_pending_result") {
          const s = await p.post("match.submit", { match: id, scoreA: "2", scoreB: "1", evidence: "https://example.com/e2e", back: `/ru/matches/${id}` });
          if (s.ok === "result_submitted") acted = true;
        }
      }
    }
    if (!acted) break;
  }
  return passes;
}

// ---------- Owner access recovery (C-34): only on a database without an administrator ----------
if (process.env.OWNER_CODE) {
  const anon = new Client("anon");
  const page = await anon.get("/ru/admin/claim");
  if (page.status === 200 && page.text.includes("Вход владельца")) {
    const owner = await signup("owner");
    const fresh = "owner-new-password-" + RUN;
    const recover = (fields) => anon.post("account.owner_recover", { password: fresh, back: "/ru/admin/claim", ...fields });
    assert.equal((await recover({ login: owner.username, token: "MV-not-the-owner-code" })).e, "admin_token_invalid");
    assert.equal((await recover({ login: `nobody_${RUN}`, token: process.env.OWNER_CODE })).e, "owner_account_not_found");
    const done = await recover({ login: owner.username, token: process.env.OWNER_CODE });
    assert.equal(done.ok, "admin_granted", done.location);
    assert.equal(done.path, "/ru/admin/security");
    assert.ok(anon.jar.get("mv_session"), "the owner is signed in");
    assert.equal((await anon.get("/ru/admin")).status, 307, "the second factor is still required");
    assert.equal((await anon.get("/ru/admin/security")).status, 200);
    assert.ok((await owner.get("/ru/hub")).location?.includes("/signin"), "the earlier session ended");
    const later = new Client("later");
    const closed = await later.get("/ru/admin/claim");
    assert.ok(closed.status === 307 && closed.location.includes("/ru/signin"), "the form closes once an administrator exists");
    assert.equal((await later.post("auth.signin", { login: owner.username, password: PASSWORD })).e, "invalid_credentials");
    assert.equal((await later.post("auth.signin", { login: owner.username, password: fresh })).path, "/ru/hub");
    log("owner access recovery while no administrator exists");
  }
}

// ---------- Public surface ----------
const guest = new Client("guest");
const pages = ["", "/tournaments", "/circuits", "/games", "/games/cs2", "/rankings", "/players", "/teams", "/finder", "/membership", "/matchmaking", "/challenges", "/partners", "/organizer",
  "/innovations", "/trust", "/help", "/contact", "/status", "/terms", "/privacy", "/explore", "/search?q=cup", "/search?q=xp", "/academy", "/cloud-gaming", "/shop",
  "/signin", "/signup", "/signup/check-email", "/forgot-password", "/verify-email", "/activate?token=short", "/reset-password"];
for (const lang of ["ru", "en"])
  for (const p of pages) {
    const r = await guest.get(`/${lang}${p}`);
    assert.equal(r.status, 200, `${lang}${p} → ${r.status}`);
  }
log(`public pages: ${pages.length * 2} × 200`);
for (const p of ["/ru/hub", "/ru/progress", "/ru/billing", "/ru/welcome", "/ru/settings"]) assert.equal((await guest.get(p)).status, 307, `${p} redirects guests`);
assert.equal((await guest.get("/xx")).status, 404);
const faq = (await guest.get("/ru/search?q=монеты")).text;
assert.ok(faq.includes("/ru/help#faq-"), "search covers help articles");
const privacy = (await guest.get("/en/privacy")).text;
assert.ok(privacy.includes("Services connected right now"), "privacy lists live services");
const pubgPage = (await guest.get("/en/games/pubg")).text;
// Since C-33 the page reads the persisted game registry: FFA lobbies, referee-entered placements, roster of 4.
assert.ok(pubgPage.includes("FFA lobbies") && pubgPage.includes("referees enter placements and points"), "battle royale games state FFA tournaments and how their results are entered");
assert.ok(!pubgPage.includes("battle royale format — in development") && pubgPage.includes("4 players per roster") && !pubgPage.includes("4v4"), "no stale battle royale label; a roster of 4, not 4v4");
assert.ok((await guest.get("/ru/games/pubg")).text.includes("4 игрока в составе"), "Russian roster size uses the plural form");
assert.ok((await guest.get("/ru/tournaments")).text.includes('value="pubg"'), "the tournament list filters by battle royale games");
const health = await (await fetch(`${BASE}/api/health`)).json();
assert.equal(health.status, "ok");
assert.ok(["off", "test", "live"].includes(health.payments) && ["connected", "not_connected"].includes(health.email), "minimal public readiness");
log("search, privacy services, health readiness");

const bad = await guest.post("application.create", { kind: "contact", name: "x", email: "x@example.com", consent: "on" }, { origin: "https://evil.example" });
assert.equal(bad.e, "bad_origin");
const app = await guest.post("application.create", { kind: "partner", name: "E2E Partner", email: `p.${RUN}@example.com`, company: "E2E", message: "test", consent: "on" });
assert.equal(app.ok, "application_received");
log("origin check and partner application queue");

// ---------- Accounts ----------
const draftFail = await new Client("draft").post("auth.signup", {
  email: `draft.${RUN}@example.com`, username: "x", displayName: "Draft", password: PASSWORD, adult: "on", terms: "on", back: "/ru/signup",
});
assert.equal(draftFail.e, "invalid_username");
assert.equal(draftFail.url.searchParams.get("email"), null, "typed values never travel in the URL");
const org = await signup("org");
const dup = await new Client("dup").post("auth.signup", { email: `org.${RUN}@example.com`, username: `other_${RUN}`, displayName: "Dup", password: PASSWORD, adult: "on", terms: "on" });
assert.equal(dup.e, "signup_unavailable", "an existing email is never confirmed");
const out = await org.post("auth.signout", {});
assert.equal(out.ok, "signed_out");
const back = await org.post("auth.signin", { login: org.username, password: PASSWORD });
assert.ok(back.path.endsWith("/hub"), back.location);
const welcome = (await org.get("/ru/welcome")).text;
assert.ok(welcome.includes("Выполнено: 0 из 4"));
assert.equal((await org.post("account.country", { countryCode: "AE", back: "/ru/welcome" })).ok, "saved");
assert.equal((await org.post("account.game", { game: "cs2", handle: `org${RUN}`, back: "/ru/welcome" })).ok, "saved");
assert.equal((await org.post("account.country", { countryCode: "ZZ", back: "/ru/welcome" })).e, "invalid_country");
const done = await org.post("onboarding.done", { next: "hub", back: "/ru/welcome" });
assert.equal(done.path, "/ru/hub");
assert.ok((await org.get("/ru/welcome")).text.includes("Выполнено: 2 из 4"));
log("draft-safe sign-up errors, generic duplicate response, sign-in, onboarding steps");

// ---------- Single elimination ----------
const space = await org.post("org.create", { name: `E2E Series ${RUN}`, description: "e2e" });
assert.equal(space.ok, "org_created");
const orgId = uuidAfter((await org.get(space.path)).text, "org");
assert.ok(orgId, "org id on page");
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
const created = await org.post("tournament.create", {
  org: orgId, name: `E2E Cup ${RUN}`, game: "cs2", format: "single_elimination", participantType: "solo", teamSize: "5", maxParticipants: "8",
  checkInRequired: "on", region: "MENA", startsAt: tomorrow, tz: "Asia/Dubai", description: "e2e", rules: "bo1",
  seriesFields: "1", mapPool: "Alpha, Bravo, Charlie",
});
assert.equal(created.ok, "tournament_created", created.location);
const manage = created.path;
const tSlug = manage.split("/").pop();
const tId = uuidAfter((await org.get(manage)).text, "tournament");
assert.ok(tId);
assert.equal((await guest.get(`/ru/tournaments/${tSlug}`)).status, 404, "draft hidden from public");
for (const to of ["PUBLISHED", "REGISTRATION_OPEN"]) assert.equal((await org.post("tournament.transition", { tournament: tId, to })).ok, "status_changed");
assert.equal((await guest.get(`/ru/tournaments/${tSlug}`)).status, 200);
log("organiser space, draft tournament, publish, open registration");

// ---------- Partner integrations: API key, signed webhook to a local receiver, widgets ----------
// The receiver checks signatures exactly as the developer documentation shows; it remembers accepted ids.
const hookLog = [];
const hookSeen = new Set();
let hookSecret = "";
const receiver = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const id = req.headers["mv-webhook-id"];
    const ts = req.headers["mv-webhook-timestamp"];
    const sig = req.headers["mv-webhook-signature"] || "";
    const expected = "v1=" + createHmac("sha256", hookSecret).update(`${id}.${ts}.${body}`).digest("hex");
    const signed = sig.split(" ").some((x) => x.length === expected.length && timingSafeEqual(Buffer.from(x), Buffer.from(expected)));
    const fresh = Math.abs(Date.now() / 1000 - Number(ts)) <= 300;
    const verdict = !signed || !fresh ? "bad" : hookSeen.has(id) ? "replayed" : "ok";
    if (verdict === "ok") hookSeen.add(id);
    hookLog.push({ id, ts, sig, body, verdict, type: JSON.parse(body || "{}").type });
    res.writeHead(verdict === "ok" ? 200 : verdict === "replayed" ? 409 : 401).end();
  });
});
await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
receiver.unref();
const hookUrl = `http://127.0.0.1:${receiver.address().port}/hook`;
const integrations = `${space.path}/integrations`;
const guestIntegrations = await guest.get(integrations);
assert.ok([303, 307, 308].includes(guestIntegrations.status) && guestIntegrations.location.includes("/ru/signin"), "integrations need an account");
assert.ok((await org.get(integrations)).text.includes("API, вебхуки и виджеты"));
const keyMade = await org.post("integrations.key_create", { org: orgId, name: "e2e site", back: integrations });
assert.equal(keyMade.ok, "api_key_created");
const apiKey = /mvk_[A-Za-z0-9_-]{40}/.exec((await org.get(integrations)).text)?.[0];
assert.ok(apiKey, "the new key is shown once on the integrations page");
const api = (path, key = apiKey, method = "GET") => fetch(`${BASE}/api/v1${path}`, { method, headers: key ? { authorization: `Bearer ${key}` } : {} });
const listed = await api("/tournaments");
assert.equal(listed.status, 200);
assert.ok((await listed.json()).data.some((x) => x.slug === tSlug), "the key lists its space's tournament");
assert.equal((await api("/tournaments")).headers.get("x-ratelimit-limit"), "120");
assert.equal((await api("/tournaments", "")).status, 401);
assert.equal((await api(`/tournaments/${tSlug}`)).status, 200);
assert.equal((await api("/tournaments/no-such-event")).status, 404);
assert.equal((await api("/tournaments", apiKey, "POST")).status, 405);
assert.equal((await org.post("integrations.secret_hide", { back: integrations })).status, 303);
assert.ok(!(await org.get(integrations)).text.includes(apiKey), "after 'I have saved it' the key is gone from the page");
const hookMade = await org.post("integrations.webhook_create", { org: orgId, url: hookUrl, events: ["registration.created", "tournament.status_changed", "match.completed"], back: integrations });
assert.equal(hookMade.ok, "webhook_created", `${hookMade.location} — the local server must run with MV_WEBHOOK_ALLOW_LOCAL=1`);
hookSecret = /whsec_[A-Za-z0-9_-]{40,}/.exec((await org.get(integrations)).text)?.[0] ?? "";
assert.ok(hookSecret, "the signing secret is shown once");
const embedHead = await fetch(`${BASE}/embed/ru/tournaments/${tSlug}/registration`);
assert.equal(embedHead.status, 200);
assert.equal(embedHead.headers.get("x-frame-options"), null, "widgets may be framed");
assert.equal(embedHead.headers.get("content-security-policy"), "frame-ancestors *");
assert.ok((await embedHead.text()).includes(`E2E Cup ${RUN}`));
assert.equal((await fetch(`${BASE}/ru/tournaments/${tSlug}`)).headers.get("x-frame-options"), "DENY", "portal pages refuse framing");
assert.ok((await (await fetch(`${BASE}/embed/ru/organizer/${space.path.split("/").pop()}/calendar`)).text()).includes(`E2E Cup ${RUN}`), "the calendar widget lists the event");
log("integrations: API key shown once and scoped (401 without, 404 unknown, 405 on writes), webhook with a signing secret, widgets framable while pages are not");

const players = [];
for (let i = 1; i <= 5; i++) players.push(await signup(`p${i}`));
for (const p of players) assert.equal((await p.post("tournament.register", { tournament: tId })).ok, "registered");
assert.equal((await players[0].post("tournament.register", { tournament: tId })).e, "already_registered");
assert.equal((await players[0].post("tournament.transition", { tournament: tId, to: "IN_PROGRESS" })).e, "forbidden");
assert.equal((await org.post("tournament.checkin_window", { tournament: tId, open: "1" })).ok, "saved");
for (const p of players.slice(0, 4)) assert.equal((await p.post("tournament.checkin", { tournament: tId })).ok, "checked_in");
assert.equal((await org.post("tournament.transition", { tournament: tId, to: "REGISTRATION_CLOSED" })).ok, "status_changed");
assert.equal((await org.post("tournament.transition", { tournament: tId, to: "IN_PROGRESS" })).ok, "status_changed");
log("5 registrations, duplicate refused, 4 check-ins, tournament started");
// Webhook deliveries run after each action's response: wait for them.
const started = () => hookLog.some((h) => h.type === "tournament.status_changed" && JSON.parse(h.body).data.to === "IN_PROGRESS");
for (let i = 0; i < 60 && (hookLog.filter((h) => h.type === "registration.created").length < 5 || !started()); i++) await new Promise((r) => setTimeout(r, 250));
assert.equal(hookLog.filter((h) => h.type === "registration.created" && h.verdict === "ok").length, 5, "five signed registration events");
assert.ok(started(), "the start is an event");
const captured = hookLog.find((h) => h.verdict === "ok");
const replayed = await fetch(hookUrl, { method: "POST", headers: { "content-type": "application/json", "mv-webhook-id": captured.id, "mv-webhook-timestamp": captured.ts, "mv-webhook-signature": captured.sig }, body: captured.body });
assert.equal(replayed.status, 409, "a replayed delivery is rejected by the receiver");
const keyId = uuidAfter((await org.get(integrations)).text, "key");
assert.equal((await org.post("integrations.key_revoke", { key: keyId, back: integrations })).ok, "api_key_revoked");
assert.equal((await api("/tournaments")).status, 401, "a revoked key stops working");
log("webhooks: five registrations and the start delivered signed, a replay refused; the revoked key is refused");

// ---------- Game Day ----------
const gdGuest = await guest.get("/ru/gameday");
assert.ok([303, 307, 308].includes(gdGuest.status) && gdGuest.location.includes("/ru/signin"), "Game Day needs an account");
const gd = (await players[0].get("/ru/gameday")).text;
assert.ok(gd.includes("Игровой день") && gd.includes(`/ru/tournaments/${tSlug}`), "Game Day lists the live event");
const gdMatch = /\/ru\/matches\/([0-9a-f-]{36})/.exec(gd)?.[1];
assert.ok(gdMatch, "Game Day links the current match");
assert.ok(gd.includes("Отметьтесь, что вы на месте"), "the step says what to do now");
const gdCheck = await players[0].post("match.checkin", { match: gdMatch, back: "/ru/gameday" });
assert.equal(gdCheck.ok, "checked_in");
assert.equal(gdCheck.path, "/ru/gameday", "actions taken on Game Day return there");
assert.equal((await players[0].post("match.call", { match: gdMatch, message: "e2e: opponent is not in the lobby", back: "/ru/gameday" })).ok, "referee_called");
assert.equal((await players[0].post("match.call", { match: gdMatch, message: "e2e: again", back: "/ru/gameday" })).ok, "referee_call_exists");
assert.equal((await players[4].post("match.call", { match: gdMatch, message: "e2e: not mine", back: "/ru/gameday" })).e, "not_participant");
const refView = (await org.get(`/ru/matches/${gdMatch}`)).text;
const callId = uuidAfter(refView, "call");
assert.ok(callId && refView.includes("e2e: opponent is not in the lobby"), "the referee sees the open call");
assert.equal((await org.post("match.call_close", { call: callId, note: "e2e: coming to your station", back: `/ru/matches/${gdMatch}` })).ok, "referee_call_closed");
assert.ok((await players[0].get("/ru/gameday")).text.includes("e2e: coming to your station"), "the player sees the referee's reply");
log("Game Day: current match and step, check-in returns to Game Day, referee call, duplicate and outsider refused, reply shown");
const phoneList = (await players[0].get(`/ru/tournaments/${tSlug}`)).text;
assert.ok(phoneList.includes('class="bracket-narrow"') && phoneList.includes("Мой матч") && phoneList.includes("round-chip"), "phone bracket list with round chips and the player's match");
assert.ok(!(await guest.get(`/ru/tournaments/${tSlug}`)).text.includes("Мой матч"), "no personal chip for a guest");
log("bracket on phones: round list with chips; the player's match is linked, a guest sees none");

// ---------- Streams, recordings and overlays ----------
const streamTitle = `E2E эфир ${RUN}`;
const streamForm = { tournament: tId, url: `https://www.twitch.tv/e2e_${RUN}`, title: streamTitle, kind: "live", match: gdMatch, language: "ru", startsAt: "", tz: "UTC", back: manage };
assert.equal((await org.post("stream.add", streamForm)).e, "stream_rights", "the rights must be confirmed");
assert.equal((await org.post("stream.add", { ...streamForm, rights: "1" })).ok, "stream_added");
assert.equal((await players[4].post("stream.add", { ...streamForm, url: "https://www.twitch.tv/not_mine", rights: "1" })).e, "forbidden", "only the event's managers assign streams");
const watchMatch = (await guest.get(`/ru/matches/${gdMatch}`)).text;
assert.ok(watchMatch.includes(streamTitle) && watchMatch.includes(`https://www.twitch.tv/e2e_${RUN}`) && watchMatch.includes("Смотреть здесь"), "the match page shows the stream with a click-to-play player");
assert.ok(!/<iframe[^>]*player\.twitch\.tv/.test(watchMatch), "nothing from the platform loads before a click");
assert.ok((await players[0].get("/ru/notifications")).text.includes("будет транслироваться"), "the match's players are told");
assert.ok((await guest.get(`/ru/tournaments/${tSlug}`)).text.includes(streamTitle), "the tournament page lists the stream");
assert.ok((await guest.get("/ru/media")).text.includes(streamTitle), "the media centre lists it");
const overlayPage = await guest.get(`/embed/ru/matches/${gdMatch}/overlay`);
assert.ok(overlayPage.status === 200 && overlayPage.text.includes("overlay-score"), "the broadcast overlay renders");
const overlayJson = await (await fetch(`${BASE}/api/overlay/matches/${gdMatch}`)).json();
assert.ok(overlayJson.data.a.name && overlayJson.data.b.name && ["none", "reported", "official"].includes(overlayJson.data.score.state), "overlay data from the match record");
log("streams: rights confirmed, a stream assigned to a match shows on the match, tournament and media pages with a click-to-play player; the players are told; overlay page and JSON");

// ---------- Live operations ----------
assert.equal((await org.post("match.pause", { match: gdMatch, reason: "e2e: server restart", back: `/ru/matches/${gdMatch}` })).ok, "match_paused");
assert.ok((await players[0].get(`/ru/matches/${gdMatch}`)).text.includes("e2e: server restart"), "both sides see why the match is paused");
assert.equal((await players[0].post("match.submit", { match: gdMatch, scoreA: "1", scoreB: "0", back: `/ru/matches/${gdMatch}` })).e, "match_paused");
assert.equal((await org.post("match.resume", { match: gdMatch, back: `/ru/matches/${gdMatch}` })).ok, "match_resumed");
assert.equal((await players[0].post("incident.open", { tournament: tId, kind: "technical", message: "e2e: not staff" })).e, "forbidden");
assert.equal((await org.post("incident.open", { tournament: tId, kind: "technical", priority: "high", match: gdMatch, message: "e2e: station 4 has no network", back: manage })).ok, "incident_opened");
const queueView = (await org.get(manage)).text;
assert.ok(queueView.includes("e2e: station 4 has no network") && queueView.includes('id="incidents"'), "the organiser page shows the incident queue");
const incidentId = uuidAfter(queueView, "incident");
assert.ok(incidentId);
assert.equal((await org.post("incident.resolve", { incident: incidentId, note: "e2e: cable replaced", back: manage })).ok, "incident_resolved");
log("live operations: match paused and resumed with results held, staff incident logged and closed from the queue, players cannot log one");
const vetoPage = (await players[0].get(`/ru/matches/${gdMatch}`)).text;
assert.ok(vetoPage.includes('id="veto"') && vetoPage.includes("MV-VETO-1"), "the match shows the map veto of the event's pool");
const vetoTurn = await players[0].post("match.veto", { match: gdMatch, map: "Alpha", back: `/ru/matches/${gdMatch}` });
assert.ok(vetoTurn.ok === "veto_saved" || vetoTurn.e === "not_your_turn", `a veto turn is taken or refused by turn order: ${vetoTurn.location}`);
assert.equal((await players[4].post("match.veto", { match: gdMatch, map: "Bravo", back: `/ru/matches/${gdMatch}` })).e, "not_your_turn", "an outsider has no turn");
log("map veto: the event's pool on the match page, turn order enforced");

// ---------- Team finder ----------
assert.equal((await players[0].post("finder.post", { kind: "lft", game: "cs2", region: "MENA", roles: "e2e AWP", back: "/ru/finder?kind=lft" })).ok, "finder_posted");
assert.ok((await guest.get("/ru/finder?kind=lft&game=cs2")).text.includes("e2e AWP"), "an LFT post is public");
assert.equal((await players[1].post("finder.post", { kind: "lfg", game: "cs2", note: "e2e group tonight", back: "/ru/finder?kind=lfg" })).ok, "finder_posted");
const lfgPage = (await players[2].get("/ru/finder?kind=lfg")).text;
const lfgPost = uuidAfter(lfgPage, "post");
assert.ok(lfgPost && lfgPage.includes("e2e group tonight"));
assert.equal((await players[2].post("finder.apply", { post: lfgPost, message: "e2e: me too", back: "/ru/finder?kind=lfg" })).ok, "finder_applied");
assert.equal((await players[2].post("finder.apply", { post: lfgPost, message: "again", back: "/ru/finder?kind=lfg" })).ok, "finder_already_applied");
assert.ok((await players[2].get("/ru/finder?kind=lfg")).text.includes("Отклик отправлен"), "a sent answer replaces the form");
const hostView = (await players[1].get("/ru/finder#mine")).text;
const lfgApp = uuidAfter(hostView, "application");
assert.ok(lfgApp && hostView.includes("e2e: me too"), "the host sees the answer");
assert.equal((await players[1].post("finder.decide", { application: lfgApp, accept: "1", back: "/ru/finder" })).ok, "finder_accepted");
log("team finder: LFT post public, LFG answer sent once and accepted by the host");

// ---------- Scouting ----------
assert.equal((await players[0].post("scout.watch", { username: players[1].username, back: "/ru/scouting" })).ok, "watch_added");
assert.equal((await players[0].post("scout.save", { name: `e2e ${RUN}`, game: "cs2", lft: "1", back: "/ru/scouting?game=cs2&lft=1" })).ok, "filter_saved");
const scoutPage = (await players[0].get("/ru/scouting?game=cs2&lft=1")).text;
assert.ok(scoutPage.includes(`e2e ${RUN}`) && scoutPage.includes(players[1].username), "saved filter and watchlist survive a reload");
assert.ok((await guest.get("/ru/scouting")).text.includes("signin"), "scouting is for signed-in players");
log("scouting: watchlist and saved filter survive a reload");

const passes = await playOut(players.slice(0, 4));
const tPage = (await guest.get(`/ru/tournaments/${tSlug}`)).text;
assert.ok(tPage.includes("Завершён"), "tournament completed");
assert.ok(/class="place">1</.test(tPage), "standings rendered");
assert.ok((await org.get(manage)).text.includes("Не прошёл check-in"), "missed check-in recorded");
log(`single elimination played to the final in ${passes} passes; standings published`);

// ---------- Bracket repair ----------
const repairSemi = /\/ru\/matches\/([0-9a-f-]{36})/.exec(tPage.slice(tPage.indexOf('id="bracket"')))?.[1];
assert.ok(repairSemi, "first semi-final found in the bracket");
const preview = (await org.get(`/ru/matches/${repairSemi}?repair=1&scoreA=0&scoreB=2`)).text;
const planHash = /name="plan" value="([0-9a-f]{16})"/.exec(preview)?.[1];
assert.ok(preview.includes("Последствия исправления") && planHash, "the referee sees the consequences before anything changes");
assert.ok(preview.includes("Турнир вернётся в статус"), "a replayed final is announced");
assert.equal((await org.post("match.repair", { match: repairSemi, scoreA: "0", scoreB: "2", note: "e2e: wrong side entered", plan: "0000000000000000", back: `/ru/matches/${repairSemi}` })).e, "repair_plan_changed");
assert.equal((await org.post("match.repair", { match: repairSemi, scoreA: "0", scoreB: "2", note: "e2e: wrong side entered", plan: planHash, back: `/ru/matches/${repairSemi}` })).ok, "bracket_repaired");
assert.ok((await guest.get(`/ru/tournaments/${tSlug}`)).text.includes("Идёт"), "the event is in progress again");
await playOut(players.slice(0, 4));
assert.ok((await guest.get(`/ru/tournaments/${tSlug}`)).text.includes("Завершён"), "the replayed final completes the event again");
log("bracket repair: consequences previewed, a stale plan refused, the final replayed and the event completed again");

// ---------- Double elimination ----------
const de = await org.post("tournament.create", {
  org: orgId, name: `E2E Double ${RUN}`, game: "cs2", format: "double_elimination", participantType: "solo", teamSize: "5", maxParticipants: "8",
  region: "MENA", startsAt: tomorrow, tz: "Asia/Dubai", description: "e2e", rules: "bo1",
});
assert.equal(de.ok, "tournament_created", de.location);
const deSlug = de.path.split("/").pop();
const deId = uuidAfter((await org.get(de.path)).text, "tournament");
for (const to of ["PUBLISHED", "REGISTRATION_OPEN"]) assert.equal((await org.post("tournament.transition", { tournament: deId, to })).ok, "status_changed");
for (const p of players.slice(0, 4)) assert.equal((await p.post("tournament.register", { tournament: deId })).ok, "registered");
for (const to of ["REGISTRATION_CLOSED", "IN_PROGRESS"]) assert.equal((await org.post("tournament.transition", { tournament: deId, to })).ok, "status_changed");
const dePasses = await playOut(players.slice(0, 4), 60);
const dePage = (await guest.get(`/ru/tournaments/${deSlug}`)).text;
assert.ok(dePage.includes("Нижняя сетка") && dePage.includes("Завершён"), "double elimination completed with a losers bracket");
log(`double elimination played through winners, losers and grand final in ${dePasses} passes`);

// ---------- Round robin, Swiss, a circuit, cloning and regeneration ----------
const circ = await org.post("circuit.create", {
  org: orgId, name: `E2E Series`, season: `S${RUN}`, game: "cs2", participantType: "solo", pointsTable: "100, 70, 50, 30",
  participationPoints: "10", qualifyTop: "2", divisions: "1", promote: "0", relegate: "0", description: "e2e",
});
assert.equal(circ.ok, "circuit_created", circ.location);
const cSlug = circ.path.split("/").pop();
const circuitId = uuidAfter((await org.get(circ.path)).text, "circuit");
assert.ok(circuitId, "circuit id on its page");
const roundsBase = { org: orgId, game: "cs2", participantType: "solo", teamSize: "5", maxParticipants: "8", startsAt: tomorrow, tz: "Asia/Dubai", description: "e2e", rules: "bo1", formatSettings: "1" };
assert.equal((await org.post("tournament.create", { ...roundsBase, name: `E2E Too Big ${RUN}`, format: "round_robin", maxParticipants: "40" })).e, "round_robin_limit");
const rr = await org.post("tournament.create", {
  ...roundsBase, name: `E2E Round Robin ${RUN}`, format: "round_robin", pointsWin: "3", pointsDraw: "1", pointsLoss: "0", allowDraws: "on", legs: "1",
  circuitFields: "1", circuitId, circuitWeight: "200", circuitDivision: "", qualifierCircuitId: "",
});
assert.equal(rr.ok, "tournament_created", rr.location);
const rrSlug = rr.path.split("/").pop();
const rrId = uuidAfter((await org.get(rr.path)).text, "tournament");
for (const to of ["PUBLISHED", "REGISTRATION_OPEN"]) assert.equal((await org.post("tournament.transition", { tournament: rrId, to })).ok, "status_changed");
for (const p of players.slice(0, 4)) assert.equal((await p.post("tournament.register", { tournament: rrId })).ok, "registered");
const rrPreview = (await guest.get(`/ru/tournaments/${rrSlug}`)).text;
assert.ok(rrPreview.includes("Предварительное расписание") && rrPreview.includes("Тур 3"), "round-robin schedule preview");
assert.ok((await org.get(rr.path)).text.includes("Предпросмотр структуры"), "structure preview for the organiser");
for (const to of ["REGISTRATION_CLOSED", "IN_PROGRESS"]) assert.equal((await org.post("tournament.transition", { tournament: rrId, to })).ok, "status_changed");
const firstRr = /\/ru\/matches\/([0-9a-f-]{36})/.exec((await org.get(rr.path)).text)?.[1];
assert.ok(firstRr, "open round-robin match listed for the organiser");
assert.equal((await org.post("match.official", { match: firstRr, scoreA: "1", scoreB: "1", back: `/ru/matches/${firstRr}` })).ok, "result_confirmed", "a draw is accepted");
const drawPage = (await guest.get(`/ru/matches/${firstRr}`)).text;
assert.ok(drawPage.includes("Ничья"), "the draw is shown on the match page");
const drawUser = /\/ru\/players\/([A-Za-z0-9_]+)/.exec(drawPage)?.[1];
assert.ok(drawUser, "a side of the drawn match");
const rrPasses = await playOut(players.slice(0, 4));
const rrPage = (await guest.get(`/ru/tournaments/${rrSlug}`)).text;
assert.ok(rrPage.includes("Круговая система") && rrPage.includes("Завершён") && rrPage.includes("ЛВ") && rrPage.includes("MV-STANDINGS-1"), "round robin completed with its table and rules");
log(`round robin with a draw played out in ${rrPasses} passes; table with head-to-head and versioned rules`);

const sw = await org.post("tournament.create", { ...roundsBase, name: `E2E Swiss ${RUN}`, format: "swiss", pointsWin: "3", pointsLoss: "0", pointsDraw: "1", swissRounds: "", circuitFields: "1", circuitId, circuitWeight: "100" });
assert.equal(sw.ok, "tournament_created", sw.location);
const swSlug = sw.path.split("/").pop();
const swId = uuidAfter((await org.get(sw.path)).text, "tournament");
for (const to of ["PUBLISHED", "REGISTRATION_OPEN"]) assert.equal((await org.post("tournament.transition", { tournament: swId, to })).ok, "status_changed");
for (const p of players) assert.equal((await p.post("tournament.register", { tournament: swId })).ok, "registered");
for (const to of ["REGISTRATION_CLOSED", "IN_PROGRESS"]) assert.equal((await org.post("tournament.transition", { tournament: swId, to })).ok, "status_changed");
assert.equal((await org.post("tournament.regenerate", { tournament: swId })).ok, "bracket_regenerated", "round 1 can be rebuilt before any result");
const swPasses = await playOut(players, 60);
const swPage = (await guest.get(`/ru/tournaments/${swSlug}`)).text;
assert.ok(swPage.includes("Швейцарская система") && swPage.includes("Завершён") && swPage.includes("МБх") && swPage.includes("MV-SWISS-1"), "Swiss completed with Buchholz columns");
assert.ok(swPage.includes("Тур 3"), "three rounds for five entrants");
assert.equal((await org.post("tournament.regenerate", { tournament: swId })).e, "invalid_transition", "no regeneration after completion");
log(`Swiss for 5 entrants: 3 rounds with byes played in ${swPasses} passes`);

const cPage = (await guest.get(`/ru/circuits/${cSlug}`)).text;
assert.ok(cPage.includes("Квалификация") && cPage.includes(`E2E Round Robin ${RUN}`), "circuit table with qualification and its events");
assert.ok((await guest.get("/ru/circuits")).text.includes(`S${RUN}`), "circuit listed publicly");
const copy = await org.post("tournament.clone", { tournament: rrId, name: `E2E Copy ${RUN}` });
assert.equal(copy.ok, "tournament_cloned", copy.location);
const copyId = uuidAfter((await org.get(copy.path)).text, "tournament");
assert.equal((await org.post("circuit.close", { circuit: circuitId, nextSeason: `S${RUN}b`, createNext: "on" })).e, "circuit_open_events", "a linked draft blocks the close");
assert.equal((await org.post("tournament.transition", { tournament: copyId, to: "CANCELLED" })).ok, "status_changed");
const closed = await org.post("circuit.close", { circuit: circuitId, nextSeason: `S${RUN}b`, createNext: "on" });
assert.equal(closed.ok, "season_closed", closed.location);
assert.ok(closed.path.startsWith("/ru/organizer/c/"), "lands on the next season");
assert.ok((await guest.get(`/ru/circuits/${cSlug}`)).text.includes("Сезон закрыт"), "closed season is frozen");
assert.ok((await guest.get(`/ru/players/${players[0].username}`)).text.includes("Сезоны серий"), "passport shows the closed season");
assert.ok((await guest.get(`/ru/players/${drawUser}`)).text.includes("Ничья"), "passport shows the draw");
log("circuit points and qualification, clone blocks the close until cancelled, season closed into the next one, passport history");

// ---------- Groups → playoff, gauntlet ----------
const gr = await org.post("tournament.create", {
  ...roundsBase, name: `E2E Groups ${RUN}`, format: "groups", pointsWin: "3", pointsDraw: "1", pointsLoss: "0",
  groupCount: "2", groupAdvance: "1", playoffFormat: "single_elimination", roundHours: "24",
});
assert.equal(gr.ok, "tournament_created", gr.location);
const grSlug = gr.path.split("/").pop();
const grId = uuidAfter((await org.get(gr.path)).text, "tournament");
assert.equal((await org.post("tournament.create", { ...roundsBase, name: `E2E Groups Bad ${RUN}`, format: "groups", groupCount: "4", groupAdvance: "2", maxParticipants: "6" })).e, "stage_too_few");
for (const to of ["PUBLISHED", "REGISTRATION_OPEN"]) assert.equal((await org.post("tournament.transition", { tournament: grId, to })).ok, "status_changed");
for (const p of players) assert.equal((await p.post("tournament.register", { tournament: grId })).ok, "registered");
const grPreview = (await guest.get(`/ru/tournaments/${grSlug}`)).text;
assert.ok(grPreview.includes("Группа A") && grPreview.includes("Группа B") && grPreview.includes("Затем плей-офф"), "group composition preview");
assert.ok((await org.get(gr.path)).text.includes("Матчей в группах"), "group structure preview for the organiser");
for (const to of ["REGISTRATION_CLOSED", "IN_PROGRESS"]) assert.equal((await org.post("tournament.transition", { tournament: grId, to })).ok, "status_changed");
assert.ok((await org.get(gr.path)).text.includes("Пересоздать группы"), "groups can be rebuilt before results");
const grMatch = /\/ru\/matches\/([0-9a-f-]{36})/.exec((await org.get(gr.path)).text)?.[1];
assert.ok((await guest.get(`/ru/matches/${grMatch}`)).text.includes("Группа "), "group match labelled with its group");
const grPasses = await playOut(players, 60);
const grPage = (await guest.get(`/ru/tournaments/${grSlug}`)).text;
assert.ok(grPage.includes("Группы + плей-офф") && grPage.includes("Завершён") && grPage.includes("Плей-офф") && grPage.includes("Финал") && grPage.includes("MV-STAGES-1"), "groups then playoff, completed");
assert.ok(grPage.includes("Таблица основного этапа"), "final places with the main-stage table");
const finalId = [...grPage.matchAll(/\/ru\/matches\/([0-9a-f-]{36})/g)].map((m) => m[1]).pop();
assert.ok((await guest.get(`/ru/matches/${finalId}`)).text.includes("Плей-офф · Финал"), "playoff match labelled");
log(`groups → playoff for 5 entrants played in ${grPasses} passes; snake groups, automatic playoff, final places`);

// ---------- A chain of stages: Swiss → round robin → playoff (MV-STAGES-2) ----------
assert.equal((await org.post("tournament.create", { ...roundsBase, name: `E2E Chain Gap ${RUN}`, format: "swiss", stage3Format: "groups" })).e, "invalid_stage_settings", "a stage after a gap is refused");
const chain = await org.post("tournament.create", {
  ...roundsBase, name: `E2E Chain ${RUN}`, format: "swiss", swissRounds: "2",
  stage2Format: "round_robin", stage2Size: "4", playoffFormat: "single_elimination", playoffSize: "2",
});
assert.equal(chain.ok, "tournament_created", chain.location);
const chainSlug = chain.path.split("/").pop();
const chainId = uuidAfter((await org.get(chain.path)).text, "tournament");
for (const to of ["PUBLISHED", "REGISTRATION_OPEN"]) assert.equal((await org.post("tournament.transition", { tournament: chainId, to })).ok, "status_changed");
for (const p of players) assert.equal((await p.post("tournament.register", { tournament: chainId })).ok, "registered");
assert.ok((await org.get(chain.path)).text.includes("Этап 2"), "the organiser's structure preview lists the chained stage");
assert.ok((await guest.get(`/ru/tournaments/${chainSlug}`)).text.includes("Следующие этапы"), "the public preview names the further stages");
for (const to of ["REGISTRATION_CLOSED", "IN_PROGRESS"]) assert.equal((await org.post("tournament.transition", { tournament: chainId, to })).ok, "status_changed");
const chainPasses = await playOut(players, 80);
const chainPage = (await guest.get(`/ru/tournaments/${chainSlug}`)).text;
assert.ok(chainPage.includes("Завершён") && chainPage.includes("Этап 2 · Круговая система") && chainPage.includes("Плей-офф") && chainPage.includes("MV-STAGES-2"), "three stages played to the end");
assert.ok(chainPage.includes("Таблицы этапов"), "final places with every stage's table");
const chainMatches = [...chainPage.matchAll(/\/ru\/matches\/([0-9a-f-]{36})/g)].map((m) => m[1]);
const chainLabels = await Promise.all(chainMatches.map(async (id) => (await guest.get(`/ru/matches/${id}`)).text));
assert.ok(chainLabels.some((t) => t.includes("Этап 2 · Тур 1")), "a chained-stage match is labelled with its stage");
assert.ok((await guest.get(`/en/tournaments/${chainSlug}`)).text.includes("Stage 2 · Round robin"), "English page names the stage");
log(`chain Swiss → round robin → playoff for 5 entrants played in ${chainPasses} passes; each stage from the table before it, places by stage`);

const gt = await org.post("tournament.create", { org: orgId, name: `E2E Gauntlet ${RUN}`, game: "cs2", format: "gauntlet", participantType: "solo", teamSize: "5", maxParticipants: "8", startsAt: tomorrow, tz: "Asia/Dubai", description: "e2e", rules: "bo1" });
assert.equal(gt.ok, "tournament_created", gt.location);
const gtSlug = gt.path.split("/").pop();
const gtId = uuidAfter((await org.get(gt.path)).text, "tournament");
for (const to of ["PUBLISHED", "REGISTRATION_OPEN"]) assert.equal((await org.post("tournament.transition", { tournament: gtId, to })).ok, "status_changed");
for (const p of players.slice(0, 4)) assert.equal((await p.post("tournament.register", { tournament: gtId })).ok, "registered");
assert.ok((await guest.get(`/ru/tournaments/${gtSlug}`)).text.includes("Ступень 1"), "gauntlet preview");
for (const to of ["REGISTRATION_CLOSED", "IN_PROGRESS"]) assert.equal((await org.post("tournament.transition", { tournament: gtId, to })).ok, "status_changed");
const gtPasses = await playOut(players.slice(0, 4), 40);
const gtPage = (await guest.get(`/ru/tournaments/${gtSlug}`)).text;
assert.ok(gtPage.includes("Лесенка") && gtPage.includes("Завершён") && gtPage.includes("Ступень 2"), "gauntlet completed");
log(`gauntlet for 4 entrants played in ${gtPasses} passes`);

// ---------- Registration review, questions, templates, FFA lobbies ----------
const ap = await org.post("tournament.create", {
  org: orgId, name: `E2E Approval ${RUN}`, game: "cs2", format: "single_elimination", participantType: "solo", teamSize: "5", maxParticipants: "8",
  startsAt: tomorrow, tz: "Asia/Dubai", description: "e2e", rules: "bo1", registrationFields: "1", approvalRequired: "on",
  field1Label: "Discord", field1Type: "text", field1Required: "on", noShowMinutes: "10",
});
assert.equal(ap.ok, "tournament_created", ap.location);
const apSlug = ap.path.split("/").pop();
const apId = uuidAfter((await org.get(ap.path)).text, "tournament");
for (const to of ["PUBLISHED", "REGISTRATION_OPEN"]) assert.equal((await org.post("tournament.transition", { tournament: apId, to })).ok, "status_changed");
assert.ok((await players[0].get(`/ru/tournaments/${apSlug}`)).text.includes("Discord"), "the question is shown in the form");
assert.equal((await players[0].post("tournament.register", { tournament: apId })).e, "invalid_answers", "a required answer is enforced");
assert.equal((await players[0].post("tournament.register", { tournament: apId, answer_f1: "e2e#1" })).ok, "registration_pending");
assert.equal((await players[1].post("tournament.register", { tournament: apId, answer_f1: "e2e#2" })).ok, "registration_pending");
const apManage = (await org.get(ap.path)).text;
assert.ok(apManage.includes("e2e#1") && apManage.includes("Заявок ждут решения: 2"), "answers and pending applications for the organiser");
assert.ok(!(await guest.get(`/ru/tournaments/${apSlug}`)).text.includes("e2e#1"), "answers are not public");
const regIds = [...apManage.matchAll(/name="registration" value="([0-9a-f-]{36})"/g)].map((m) => m[1]);
assert.equal((await org.post("tournament.approve", { tournament: apId, registration: regIds[0] })).ok, "registration_approved");
assert.equal((await org.post("tournament.reject", { tournament: apId, registration: [...new Set(regIds)].find((id) => id !== regIds[0]), reason: "Duplicate account" })).ok, "registration_rejected");
const rejectedView = (await players[0].get(`/ru/tournaments/${apSlug}`)).text + (await players[1].get(`/ru/tournaments/${apSlug}`)).text;
assert.ok(rejectedView.includes("Duplicate account"), "the applicant sees the reason");
const tpl = await org.post("template.save", { tournament: apId, name: `E2E Template ${RUN}`, category: "Weekly" });
assert.equal(tpl.ok, "template_saved", tpl.location);
const spacePage = (await org.get(space.path)).text;
assert.ok(spacePage.includes(`E2E Template ${RUN}`) && spacePage.includes("Weekly"), "template listed with its category");
const templateId = /name="template" value="([0-9a-f-]{36})"/.exec(spacePage)?.[1];
const fromTpl = await org.post("template.create", { template: templateId, name: `E2E From Template ${RUN}`, startsAt: "", tz: "Asia/Dubai" });
assert.equal(fromTpl.ok, "tournament_created", fromTpl.location);
assert.ok((await org.get(fromTpl.path)).text.includes("Discord"), "the template carries the registration question");
log("registration review with a required question, approval and rejection with a reason, template saved and used");

const ffaT = await org.post("tournament.create", {
  org: orgId, name: `E2E FFA ${RUN}`, game: "pubg", format: "ffa", participantType: "solo", teamSize: "5", maxParticipants: "16",
  startsAt: tomorrow, tz: "Asia/Dubai", description: "e2e", rules: "squads off", formatSettings: "1", lobbySize: "8", ffaGames: "2", ffaAdvance: "4", ffaPoints: "10, 6, 5, 4, 3", killPoints: "1",
});
assert.equal(ffaT.ok, "tournament_created", ffaT.location);
const ffaSlug = ffaT.path.split("/").pop();
const ffaId = uuidAfter((await org.get(ffaT.path)).text, "tournament");
for (const to of ["PUBLISHED", "REGISTRATION_OPEN"]) assert.equal((await org.post("tournament.transition", { tournament: ffaId, to })).ok, "status_changed");
for (const p of players) assert.equal((await p.post("tournament.register", { tournament: ffaId })).ok, "registered");
assert.ok((await guest.get(`/ru/tournaments/${ffaSlug}`)).text.includes("Финальное лобби"), "lobby preview");
for (const to of ["REGISTRATION_CLOSED", "IN_PROGRESS"]) assert.equal((await org.post("tournament.transition", { tournament: ffaId, to })).ok, "status_changed");
const lobbyId = /\/ru\/lobbies\/([0-9a-f-]{36})/.exec((await guest.get(`/ru/tournaments/${ffaSlug}`)).text)?.[1];
assert.ok(lobbyId, "lobby linked from the tournament");
assert.ok((await players[0].get("/ru/hub")).text.includes(`/ru/lobbies/${lobbyId}`), "the lobby is in the player's hub");
assert.equal((await org.post("lobby.details", { lobby: lobbyId, roomCode: "E2E-CODE", scheduledAt: "", tz: "Asia/Dubai" })).ok, "saved");
assert.ok((await players[0].get(`/ru/lobbies/${lobbyId}`)).text.includes("E2E-CODE"), "entrants see the lobby code");
assert.ok(!(await guest.get(`/ru/lobbies/${lobbyId}`)).text.includes("E2E-CODE"), "the code is hidden from others");
for (let game = 0; game < 2; game++) {
  const lobbyPage = (await org.get(`/ru/lobbies/${lobbyId}`)).text;
  // The first game still waiting for a result (a recorded game's form also carries "correction").
  const gameId = [...lobbyPage.matchAll(/name="game" value="([0-9a-f-]{36})"(\/?>\s*<input type="hidden" name="correction")?/g)].find((m) => !m[2])?.[1];
  const regs = [...new Set([...lobbyPage.matchAll(/name="place_([0-9a-f-]{36})"/g)].map((m) => m[1]))];
  assert.equal(regs.length, 5);
  const fields = { game: gameId };
  regs.forEach((reg, i) => {
    fields[`place_${reg}`] = String(((i + game) % 5) + 1);
    fields[`kills_${reg}`] = String(i);
  });
  assert.equal((await org.post("lobby.result", fields)).ok, "lobby_result_saved");
}
const ffaPage = (await guest.get(`/ru/tournaments/${ffaSlug}`)).text;
assert.ok(ffaPage.includes("FFA (лобби)") && ffaPage.includes("Завершён") && ffaPage.includes("MV-FFA-1"), "FFA completed with its rules");
assert.ok(/class="place">1</.test(ffaPage), "FFA places published");
log("FFA: one lobby of five, code visible to entrants only, two games recorded by the referee, places from the lobby table");

// ---------- Series by level, admission, venues and waves, ratings, history ----------
const sr = await org.post("tournament.create", {
  org: orgId, name: `E2E Series Cup ${RUN}`, game: "cs2", format: "single_elimination", participantType: "solo", teamSize: "5", maxParticipants: "8",
  startsAt: tomorrow, tz: "Asia/Dubai", description: "e2e", rules: "bo3 final",
  seriesFields: "1", seriesBestOf: "1", seriesFinal: "3", admissionFields: "1", admissionMatches: "1", matchMinutes: "45",
});
assert.equal(sr.ok, "tournament_created", sr.location);
const srSlug = sr.path.split("/").pop();
const srId = uuidAfter((await org.get(sr.path)).text, "tournament");
for (const to of ["PUBLISHED", "REGISTRATION_OPEN"]) assert.equal((await org.post("tournament.transition", { tournament: srId, to })).ok, "status_changed");
const newcomer = await signup("newbie");
assert.equal((await newcomer.post("tournament.register", { tournament: srId })).e, "admission_matches", "a newcomer without confirmed matches is not admitted");
assert.ok((await newcomer.get(`/ru/tournaments/${srSlug}`)).text.includes("Допуск"), "admission criteria shown with the registration");
for (const p of players.slice(0, 4)) assert.equal((await p.post("tournament.register", { tournament: srId })).ok, "registered");
for (const name of ["Stage A", "Stage B"]) assert.equal((await org.post("tournament.venue_add", { tournament: srId, name, kind: "stage" })).ok, "venue_added");
for (const to of ["REGISTRATION_CLOSED", "IN_PROGRESS"]) assert.equal((await org.post("tournament.transition", { tournament: srId, to })).ok, "status_changed");
const waveAt = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 16);
assert.equal((await org.post("tournament.waves", { tournament: srId, round: "1:W:1", at: waveAt, tz: "Asia/Dubai" })).ok, "waves_scheduled");
const srManage = (await org.get(sr.path)).text;
assert.ok(srManage.includes("Площадки и расписание") && srManage.includes("Stage B"), "venues and the schedule on the management page");
const semi = /\/ru\/matches\/([0-9a-f-]{36})/.exec(srManage)?.[1];
assert.ok((await guest.get(`/ru/matches/${semi}`)).text.includes("Площадка"), "the match shows its venue");
assert.equal((await org.post("match.format", { match: semi, series: "3", back: `/ru/matches/${semi}` })).ok, "match_format_saved");
assert.equal((await org.post("match.official", { match: semi, scoreA: "16", scoreB: "10", back: `/ru/matches/${semi}` })).e, "invalid_series_score", "a Bo3 needs a series score");
const srPasses = await playOut(players.slice(0, 4));
const srPage = (await guest.get(`/ru/tournaments/${srSlug}`)).text;
assert.ok(srPage.includes("Завершён") && srPage.includes("Формат серий и очки") && srPage.includes("MV-SERIES-1") && srPage.includes("Bo3"), "series rules published and applied");
assert.equal((await players[0].post("tournament.rate", { tournament: srId, rating: "5", comment: "E2E smooth event" })).ok, "feedback_saved");
assert.equal((await newcomer.post("tournament.rate", { tournament: srId, rating: "1" })).e, "feedback_closed", "only roster players rate");
assert.ok((await guest.get(`/ru/tournaments/${srSlug}`)).text.includes("Оценка участников"), "the rating is public as an average");
const srAfter = (await org.get(sr.path)).text;
assert.ok(srAfter.includes("E2E smooth event") && srAfter.includes("История турнира"), "comments and history for the organiser");
assert.ok(!(await guest.get(`/ru/tournaments/${srSlug}`)).text.includes("E2E smooth event"), "comments are not public");
log(`series by level (Bo3 final, a referee's Bo3 override), admission by matches, venues in waves, ratings and history in ${srPasses} passes`);

const profile = (await guest.get(`/ru/players/${players[0].username}`)).text;
assert.ok(profile.includes("Игровой паспорт") && profile.includes("Репутация"), "profile shows passport and reputation");

// ---------- Teams ----------
const team = await players[0].post("team.create", { name: `E2E Team ${RUN}`, tag: "E2E", game: "cs2" });
assert.equal(team.ok, "team_created");
const teamId = uuidAfter((await players[0].get(team.path)).text, "team");
assert.equal((await players[0].post("team.invite", { team: teamId, username: players[1].username })).ok, "invite_sent");
const inviteId = uuidAfter((await players[1].get("/ru/hub")).text, "invite");
assert.ok(inviteId, "invite visible in hub");
assert.equal((await players[1].post("team.respond", { invite: inviteId, accept: "1" })).ok, "joined_team");
assert.equal((await players[1].post("team.media", { team: teamId })).e, "not_team_leader", "only leaders change team media");
log("team created, invitation accepted from hub, media restricted to leaders");

// ---------- Transfer between two teams of one game ----------
const rival = await players[2].post("team.create", { name: `E2E Rival ${RUN}`, tag: "RIV", game: "cs2" });
assert.equal(rival.ok, "team_created");
const rivalId = uuidAfter((await players[2].get(rival.path)).text, "team");
assert.equal((await players[2].post("transfer.propose", { team: rivalId, username: players[1].username, note: "e2e", back: rival.path })).ok, "transfer_proposed");
const offerPage = (await players[1].get(rival.path)).text;
const transferId = uuidAfter(offerPage, "transfer");
assert.ok(transferId, "the player sees the offer on the receiving team's page");
assert.equal((await players[1].post("transfer.answer", { transfer: transferId, answer: "accept", back: rival.path })).ok, "transfer_agreed");
assert.equal((await players[0].post("transfer.answer", { transfer: transferId, answer: "accept", back: team.path })).ok, "transfer_completed");
const rivalPage = (await guest.get(rival.path)).text;
assert.ok(rivalPage.includes("перешёл в команду") && !rivalPage.includes("e2e</p>"), "public roster history shows the move, not the negotiation note");
log("transfer: proposed, agreed by the player and the releasing team, roster history public");

// ---------- Clans and a clan war ----------
const uuidsAfter = (html, name) => [...html.matchAll(new RegExp(`name="${name}" value="([0-9a-f-]{36})"`, "g"))].map((m) => m[1]);
const tagA = `A${RUN.slice(-4).toUpperCase()}`;
const tagB = `B${RUN.slice(-4).toUpperCase()}`;
const clanA = await players[0].post("clan.create", { name: `E2E Clan A ${RUN}`, tag: tagA, description: "e2e", back: "/ru/clans" });
assert.equal(clanA.ok, "clan_created", clanA.location);
const clanAPage = (await players[0].get(clanA.path)).text;
const clanAId = uuidAfter(clanAPage, "clan");
assert.equal((await players[0].post("clan.invite", { clan: clanAId, username: players[1].username, back: clanA.path })).ok, "clan_invited");
const clanInvite = uuidAfter((await players[1].get("/ru/clans")).text, "invite");
assert.ok(clanInvite, "the invitation is listed on /clans");
assert.equal((await players[1].post("clan.respond", { invite: clanInvite, accept: "1", back: "/ru/clans" })).ok, "clan_joined");
const clanB = await players[2].post("clan.create", { name: `E2E Clan B ${RUN}`, tag: tagB, description: "", back: "/ru/clans" });
assert.equal(clanB.ok, "clan_created");
const clanBId = uuidAfter((await players[2].get(clanB.path)).text, "clan");
assert.equal((await players[2].post("clan.invite", { clan: clanBId, username: players[3].username, back: clanB.path })).ok, "clan_invited");
assert.equal((await players[3].post("clan.respond", { invite: uuidAfter((await players[3].get("/ru/clans")).text, "invite"), accept: "1" })).ok, "clan_joined");
// The challenge form lists the clan's players as lineup choices.
const lineupA = uuidsAfter((await players[0].get(clanA.path)).text, "lineup").slice(0, 2);
assert.equal(lineupA.length, 2, "two lineup choices for the challenger");
const startAt = new Date(Date.now() + 30 * 60_000).toISOString().slice(0, 16);
const proposal = { clan: clanAId, opponent: tagB, game: "cs2", size: "2", bestOf: "3", at: startAt, tz: "UTC", message: "e2e war", back: clanA.path };
assert.equal((await players[0].post("war.propose", { ...proposal, lineup: [lineupA[0]] })).e, "war_lineup", "a lineup has exactly the chosen size");
assert.equal((await players[1].post("war.propose", { ...proposal, lineup: lineupA })).e, "not_clan_leader");
assert.equal((await players[0].post("war.propose", { ...proposal, lineup: lineupA })).ok, "war_proposed");
const bPage = (await players[2].get(clanB.path)).text;
const warId = uuidAfter(bPage, "war");
assert.ok(warId, "the challenged clan sees the war");
const lineupB = uuidsAfter(bPage, "lineup").slice(0, 2);
assert.equal((await players[2].post("war.answer", { war: warId, answer: "accept", lineup: lineupB, back: clanB.path })).ok, "war_accepted");
assert.equal((await players[0].post("war.report", { war: warId, mine: "2", theirs: "0", back: clanA.path })).e, "war_not_started", "the score waits for the start");
assert.equal((await players[2].post("war.cancel", { war: warId, back: clanB.path })).ok, "war_cancelled");
const publicClan = (await guest.get(clanA.path)).text;
assert.ok(publicClan.includes(`E2E Clan B ${RUN}`) && !publicClan.includes("e2e war"), "the war is public, the challenge message is for the clans' leaders");
assert.ok((await guest.get(`/ru/clans?q=${tagA}`)).text.includes(`E2E Clan A ${RUN}`));
assert.equal((await guest.get("/ru/ladders?game=cs2")).status, 200);
log("clans: created, invitation accepted, war proposed with lineups, accepted, score refused before the start, called off; ladders page");

// ---------- Challenges, quick match, objectives ----------
const [a, b, c3, d4] = players;
assert.equal((await a.post("challenge.create", { opponent: b.username, game: "cs2", message: "gg" })).ok, "challenge_sent");
const bChallenges = (await b.get("/ru/challenges")).text;
const chId = uuidAfter(bChallenges, "challenge");
assert.ok(chId, "challenge visible to the opponent");
assert.equal((await b.post("challenge.respond", { challenge: chId, accept: "1", back: "/ru/challenges" })).ok, "saved");
assert.equal((await a.post("challenge.report", { challenge: chId, result: "won", myScore: "2", theirScore: "0", back: "/ru/challenges" })).ok, "result_submitted");
assert.equal((await a.post("challenge.confirm", { challenge: chId, back: "/ru/challenges" })).e !== null, true, "the reporter cannot confirm their own result");
assert.equal((await b.post("challenge.confirm", { challenge: chId, back: "/ru/challenges" })).ok, "result_confirmed");
// A game nobody waits for in this database, so the pairing below is between these two players only.
const queuePage = (await c3.get("/ru/matchmaking")).text;
const quickGame = [...queuePage.matchAll(/<option value="([a-z0-9-]+)"[^>]*>(.*?)<\/option>/gs)].find(([, , label]) => !label.includes("ждут"))?.[1];
assert.ok(quickGame, "a game with an empty queue");
const q1 = await c3.post("quick.join", { game: quickGame });
assert.equal(q1.ok, "quick_queued");
const q2 = await d4.post("quick.join", { game: quickGame });
assert.equal(q2.ok, "quick_ready_check", "a second real player is found; both confirm before the match exists");
const checkPage = (await c3.get("/ru/matchmaking")).text;
const readyCheckId = uuidAfter(checkPage, "check");
assert.ok(readyCheckId && checkPage.includes("подтвердите готовность"), "the ready check is shown with its buttons");
assert.equal((await c3.post("quick.ready", { check: readyCheckId })).ok, "quick_ready");
assert.equal((await d4.post("quick.ready", { check: readyCheckId })).ok, "quick_matched", "the last confirmation creates the match");
assert.equal((await c3.post("quick.ready", { check: readyCheckId })).e, "ready_check_closed");
// Party: invitation, leader-only search, the whole party leaves the queue when a member cancels.
assert.equal((await a.post("party.create", { game: "cs2" })).ok, "party_created");
assert.equal((await a.post("party.invite", { username: b.username })).ok, "party_invited");
const partyInvite = uuidAfter((await b.get("/ru/matchmaking")).text, "invite");
assert.ok(partyInvite, "the invitation is shown to the invited player");
assert.equal((await b.post("party.respond", { invite: partyInvite, accept: "1" })).ok, "party_joined");
assert.equal((await b.post("quick.join", { game: "cs2" })).e, "not_party_leader");
assert.equal((await a.post("quick.join", { game: "cs2", region: "MENA" })).ok, "quick_queued");
assert.ok((await b.get("/ru/matchmaking")).text.includes("Группа в очереди"), "every member sees the party queued");
assert.equal((await b.post("quick.leave", {})).ok, "quick_left");
assert.equal((await a.post("party.leave", {})).ok, "party_disbanded");
assert.equal((await a.post("objective.claim", { objective: "first_challenge", back: "/ru/progress" })).ok, "reward_claimed");
assert.equal((await a.post("objective.claim", { objective: "first_challenge", back: "/ru/progress" })).e, "already_claimed");
assert.equal((await b.post("shop.buy", { item: "ivory", back: "/ru/progress" })).e, "insufficient_coins");
log("1v1 challenge with confirmation, quick match with a ready check, a party queued and cancelled, objectives paid once, coins cannot overspend");

// ---------- Membership (no payment configured in this run) ----------
const applied = await b.post("membership.apply", { offer: "vegas-membership", objective: "Premium pass", back: "/ru/membership" });
assert.equal(applied.path, "/ru/billing");
const ref = applied.url.searchParams.get("ref");
assert.match(ref ?? "", /^MV-M-\d{4}-\d{5}$/);
assert.ok((await b.get("/ru/billing")).text.includes(ref), "reference shown in the workspace");
assert.equal((await b.post("membership.apply", { offer: "vegas-membership", back: "/ru/membership" })).e, "application_exists");
const fakeInvoice = "00000000-0000-4000-8000-000000000000";
const noCheckout = await b.post("billing.checkout", { invoice: fakeInvoice, accept: "on", back: "/ru/billing" });
assert.ok(["email_not_verified", "not_found"].includes(noCheckout.e), `no checkout without an own invoice and a confirmed email: ${noCheckout.e}`);
assert.ok(!noCheckout.location.startsWith("http"), "no redirect to a payment page");
assert.equal((await b.get("/ru/billing/invoices/MV-INV-2026-99999")).status, 404, "unknown or foreign invoices are not found");
const bill = (await b.get("/ru/billing")).text;
const appId = uuidAfter(bill, "application");
assert.equal((await b.post("membership.withdraw", { application: appId, back: "/ru/billing" })).ok, "saved");
log("membership application with a real reference, duplicate refused, no checkout without an invoice, withdrawal");

// ---------- Data rights and access control ----------
const exp = await fetch(`${BASE}/api/account/export`, { headers: { cookie: b.cookie } });
assert.equal(exp.status, 200);
const data = await exp.json();
assert.equal(data.profile.username, b.username);
assert.ok(Array.isArray(data.consents) && data.consents.some((x) => x.kind === "terms"), "consents exported");
assert.ok((await b.get("/ru/admin")).text.includes("только сотрудникам"));
assert.equal((await b.post("billing.decide", { application: appId, status: "approved", note: "x" })).e, "forbidden");
log("data export and admin access control");

if (process.env.OWNER_CODE) {
  const claim = await org.post("account.claim_admin", { token: process.env.OWNER_CODE });
  assert.equal(claim.ok, "admin_granted", claim.location);
  const gate = await org.get("/ru/admin");
  assert.equal(gate.status, 307, "control centre requires a second factor");
  assert.ok(gate.location.endsWith("/ru/admin/security"));
  assert.equal((await org.post("outbox.drain", {})).path, "/ru/admin/security", "staff actions are blocked before enrolment");
  assert.equal((await org.post("mfa.start", { back: "/ru/admin/security" })).path, "/ru/admin/security");
  const sec = (await org.get("/ru/admin/security")).text;
  const secret = /<code class="mono secret">([A-Z2-7 ]+)<\/code>/.exec(sec)?.[1];
  assert.ok(secret, "enrolment key shown");
  assert.equal((await org.post("mfa.confirm", { code: "000000", back: "/ru/admin/security" })).e, "mfa_invalid");
  const confirmed = await org.post("mfa.confirm", { code: totp(secret), back: "/ru/admin/security" });
  assert.equal(confirmed.ok, "mfa_enrolled", confirmed.location);
  const codes = (await org.get("/ru/admin/security")).text;
  assert.ok(/[A-Z2-7]{5}-[A-Z2-7]{5}/.test(codes), "recovery codes shown once");
  await org.post("mfa.codes_saved", {});
  assert.ok(!/[A-Z2-7]{5}-[A-Z2-7]{5}<\/li>/.test((await org.get("/ru/admin/security")).text), "recovery codes are not shown again");
  for (const tab of ["overview", "users", "disputes", "challenges", "conduct", "applications", "venues", "memberships", "offers", "payments", "outbox", "messages", "tournaments", "sponsors", "system", "security", "audit"]) {
    const r = await org.get(`/ru/admin?tab=${tab}`);
    assert.equal(r.status, 200, `admin tab ${tab}`);
  }
  // Since C-33 the full SHA-256 verification runs on request.
  const audit = (await org.get("/ru/admin?tab=audit&verify=1")).text;
  assert.ok(audit.includes("Цепочка целостна") && !audit.includes("Нарушение целостности"), "audit chain verified");
  const payments = (await org.get("/ru/admin?tab=payments")).text;
  assert.ok(payments.includes("Оплаты выключены"), "readiness explains why collection is off");
  log("owner code grants admin once; second factor enrolled with TOTP; recovery codes shown once; all control-centre tabs render");

  // ---------- Fair play: report → sanction with evidence → restricted account → appeal waiting for another reviewer ----------
  assert.equal(
    (await c3.post("conduct.report", { username: d4.username, rule: "CHEATING", context: "/ru/matchmaking", description: "e2e: стороннее ПО видно на записи матча." })).ok,
    "report_filed",
  );
  const conductQueuePage = (await org.get("/ru/admin?tab=conduct")).text;
  const subjectAt = conductQueuePage.indexOf(d4.username);
  const reportId = subjectAt >= 0 ? uuidAfter(conductQueuePage.slice(subjectAt), "report") : undefined;
  assert.ok(reportId, "the report is in the staff queue");
  const sanctioned = await org.post("conduct.sanction", {
    report: reportId,
    username: d4.username,
    kind: "suspension",
    confidence: "high",
    days: "3",
    rule: "CHEATING",
    evidence: "/ru/matchmaking — e2e запись матча",
    decision: "e2e: подтверждено записью матча и журналом.",
  });
  assert.equal(sanctioned.ok, "sanction_issued", sanctioned.location);
  assert.equal((await d4.post("quick.join", { game: "cs2" })).e, "account_restricted", "a suspended account cannot act");
  const conductPage = (await d4.get("/ru/conduct")).text;
  const sanctionId = uuidAfter(conductPage, "sanction");
  assert.ok(sanctionId && conductPage.includes("Ограничение аккаунта") && conductPage.includes("e2e: подтверждено"), "the player sees rule, decision and term");
  assert.equal((await d4.post("conduct.appeal", { sanction: sanctionId, statement: "e2e: запись не моя, прошу проверить заново." })).ok, "appeal_filed", "appealing stays possible");
  assert.ok((await org.get("/ru/admin?tab=conduct")).text.includes("апелляцию рассматривает другой сотрудник"), "the issuer does not decide the appeal");
  assert.ok((await c3.get("/ru/conduct")).text.includes("меры приняты"), "the reporter sees the outcome only");
  const trustPage = (await guest.get("/ru/trust")).text;
  assert.ok(trustPage.includes("Отчётность за 90 дней") && trustPage.includes("CHEATING") && !trustPage.includes(d4.username), "the trust page shows rules and counts, no names");
  log("fair play: report, sanction with rule and evidence, restricted account can only appeal, appeal left to another reviewer, public counts without names");

  // ---------- Venues: confirmation before publication; a QR pass admits once ----------
  const venuesPath = `${space.path}/venues`;
  const venueMade = await org.post("venue.create", { org: orgId, name: `E2E Hall ${RUN}`, kind: "club", address: "E2E street 1, floor 2", city: "Dubai", country: "AE", description: "e2e", website: "", back: venuesPath });
  assert.equal(venueMade.ok, "venue_created", venueMade.location);
  const venuesPage = (await org.get(venuesPath)).text;
  const venueId = uuidAfter(venuesPage, "venue");
  const venueSlug = /\/ru\/venues\/([a-z0-9-]+)/.exec(venuesPage)?.[1];
  assert.ok(venueId && venueSlug);
  assert.equal((await guest.get(`/ru/venues/${venueSlug}`)).status, 404, "a draft venue is not public");
  assert.equal((await org.post("venue.submit", { venue: venueId, back: venuesPath })).ok, "venue_submitted");
  assert.ok((await org.get("/ru/admin?tab=venues")).text.includes(`E2E Hall ${RUN}`), "the venue waits in the staff queue");
  assert.equal((await org.post("venue.review", { venue: venueId, decision: "confirm", note: "", version: "0" })).ok, "venue_reviewed");
  assert.equal((await guest.get(`/ru/venues/${venueSlug}`)).status, 200);
  assert.ok((await guest.get("/ru/venues")).text.includes(`E2E Hall ${RUN}`), "the confirmed venue is in the catalog");
  const passFrom = new Date(Date.now() - 60_000).toISOString().slice(0, 16);
  const passUntil = new Date(Date.now() + 3_600_000).toISOString().slice(0, 16);
  assert.equal((await org.post("pass.guest", { venue: venueId, username: c3.username, from: passFrom, until: passUntil, tz: "UTC", note: "e2e", back: venuesPath })).ok, "pass_issued");
  const passesPage = (await c3.get("/ru/passes")).text;
  const passToken = /\/ru\/pass\/([A-Za-z0-9_-]{32})/.exec(passesPage)?.[1];
  assert.ok(passesPage.includes("<svg") && passToken, "the holder sees the QR and its link");
  assert.ok(!(await guest.get(`/ru/pass/${passToken}`)).text.includes(c3.username), "a stranger sees no holder details");
  const scanView = (await org.get(`/ru/pass/${passToken}`)).text;
  assert.ok(scanView.includes(c3.username) && scanView.includes("Пропустить"), "the venue's staff see the holder and the admit button");
  assert.equal((await b.post("pass.admit", { token: passToken, back: `/ru/pass/${passToken}` })).e, "forbidden", "only the venue's staff admit");
  assert.equal((await org.post("pass.admit", { token: passToken, back: `/ru/pass/${passToken}` })).ok, "pass_admitted");
  assert.equal((await org.post("pass.admit", { token: passToken, back: `/ru/pass/${passToken}` })).e, "pass_used", "a reused QR is refused");
  assert.ok((await org.get(venuesPath)).text.includes("уже использован"), "the refused scan is in the venue's log");
  log("venues: a draft is hidden, staff confirm it, the catalog lists it; a guest pass shows a QR, admits once; a reuse and an outsider are refused");

  // ---------- Staff roles: a marketing role sees only its sections; messages respect consent and the frequency cap ----------
  const usersTab = (await org.get(`/ru/admin?tab=users&q=${b.username}`)).text;
  const bId = uuidAfter(usersTab.slice(usersTab.indexOf(b.username)), "user");
  assert.ok(bId, "the player is found in the users tab");
  assert.equal((await org.post("admin.role", { user: bId, role: "marketing", grant: "1", back: "/ru/admin?tab=users" })).ok, "saved");
  assert.equal((await b.post("mfa.start", { back: "/ru/admin/security" })).path, "/ru/admin/security");
  const bSecret = /<code class="mono secret">([A-Z2-7 ]+)<\/code>/.exec((await b.get("/ru/admin/security")).text)?.[1];
  assert.ok(bSecret, "the new staff member enrols a second factor");
  assert.equal((await b.post("mfa.confirm", { code: totp(bSecret), back: "/ru/admin/security" })).ok, "mfa_enrolled");
  await b.post("mfa.codes_saved", {});
  const bAdmin = (await b.get("/ru/admin")).text;
  assert.ok(bAdmin.includes("tab=messages") && bAdmin.includes("tab=sponsors"), "marketing sees its sections");
  for (const hidden of ["tab=payments", "tab=system", "tab=conduct", "tab=users", "tab=audit"]) assert.ok(!bAdmin.includes(hidden), `marketing does not see ${hidden}`);
  assert.ok(!(await b.get("/ru/admin?tab=payments")).text.includes("Оплаты выключены"), "a foreign tab falls back to the overview");
  assert.equal((await b.post("venue.review", { venue: venueId, decision: "suspend", note: "e2e: не должно пройти" })).e, "forbidden", "the server checks the section");
  assert.equal((await b.post("system.flag", { key: "clans", on: "0" })).e, "forbidden");
  assert.equal((await b.post("message.create", { kind: "operational", title: "Работы", body: "e2e", audience: "all", template: "0" })).e, "message_kind");
  // Recipients: c3 agreed to news, the newcomer did not; both are in the segment's country.
  assert.equal((await c3.post("account.marketing", { optIn: "1", back: "/ru/settings" })).ok, "saved");
  assert.equal((await c3.post("account.profile", { displayName: `c3 ${RUN}`, country: "", bio: "", countryCode: "IS", back: "/ru/settings" })).ok, "saved");
  assert.equal((await newcomer.post("account.country", { countryCode: "IS", back: "/ru/settings" })).ok, "saved");
  const sentIds = [];
  for (const n of [1, 2, 3]) {
    const title = `E2E анонс ${n} ${RUN}`;
    const made = await b.post("message.create", { kind: "marketing", title, body: `Текст анонса ${n}.`, audience: "all", country: "IS", template: "0", back: "/ru/admin?tab=messages" });
    assert.equal(made.ok, "message_saved", made.location);
    const tabHtml = (await b.get("/ru/admin?tab=messages")).text;
    const id = uuidAfter(tabHtml.slice(tabHtml.indexOf(title)), "message");
    assert.ok(id, `draft ${n} listed`);
    assert.equal((await b.post("message.send", { message: id, back: "/ru/admin?tab=messages" })).ok, "message_sent");
    sentIds.push(id);
  }
  assert.equal((await b.post("message.send", { message: sentIds[0], back: "/ru/admin?tab=messages" })).e, "message_state", "a message is sent once");
  const inbox = (await c3.get("/ru/notifications")).text;
  assert.ok(inbox.includes(`E2E анонс 1 ${RUN}`) && inbox.includes(`E2E анонс 2 ${RUN}`), "two marketing messages delivered");
  assert.ok(!inbox.includes(`E2E анонс 3 ${RUN}`), "the third in a week is held by the frequency cap");
  const opened = await c3.get(`/ru/messages/${sentIds[0]}`);
  assert.ok(opened.status === 200 && opened.text.includes("Текст анонса 1.") && opened.text.includes("согласились получать новости"), "the message page with the consent note");
  assert.equal((await newcomer.get(`/ru/messages/${sentIds[0]}`)).status, 404, "an account without consent did not receive it");
  const statsTab = (await b.get("/ru/admin?tab=messages")).text;
  assert.ok(statsTab.includes("лимит частоты") && statsTab.includes("без согласия") && statsTab.includes("открыли: 1"), "delivery statuses and openings are counted");
  log("staff roles: a marketing role sees only its tabs and is refused elsewhere by the server; marketing messages reach consenting accounts, two a week at most, and openings are counted");

  // ---------- Feature switch, maintenance and a staff view of a private profile ----------
  assert.equal((await org.post("system.flag", { key: "challenges", on: "0", note: "e2e" })).ok, "flag_saved");
  assert.equal((await c3.post("challenge.create", { opponent: a.username, game: "cs2", message: "" })).e, "feature_disabled");
  // Pages read the switch through a one-second cache.
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok((await c3.get("/ru/challenges")).text.includes("временно выключила"), "the page says the feature is off");
  assert.equal((await org.post("system.flag", { key: "challenges", on: "1" })).ok, "flag_saved");
  assert.equal((await org.post("system.maintenance", { on: "1", note: `E2E работы ${RUN}` })).ok, "maintenance_on");
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok((await guest.get("/ru")).text.includes(`E2E работы ${RUN}`), "every page shows the maintenance banner");
  assert.equal((await c3.post("account.marketing", { optIn: "0", back: "/ru/settings" })).e, "maintenance", "actions wait for the end of maintenance");
  assert.equal((await org.post("system.maintenance", { on: "0" })).ok, "maintenance_off");
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(!(await guest.get("/ru")).text.includes(`E2E работы ${RUN}`));
  const systemTab = (await org.get("/ru/admin?tab=system")).text;
  assert.ok(systemTab.includes("Состояние системы") && systemTab.includes("Вызовы 1v1"), "the status panel and switches render");
  assert.ok((await org.get(`/ru/players/${c3.username}`)).text.includes("вы видите его как сотрудник портала"), "a private profile opened by staff is marked");
  assert.ok((await b.get(`/ru/players/${c3.username}`)).text.includes("Игрок скрыл профиль"), "the marketing role does not open private profiles");
  assert.ok((await org.get("/ru/admin?tab=audit")).text.includes("staff.viewed"), "the view is in the log");
  log("switches: an action of a switched-off feature is refused and the page says so; maintenance shows a banner and holds actions; a staff view of a private profile is marked and logged");

  // ---------- Academy: a verified coach receives a training request in the queue ----------
  const coachForm = {
    headline: `E2E тренер ${RUN}`,
    experience: "e2e: капитан команды в лиге, 2000+ часов, разборы демо для академии.",
    bio: "",
    games: ["cs2"],
    languages: ["ru"],
    formats: ["online"],
    city: "",
    accepting: "1",
    back: "/ru/coach",
  };
  assert.equal((await c3.post("coach.save", coachForm)).ok, "coach_saved");
  assert.equal((await c3.post("coach.submit", { back: "/ru/coach" })).ok, "coach_submitted");
  assert.equal((await guest.get(`/ru/coaches/${c3.username}`)).status, 404, "an unverified coach is not public");
  const academyTab = (await org.get("/ru/admin?tab=academy")).text;
  const coachId = uuidAfter(academyTab.slice(academyTab.indexOf(c3.username)), "coach");
  assert.ok(coachId, "the coach waits in the staff queue");
  assert.equal((await org.post("coach.review", { coach: coachId, decision: "verify", note: "", back: "/ru/admin?tab=academy" })).ok, "coach_reviewed");
  assert.ok((await guest.get("/ru/coaches")).text.includes(`E2E тренер ${RUN}`), "the verified coach is in the directory");
  const requested = await newcomer.post("training.request", { coach: coachId, programme: "", game: "cs2", goal: "e2e: хочу поставить раскидки на Mirage", availability: "вечером", back: `/ru/coaches/${c3.username}` });
  assert.equal(requested.ok, "training_requested", requested.location);
  const trainingPath = requested.path;
  const coachQueuePage = (await c3.get("/ru/coach")).text;
  assert.ok(coachQueuePage.includes("e2e: хочу поставить раскидки на Mirage"), "the request is in the coach's queue");
  const requestId = uuidAfter(coachQueuePage, "request");
  assert.equal((await c3.post("training.answer", { request: requestId, decision: "accept", note: "e2e: начнём", back: "/ru/coach" })).ok, "training_answered");
  const sessionAt = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 16);
  assert.equal((await c3.post("training.session", { request: requestId, startsAt: sessionAt, tz: "UTC", minutes: "60", place: "https://meet.example.org/e2e", back: trainingPath })).ok, "session_scheduled");
  assert.equal((await c3.post("training.progress", { request: requestId, kind: "observation", body: "e2e: ранний пик на мид", timeMark: "12:34", evidence: "", metric: "", value: "", session: "", back: trainingPath })).ok, "progress_added");
  assert.equal((await newcomer.post("training.progress", { request: requestId, kind: "exercise", body: "e2e: не тренер", back: trainingPath })).e, "forbidden");
  const studentView = (await newcomer.get(trainingPath)).text;
  assert.ok(studentView.includes("e2e: ранний пик на мид") && studentView.includes("12:34") && studentView.includes("Наблюдение"), "the player sees the coach's record");
  assert.ok((await newcomer.get("/ru/calendar")).text.includes(`@${c3.username}`), "the session is in the player's calendar");
  log("academy: a coach is hidden until verified, the request reaches the coach's queue, a session is booked and an observation recorded; the player sees them");
}
console.log(`\nE2E OK against ${BASE} (run ${RUN})`);
