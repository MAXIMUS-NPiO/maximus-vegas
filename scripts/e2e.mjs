#!/usr/bin/env node
// End-to-end check over real HTTP: sign-up → team → tournament → check-in → bracket → results → standings.
// Usage: BASE=http://127.0.0.1:3100 node scripts/e2e.mjs   (creates uniquely named test records)
import assert from "node:assert/strict";

const BASE = (process.env.BASE || "http://127.0.0.1:3100").replace(/\/$/, "");
const RUN = Date.now().toString(36).slice(-5);
const PASSWORD = "e2e-password-" + RUN;
const log = (...a) => console.log("•", ...a);

class Client {
  constructor(name) {
    this.name = name;
    this.cookie = "";
  }
  async get(path) {
    const res = await fetch(BASE + path, { headers: { cookie: this.cookie }, redirect: "manual" });
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
    const set = res.headers.get("set-cookie");
    if (set) {
      const m = /mv_session=([^;]*)/.exec(set);
      if (m) this.cookie = m[1] ? `mv_session=${m[1]}` : "";
    }
    const location = res.headers.get("location") || "";
    const url = new URL(location, BASE);
    return { status: res.status, location, ok: url.searchParams.get("ok"), e: url.searchParams.get("e"), path: url.pathname };
  }
}

const uuidAfter = (html, name) => {
  const m = new RegExp(`name="${name}" value="([0-9a-f-]{36})"`).exec(html);
  return m?.[1];
};

async function signup(name) {
  const c = new Client(name);
  const r = await c.post("auth.signup", {
    email: `${name}.${RUN}@example.com`,
    username: `${name}_${RUN}`,
    displayName: `${name} ${RUN}`,
    password: PASSWORD,
    adult: "on",
    terms: "on",
  });
  assert.equal(r.status, 303);
  assert.equal(r.ok, "welcome", `signup ${name}: ${r.location}`);
  assert.ok(c.cookie, "session cookie set");
  c.username = `${name}_${RUN}`;
  return c;
}

const guest = new Client("guest");
const pages = ["", "/tournaments", "/games", "/games/cs2", "/rankings", "/players", "/teams", "/partners", "/organizer", "/innovations",
  "/trust", "/help", "/contact", "/status", "/terms", "/privacy", "/explore", "/search?q=cup", "/academy", "/cloud-gaming", "/shop", "/billing", "/signin", "/signup"];
for (const lang of ["ru", "en"])
  for (const p of pages) {
    const r = await guest.get(`/${lang}${p}`);
    assert.equal(r.status, 200, `${lang}${p} → ${r.status}`);
  }
log(`public pages: ${pages.length * 2} × 200`);
assert.equal((await guest.get("/ru/hub")).status, 307, "hub redirects guests");
assert.equal((await guest.get("/xx")).status, 404);

const bad = await guest.post("application.create", { kind: "contact", name: "x", email: "x@example.com", consent: "on" }, { origin: "https://evil.example" });
assert.equal(bad.e, "bad_origin");
const app = await guest.post("application.create", { kind: "partner", name: "E2E Partner", email: `p.${RUN}@example.com`, company: "E2E", message: "test", consent: "on" });
assert.equal(app.ok, "application_received");
log("origin check and partner application queue");

const org = await signup("org");
const dup = await new Client("dup").post("auth.signup", { email: `org.${RUN}@example.com`, username: `other_${RUN}`, displayName: "Dup", password: PASSWORD, adult: "on", terms: "on" });
assert.equal(dup.e, "email_taken");
const out = await org.post("auth.signout", {});
assert.equal(out.ok, "signed_out");
const back = await org.post("auth.signin", { login: org.username, password: PASSWORD });
assert.ok(back.path.endsWith("/hub"), back.location);
log("sign-up, duplicate email, sign-out, sign-in");

const space = await org.post("org.create", { name: `E2E Series ${RUN}`, description: "e2e" });
assert.equal(space.ok, "org_created");
const spaceHtml = (await org.get(space.path)).text;
const orgId = uuidAfter(spaceHtml, "org");
assert.ok(orgId, "org id on page");
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 16);
const created = await org.post("tournament.create", {
  org: orgId, name: `E2E Cup ${RUN}`, game: "cs2", participantType: "solo", teamSize: "5", maxParticipants: "8",
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

// Play the bracket through the UI actions only.
let rounds = 0;
for (; rounds < 10; rounds++) {
  let acted = false;
  for (const p of players.slice(0, 4)) {
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
const tPage = (await guest.get(`/ru/tournaments/${tSlug}`)).text;
assert.ok(tPage.includes("Завершён"), "tournament completed");
assert.ok(/class="place">1</.test(tPage), "standings rendered");
const report = (await org.get(manage)).text;
assert.ok(report.includes("Не прошёл check-in"), "missed check-in recorded");
log(`bracket played to the final in ${rounds} passes; standings published`);

const profile = (await guest.get(`/ru/players/${players[0].username}`)).text;
assert.ok(profile.includes("Игровой паспорт"));

const team = await players[0].post("team.create", { name: `E2E Team ${RUN}`, tag: "E2E", game: "cs2" });
assert.equal(team.ok, "team_created");
const teamId = uuidAfter((await players[0].get(team.path)).text, "team");
assert.equal((await players[0].post("team.invite", { team: teamId, username: players[1].username })).ok, "invite_sent");
const inviteId = uuidAfter((await players[1].get("/ru/hub")).text, "invite");
assert.ok(inviteId, "invite visible in hub");
assert.equal((await players[1].post("team.respond", { invite: inviteId, accept: "1" })).ok, "joined_team");
log("team created, invitation accepted from hub");

const exp = await fetch(`${BASE}/api/account/export`, { headers: { cookie: players[1].cookie } });
assert.equal(exp.status, 200);
const data = await exp.json();
assert.equal(data.profile.username, players[1].username);
assert.ok((await players[1].get("/ru/admin")).text.includes("только сотрудникам"));
log("data export and admin access control");

if (process.env.OWNER_CODE) {
  const claim = await org.post("account.claim_admin", { token: process.env.OWNER_CODE });
  assert.equal(claim.ok, "admin_granted", claim.location);
  const audit = (await org.get("/ru/admin?tab=audit")).text;
  assert.ok(audit.includes("Цепочка целостна"), "audit chain verified");
  log("owner code grants admin once; audit chain verified");
}
console.log(`\nE2E OK against ${BASE} (run ${RUN})`);
