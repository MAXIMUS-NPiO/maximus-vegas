/** Actual Next.js pages and POST handlers against a disposable local database, never production. */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const BASE = "http://127.0.0.1:3313",
  dataDir = `/tmp/c33-http-${randomUUID()}`;
const env = {
  ...process.env,
  DATABASE_URL: "",
  POSTGRES_URL: "",
  NEON_DATABASE_URL: "",
  MV_DATA_DIR: dataDir,
  MV_EMBEDDED_DB: "1",
  MV_LOCAL: "1",
  MV_INSECURE_COOKIES: "1",
  NEXT_PUBLIC_SITE_URL: BASE,
  SMTP_HOST: "",
  SMTP_USER: "",
  SMTP_PASS: "",
  RESEND_API_KEY: "",
  STRIPE_SECRET_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  PAYMENTS_ENABLED: "0",
  MPGS_API_PASSWORD: "",
  APPLICATION_WEBHOOK_URL: "",
  SIGNUP_EMAIL_CONFIRMATION: "",
  VERCEL: "",
};
await mkdir("artifacts/c33-pages", { recursive: true });
await promisify(execFile)(
  process.execPath,
  ["--experimental-strip-types", "scripts/admin-fixture.ts"],
  { env },
);
const fixture = JSON.parse(
  await readFile("artifacts/c33-fixture.json", "utf8"),
);
const log = await open("artifacts/c33-server.log", "w"),
  server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      "3313",
    ],
    { env, stdio: ["ignore", log.fd, log.fd] },
  );
const matches = (text, pattern) =>
  assert.ok(
    pattern.test(text),
    `Expected rendered content matching ${pattern}`,
  );
const results = [];
const record = (name) => {
  results.push(name);
  console.log(`PASS ${name}`);
};
const cookie = (who) =>
  who ? `mv_session=${fixture.accounts[`${who}_acceptance`].token}` : "";
async function get(path, who = "admin", code = 200) {
  const r = await fetch(BASE + path, {
    headers: { cookie: cookie(who) },
    redirect: "manual",
  });
  assert.equal(r.status, code, path);
  return { r, html: await r.text() };
}
async function post(action, data, who = "admin", error, origin = BASE) {
  const form = new URLSearchParams({
    lang: "en",
    back: "/en/admin?tab=overview",
  });
  for (const [k, v] of Object.entries(data))
    for (const item of Array.isArray(v) ? v : [v]) form.append(k, String(item));
  const r = await fetch(BASE + "/api/a/" + action, {
    method: "POST",
    body: form,
    headers: { cookie: cookie(who), origin },
    redirect: "manual",
  });
  assert.equal(r.status, 303, `${action}: ${await r.text()}`);
  const location = new URL(r.headers.get("location"), BASE);
  assert.equal(
    location.searchParams.get("e"),
    error ?? null,
    `${action}: ${location.pathname}${location.search}`,
  );
  return location;
}
try {
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(BASE + "/en/signin")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.ok(ready, "local Next.js server ready");
  const guest = await get("/en/admin", null, 307);
  matches(guest.r.headers.get("location"), /signin/);
  record("Guest cannot enter protected admin pages");
  for (const lang of ["ru", "en"])
    for (const tab of [
      "overview",
      "users",
      "tournaments",
      "conduct",
      "games",
      "applications",
      "sponsors",
      "audit",
      "venues",
      "academy",
    ]) {
      const { html } = await get(`/${lang}/admin?tab=${tab}`);
      assert.ok(!html.includes("Application error"), `${lang}/${tab}`);
      matches(html, /admin-nav/);
      await writeFile(`artifacts/c33-pages/${lang}-${tab}.html`, html);
    }
  record("20 RU/EN protected pages render against real populated backend");
  const user = await get(
    `/en/admin?tab=users&user=${fixture.accounts.player_acceptance.username}`,
  );
  matches(user.html, /Acceptance handle/);
  matches(user.html, /not publisher-verified/);
  record("Private profile, linked accounts and history render inside admin");
  const manage = await get(
    `/en/admin?tab=tournaments&event=${fixture.event.slug}`,
  );
  const editable = await get(
    `/en/admin?tab=tournaments&event=${fixture.leaderboard.slug}`,
  );
  matches(editable.html, /tournament\.update/);
  matches(manage.html, /Administrative status change/);
  matches(manage.html, /player_acceptance/);
  record(
    "Existing tournament editor and registrations are available inside admin",
  );
  const mid = manage.html.match(/&amp;match=([0-9a-f-]{36})/)?.[1];
  assert.ok(mid, "Match drilldown stays within the control centre");
  const matchPage = await get(
    `/en/admin?tab=tournaments&event=${fixture.event.slug}&match=${mid}`,
  );
  matches(matchPage.html, /Back to tournament operations/);
  matches(matchPage.html, /match\.official/);
  const create = await get(
    `/en/admin?tab=tournaments&new=1&org=${fixture.org.id}`,
  );
  matches(create.html, /tournament\.create/);
  record("Admin creation uses real organizer and tournament form");
  const filtered = await get(
    "/en/admin?tab=tournaments&game=apex&format=leaderboard",
  );
  matches(filtered.html, /Apex Review Leaderboard/);
  assert.ok(
    !filtered.html.includes(
      'href="/en/admin?tab=tournaments&amp;event=cs2-admin-acceptance',
    ),
  );
  record("Game and format filters find leaderboard events");
  const game = {
    slug: "http-arena",
    name: "HTTP Arena",
    teamSize: 3,
    mode: "battle_royale",
    platforms: ["pc"],
    formats: ["leaderboard"],
    genreRu: "Арена",
    genreEn: "Arena",
    reason: "Validated independent metadata in isolated acceptance",
    version: 0,
  };
  await post("admin.game", game, "support", "forbidden");
  await post("admin.game", game, "admin", undefined);
  await post("admin.game", game, "admin", "not_editable");
  for (const path of [
    "/en/games/http-arena",
    "/ru/games/http-arena",
    "/en/games",
    "/en/tournaments?game=http-arena",
    "/en/rankings?game=http-arena",
    "/en/teams/new?game=http-arena",
  ]) {
    const { html } = await get(path);
    matches(html, /HTTP Arena/);
  }
  await post(
    "admin.game",
    { ...game, slug: "denied-mfa" },
    "unverified",
    "mfa_not_enrolled",
  );
  await post(
    "admin.game",
    { ...game, slug: "denied-stepup" },
    "stale",
    "step_up_required",
  );
  await post(
    "tournament.transition",
    { tournament: fixture.event.id, to: "PAUSED" },
    "unverified",
    "mfa_not_enrolled",
  );
  const tForm = {
    back: "/en/admin?tab=tournaments&new=1",
    org: fixture.org.id,
    name: "Created through admin HTTP",
    game: "http-arena",
    format: "leaderboard",
    participantType: "solo",
    maxParticipants: 8,
    startsAt: "2030-11-01T12:00",
    tz: "UTC",
    description: "Actual administration flow",
    rules: "Evidence reviewed manually",
  };
  const created = await post("tournament.create", tForm);
  assert.equal(created.pathname, "/en/admin");
  assert.equal(created.searchParams.get("tab"), "tournaments");
  const newPage = await get(created.pathname + created.search);
  const tid = newPage.html.match(
    /name="tournament" value="([0-9a-f-]{36})"/,
  )?.[1];
  assert.ok(tid, "created tournament has a real persisted id");
  await post("tournament.update", {
    ...tForm,
    tournament: tid,
    name: "Edited through admin HTTP",
  });
  await post("admin.transition", {
    tournament: tid,
    to: "PUBLISHED",
    reason: "Published after local acceptance review",
  });
  await post("admin.transition", {
    tournament: tid,
    to: "REGISTRATION_OPEN",
    reason: "Open registrations after local acceptance review",
  });
  await post("tournament.register", { tournament: tid }, "player");
  const registered = await get(created.pathname + created.search);
  matches(registered.html, /player_acceptance/);
  matches(registered.html, /Edited through admin HTTP/);
  await post("tournament.regenerate", { tournament: fixture.event.id });
  record(
    "Tournament creation, editing, registration, bracket regeneration and MFA guards work over HTTP",
  );
  record(
    "Catalog create persists, rejects unauthorized/stale writes, and appears publicly without static 404",
  );
  await post(
    "admin.application_decide",
    {
      application: fixture.application.id,
      version: 1,
      status: "approved",
      reason: "Reviewed inquiry; approval does not provision a venue",
    },
    "support",
  );
  await post(
    "admin.application_decide",
    {
      application: fixture.application.id,
      version: 1,
      status: "rejected",
      reason: "A stale form must not replace the reviewed disposition",
    },
    "admin",
    "not_editable",
  );
  const approved = await get("/en/admin?tab=applications&status=approved");
  matches(approved.html, /approval does not provision a venue/);
  record(
    "Application approval and stale-form rejection use real POST handlers",
  );
  await post("sponsor.update", {
    sponsor: fixture.sponsor,
    version: 1,
    name: "Reviewed Acceptance Partner",
    tier: "gold",
    website: "https://example.test/partner",
    active: 1,
    reason: "Reviewed partner details in the isolated environment",
  });
  await post("sponsor.attach", {
    sponsor: fixture.sponsor,
    tournament: fixture.leaderboard.id,
    attach: 1,
  });
  await post("sponsor.attach", {
    sponsor: fixture.sponsor,
    tournament: fixture.event.id,
    attach: 0,
  });
  const sponsors = await get("/en/admin?tab=sponsors");
  matches(sponsors.html, /Reviewed Acceptance Partner/);
  record(
    "Sponsor edit and tournament attach/detach operate through server actions",
  );
  await post(
    "conduct.assign_appeal",
    {
      appeal: fixture.appeal.id,
      reviewer: fixture.accounts.admin_acceptance.id,
      reason: "Issuer is ineligible to review this appeal",
    },
    "support",
    "appeal_needs_other_reviewer",
  );
  await post(
    "conduct.assign_appeal",
    {
      appeal: fixture.appeal.id,
      reviewer: fixture.accounts.review_acceptance.id,
      reason: "Independent moderation colleague assigned to review",
    },
    "support",
  );
  await post(
    "conduct.decide",
    {
      appeal: fixture.appeal.id,
      grant: 1,
      decision: "The original issuer is not allowed to decide this appeal",
    },
    "admin",
    "appeal_needs_other_reviewer",
  );
  await post(
    "conduct.decide",
    {
      appeal: fixture.appeal.id,
      grant: 1,
      decision: "Independent evidence review supports overturning this warning",
    },
    "review",
  );
  record(
    "Appeal assignment and independent decision are enforced at HTTP boundary",
  );
  await post("admin.transition", {
    tournament: fixture.event.id,
    to: "PAUSED",
    reason: "Pause the isolated event for an operational review",
  });
  await post(
    "admin.transition",
    {
      tournament: fixture.event.id,
      to: "COMPLETED",
      reason: "Refuse bypass of real bracket completion checks",
    },
    "admin",
    "invalid_transition",
  );
  record("Reasoned status override follows existing tournament invariants");
  await post("admin.organizer_access", {
    user: fixture.accounts.second_acceptance.id,
    org: fixture.org.id,
    role: "admin",
    reason: "Assign organizer responsibility for acceptance",
  });
  await post("admin.role", {
    user: fixture.accounts.second_acceptance.id,
    role: "referee",
    grant: 1,
  });
  await post("admin.role", {
    user: fixture.accounts.second_acceptance.id,
    role: "referee",
    grant: 0,
  });
  await post("admin.user_status", {
    user: fixture.accounts.second_acceptance.id,
    status: "suspended",
    reason: "Administrative security hold in local acceptance",
  });
  const suspended = await get("/en/admin?tab=users&q=second_acceptance");
  matches(suspended.html, /suspended/);
  await post("admin.user_status", {
    user: fixture.accounts.second_acceptance.id,
    status: "active",
    reason: "Local acceptance security hold resolved",
  });
  record(
    "Space organizer access, staff roles, account suspension and reinstatement are operational",
  );
  const audit = await get("/en/admin?tab=audit&verify=1");
  matches(audit.html, /Chain is intact/);
  matches(audit.html, /Verified head/);
  matches(audit.html, /sponsor\.updated/);
  record("Full audit recomputation verifies real operational decisions");
  const support = await get("/en/admin?tab=games", "support");
  assert.ok(!support.html.includes('action="/api/a/admin.game'));
  const restricted = await get("/en/admin?tab=audit", "player");
  assert.ok(!restricted.html.includes("Verify full SHA-256 chain"));
  record("Section navigation cannot expose unauthorized admin forms or audit");
  const csrf = await fetch(BASE + "/api/a/admin.game", {
    method: "POST",
    headers: { origin: "https://untrusted.example", cookie: cookie("admin") },
    body: new URLSearchParams({ lang: "en" }),
    redirect: "manual",
  });
  assert.equal(csrf.status, 303);
  assert.equal(
    new URL(csrf.headers.get("location"), BASE).searchParams.get("e"),
    "bad_origin",
  );
  record("Cross-origin administrative writes are rejected");
  await writeFile(
    "artifacts/c33-http-report.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        isolated: true,
        productionMutations: false,
        checks: results,
      },
      null,
      2,
    ),
  );
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
  await log.close();
}
