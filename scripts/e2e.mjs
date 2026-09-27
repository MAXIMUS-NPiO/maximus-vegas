#!/usr/bin/env node
// End-to-end check over real HTTP against a running build:
// public pages → sign-up → onboarding → team → single- and double-elimination tournaments → results →
// challenges and quick match → objectives → membership application → staff second factor (with OWNER_CODE).
// Usage: BASE=http://127.0.0.1:3100 [OWNER_CODE=…] node scripts/e2e.mjs   (creates uniquely named test records)
// Never point it at production: it creates accounts and records.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const BASE = (process.env.BASE || "http://127.0.0.1:3100").replace(/\/$/, "");
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
    const body = new URLSearchParams({ lang: "ru", back: "/ru", ...fields });
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

// ---------- Public surface ----------
const guest = new Client("guest");
const pages = ["", "/tournaments", "/games", "/games/cs2", "/rankings", "/players", "/teams", "/membership", "/matchmaking", "/challenges", "/partners", "/organizer",
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

const passes = await playOut(players.slice(0, 4));
const tPage = (await guest.get(`/ru/tournaments/${tSlug}`)).text;
assert.ok(tPage.includes("Завершён"), "tournament completed");
assert.ok(/class="place">1</.test(tPage), "standings rendered");
assert.ok((await org.get(manage)).text.includes("Не прошёл check-in"), "missed check-in recorded");
log(`single elimination played to the final in ${passes} passes; standings published`);

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
const q1 = await c3.post("quick.join", { game: "valorant" });
assert.equal(q1.ok, "quick_queued");
const q2 = await d4.post("quick.join", { game: "valorant" });
assert.equal(q2.ok, "quick_matched", "a second real player is paired instead of queued");
assert.equal((await a.post("objective.claim", { objective: "first_challenge", back: "/ru/progress" })).ok, "reward_claimed");
assert.equal((await a.post("objective.claim", { objective: "first_challenge", back: "/ru/progress" })).e, "already_claimed");
assert.equal((await b.post("shop.buy", { item: "ivory", back: "/ru/progress" })).e, "insufficient_coins");
log("1v1 challenge with confirmation, quick match pairing, objectives paid once, coins cannot overspend");

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
  for (const tab of ["overview", "users", "memberships", "offers", "payments", "outbox", "tournaments", "sponsors", "security", "audit"]) {
    const r = await org.get(`/ru/admin?tab=${tab}`);
    assert.equal(r.status, 200, `admin tab ${tab}`);
  }
  const audit = (await org.get("/ru/admin?tab=audit")).text;
  assert.ok(audit.includes("Цепочка целостна"), "audit chain verified");
  const payments = (await org.get("/ru/admin?tab=payments")).text;
  assert.ok(payments.includes("Оплаты выключены"), "readiness explains why collection is off");
  log("owner code grants admin once; second factor enrolled with TOTP; recovery codes shown once; all control-centre tabs render");
}
console.log(`\nE2E OK against ${BASE} (run ${RUN})`);
