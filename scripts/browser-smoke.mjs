#!/usr/bin/env node
// Real-browser smoke run of the main flows: every step is a native form post clicked in Chromium, as a
// person would do it. It catches what the fetch-based e2e cannot: the browser's own headers (for example
// `Origin: null` under a no-referrer policy), hidden or closed controls, client errors and server errors.
//
// Usage: BASE=http://127.0.0.1:3100 node scripts/browser-smoke.mjs
//   Chromium: PLAYWRIGHT_BROWSERS_PATH (installed browsers) or CHROMIUM_PATH (an executable).
// Never point it at production: it creates accounts, a tournament, a team, posts and a report.
import { createServer } from "node:http";
import { chromium } from "playwright-core";

const BASE = (process.env.BASE || "http://127.0.0.1:3100").replace(/\/$/, "");
const target = new URL(BASE);
if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname) || target.username || target.password) throw new Error("Acceptance creates test records and requires an isolated loopback server");

const RUN = (Date.now() % 1e9).toString(36);
const PW = `browser-smoke-${RUN}`;
const problems = [];

class Person {
  constructor(browser, name) {
    this.name = name;
    this.username = `${name}_${RUN}`;
    this.browser = browser;
  }
  async open() {
    this.ctx = await this.browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ru-RU" });
    this.pg = await this.ctx.newPage();
    this.pg.on("pageerror", (e) => problems.push(`[${this.name}] page error on ${this.pg.url()}: ${e.message}`));
    this.pg.on("console", (m) => m.type() === "error" && problems.push(`[${this.name}] console error on ${this.pg.url()}: ${m.text().slice(0, 200)}`));
    this.pg.on("response", (r) => r.status() >= 500 && problems.push(`[${this.name}] HTTP ${r.status()} ${r.url()}`));
    return this;
  }
  async go(path) {
    const res = await this.pg.goto(BASE + path);
    await this.pg.waitForLoadState("load");
    if (res && res.status() >= 400) problems.push(`[${this.name}] ${path} HTTP ${res.status()}`);
    return res;
  }
  /** Fills a form of the action (or the given form) and sends it the way the browser does. */
  async submit(action, fields = {}, { form, expectE } = {}) {
    const f = (form ?? this.pg.locator(`form[action^='/api/a/${action}?']`)).first();
    if (!(await f.count())) {
      problems.push(`[${this.name}] no form ${action} on ${this.pg.url()}`);
      return null;
    }
    for (const [name, value] of Object.entries(fields)) {
      const el = f.locator(`[name='${name}']`).first();
      const tag = await el.evaluate((e) => e.tagName.toLowerCase());
      const type = ((await el.getAttribute("type")) || "").toLowerCase();
      if (tag === "select") await el.selectOption(String(value));
      else if (type === "checkbox" || type === "radio") value ? await el.check() : await el.uncheck();
      else await el.fill(String(value));
    }
    const button = f.locator("button:not([type=button])").first();
    await Promise.all([
      this.pg.waitForNavigation(),
      (await button.isVisible()) ? button.click() : f.evaluate((form) => form.requestSubmit()),
    ]);
    await this.pg.waitForLoadState("load");
    const url = new URL(this.pg.url());
    const ok = url.searchParams.get("ok");
    const e = url.searchParams.get("e");
    const tag = `[${this.name}] ${action}`;
    if (expectE && e !== expectE) problems.push(`${tag}: expected e=${expectE}, got ok=${ok} e=${e}`);
    else if (!expectE && e) problems.push(`${tag}: e=${e} at ${url.pathname}`);
    console.log(`${tag} → ${ok ? `ok=${ok}` : e ? `e=${e}` : "done"} (${url.pathname})`);
    return ok ?? e;
  }
  formWith(action, name, value) {
    return this.pg.locator(`form[action^='/api/a/${action}?']:has(input[name='${name}'][value='${value}'])`);
  }
}

const step = (title) => console.log(`\n— ${title}`);

async function main(browser) {
  const guest = await new Person(browser, "guest").open();
  step("public pages");
  for (const path of ["/ru", "/en", "/ru/tournaments", "/ru/games", "/ru/rankings", "/ru/players", "/ru/teams", "/ru/clans", "/ru/ladders", "/ru/venues", "/ru/developers", "/ru/finder", "/ru/matchmaking", "/ru/trust", "/ru/status", "/ru/help", "/ru/terms", "/ru/privacy", "/ru/signup", "/ru/signin", "/en/trust"])
    await guest.go(path);

  step("token pages post their forms (a wrong token is refused by the server, not by the browser's origin)");
  for (const [path, action, fields] of [
    ["/ru/reset-password", "auth.reset", { password: "a-new-password-123" }],
    ["/ru/verify-email", "auth.verify", {}],
    ["/ru/activate", "auth.activate", {}],
  ]) {
    await guest.go(`${path}?token=${"x".repeat(43)}`);
    await guest.submit(action, fields, { expectE: "token_invalid" });
  }

  const [a, b, c] = await Promise.all(["bsa", "bsb", "bsc"].map((n) => new Person(browser, n).open()));
  step("sign-up through the form");
  for (const [x, display] of [
    [a, "Smoke Organiser"],
    [b, "Smoke Bravo"],
    [c, "Smoke Charlie"],
  ]) {
    await x.go("/ru/signup");
    await x.submit("auth.signup", { email: `${x.username}@example.com`, username: x.username, displayName: display, password: PW, adult: true, terms: true });
  }

  step("onboarding and settings");
  await a.go("/ru/welcome");
  if (await a.pg.locator("form[action^='/api/a/onboarding.done?']").count()) await a.submit("onboarding.done");
  await a.go("/ru/settings");
  await a.submit("account.profile", { displayName: "Smoke Organiser Two" });

  step("organiser space, tournament, transitions");
  await a.go("/ru/organizer");
  await a.submit("org.create", { name: `Smoke Space ${RUN}`, description: "Browser smoke run" });
  const spacePath = new URL(a.pg.url()).pathname;
  const start = new Date(Date.now() + 3 * 86_400_000);
  const pad = (n) => String(n).padStart(2, "0");
  const startsAt = `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:${pad(start.getMinutes())}`;
  await a.submit("tournament.create", { name: `Smoke Cup ${RUN}`, game: "cs2", participantType: "solo", maxParticipants: "4", startsAt, checkInRequired: false });
  const adminPath = new URL(a.pg.url()).pathname;
  const slug = adminPath.split("/").pop();
  const transition = async (to) => {
    await a.go(adminPath);
    await a.submit("tournament.transition", {}, { form: a.formWith("tournament.transition", "to", to) });
  };
  await transition("PUBLISHED");
  await transition("REGISTRATION_OPEN");

  step("players register, the event starts");
  for (const x of [b, c]) {
    await x.go(`/ru/tournaments/${slug}`);
    await x.submit("tournament.register");
  }
  await transition("REGISTRATION_CLOSED");
  await transition("IN_PROGRESS");

  step("result through the match page");
  await b.go("/ru/gameday");
  const href = await b.pg.locator("a[href*='/ru/matches/']").first().getAttribute("href");
  if (!href) problems.push("[bsb] no match on Game Day");
  else {
    await b.go(href);
    await b.submit("match.submit", { scoreA: "2", scoreB: "1" });
    await c.go(href);
    await c.submit("match.confirm");
  }

  step("venues: a venue added and sent for review stays hidden");
  await a.go(`${spacePath}/venues`);
  await a.submit("venue.create", { name: `Smoke Hall ${RUN}`, kind: "club", address: "Smoke street 1", city: "Dubai", country: "AE" });
  await a.submit("venue.submit");
  const venueHref = await a.pg.locator("a[href*='/ru/venues/']").first().getAttribute("href");
  // Checked without a browser tab: a 404 page would be logged as a console error.
  const hidden = await fetch(BASE + venueHref, { redirect: "manual" });
  if (hidden.status !== 404) problems.push(`[guest] an unconfirmed venue answered ${hidden.status}`);
  await c.go("/ru/passes");

  step("integrations: an API key shown once, widgets on a third-party page");
  await a.go(`${spacePath}/integrations`);
  await a.submit("integrations.key_create", { name: "Smoke site" });
  if (!(await a.pg.locator("code.secret-value").count())) problems.push("[bsa] the new API key is not shown");
  await a.submit("integrations.secret_hide");
  if (await a.pg.locator("code.secret-value").count()) problems.push("[bsa] the API key is still shown after 'I have saved it'");
  // A partner's page on another site frames two widgets and, wrongly, a portal page.
  const site = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>Partner site</title><h1>Partner site</h1>
<iframe id="bracket" src="${BASE}/embed/ru/tournaments/${slug}/bracket" width="960" height="520"></iframe>
<iframe id="registration" src="${BASE}/embed/ru/tournaments/${slug}/registration" width="600" height="260"></iframe>
<iframe id="page" src="${BASE}/ru/tournaments/${slug}" width="600" height="260"></iframe>`);
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const partner = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ppg = await partner.newPage();
  ppg.on("pageerror", (e) => problems.push(`[partner] page error: ${e.message}`));
  ppg.on("response", (r) => r.status() >= 500 && problems.push(`[partner] HTTP ${r.status()} ${r.url()}`));
  await ppg.goto(`http://localhost:${site.address().port}/`);
  await ppg.waitForLoadState("load");
  for (const id of ["bracket", "registration"]) {
    const title = ppg.frameLocator(`#${id}`).locator("h1.embed-title");
    try {
      await title.waitFor({ timeout: 10_000 });
      if (!(await title.textContent())?.includes(`Smoke Cup ${RUN}`)) problems.push(`[partner] the ${id} widget shows another title`);
    } catch {
      problems.push(`[partner] the ${id} widget did not render on a third-party page`);
    }
  }
  if (await ppg.frameLocator("#page").locator("main#main").count()) problems.push("[partner] a portal page rendered inside a third-party frame");
  console.log(`[partner] widgets rendered on http://localhost:${site.address().port}/; a framed portal page is refused`);
  await partner.close();
  site.close();

  step("team, invitation, acceptance");
  await b.go("/ru/teams/new");
  await b.submit("team.create", { name: `Smoke Five ${RUN}`, tag: "SF", game: "cs2" });
  const invite = b.pg.locator('[data-invitation-composer]');
  await invite.getByLabel("Игроку на сайте", { exact: true }).check();
  await invite.locator('input[name="username"]').fill(c.username);
  await invite.getByRole("button", { name: "Отправить приглашение игроку", exact: true }).click();
  await invite.getByText("Приглашение появилось в кабинете игрока", { exact: true }).waitFor();
  await c.go("/ru/hub");
  await c.submit("team.respond", {}, { form: c.formWith("team.respond", "accept", "1") });

  step("transfer between two teams");
  const ownTeam = new URL(b.pg.url()).pathname;
  await a.go("/ru/teams/new");
  await a.submit("team.create", { name: `Smoke Rival ${RUN}`, tag: "SR", game: "cs2" });
  const rivalTeam = new URL(a.pg.url()).pathname;
  await a.pg.locator("details:has(form[action^='/api/a/transfer.propose?']) summary").first().click();
  await a.submit("transfer.propose", { username: c.username, note: "Smoke transfer" });
  await c.go(rivalTeam);
  await c.submit("transfer.answer", {}, { form: c.formWith("transfer.answer", "answer", "accept") });
  await b.go(ownTeam);
  await b.submit("transfer.answer", {}, { form: b.formWith("transfer.answer", "answer", "accept") });

  step("clans and a clan war");
  await b.go("/ru/clans");
  await b.submit("clan.create", { name: `Smoke Clan ${RUN}`, tag: `B${RUN.slice(-4).toUpperCase()}`, description: "Browser smoke clan" });
  const clanPath = new URL(b.pg.url()).pathname;
  await b.submit("clan.invite", { username: c.username });
  await c.go("/ru/clans");
  await c.submit("clan.respond", {}, { form: c.formWith("clan.respond", "accept", "1") });
  await a.go("/ru/clans");
  await a.submit("clan.create", { name: `Smoke Rivals ${RUN}`, tag: `A${RUN.slice(-4).toUpperCase()}`, description: "" });
  await a.go(clanPath);
  await a.pg.locator("details#challenge summary").first().click();
  const warAt = new Date(Date.now() + 2 * 3_600_000);
  const warStart = `${warAt.getFullYear()}-${pad(warAt.getMonth() + 1)}-${pad(warAt.getDate())}T${pad(warAt.getHours())}:${pad(warAt.getMinutes())}`;
  await a.submit("war.propose", { size: "1", bestOf: "1", at: warStart, lineup: true });
  await b.go(clanPath);
  await b.submit("war.answer", { lineup: true }, { form: b.formWith("war.answer", "answer", "accept") });

  step("team finder");
  await b.go("/ru/finder?kind=lfg");
  const details = b.pg.locator("details.disclosure:has(form[action^='/api/a/finder.post?'])").first();
  if (!(await details.evaluate((d) => d.open))) await details.locator("summary").first().click();
  await b.submit("finder.post", { kind: "lfg", game: "valorant", note: "Smoke: play tonight" });
  await c.go("/ru/finder?kind=lfg&game=valorant");
  const card = c.pg.locator("article.finder-post:has-text('Smoke: play tonight')").first();
  if (!(await card.count())) problems.push("[bsc] LFG post not listed");
  else {
    await card.locator("summary").first().click();
    await c.submit("finder.apply", { message: "Smoke: count me in" }, { form: card.locator("form[action^='/api/a/finder.apply?']") });
  }
  await b.go("/ru/finder#mine");
  await b.submit("finder.decide", {}, { form: b.formWith("finder.decide", "accept", "1") });

  step("scouting");
  await b.go(`/ru/scouting?text=${a.username}`);
  await b.submit("scout.watch");
  await b.submit("scout.save", { name: `Smoke ${RUN}` });

  step("quick match with a ready check");
  for (const x of [b, c]) {
    await x.go("/ru/matchmaking");
    await x.submit("quick.join", { game: "deadlock" });
  }
  for (const x of [b, c]) {
    await x.go("/ru/matchmaking");
    await x.submit("quick.ready");
  }

  step("fair play, notifications, password, sign-out and sign-in, deletion");
  await b.go(`/ru/conduct?user=${c.username}`);
  await b.submit("conduct.report", { rule: "PRESSURE", description: "Smoke run: a report written through the browser form." });
  await b.go("/ru/notifications");
  if (await b.pg.locator("form[action^='/api/a/notifications.read?']").count()) await b.submit("notifications.read");
  await b.go("/ru/settings");
  await b.submit("account.password", { current: PW, password: `${PW}-2` });
  await b.go("/ru/hub");
  await b.submit("auth.signout");
  await b.go("/ru/signin");
  await b.submit("auth.signin", { login: b.username, password: `${PW}-2` });
  await c.go("/ru/settings");
  await c.pg.locator("details.danger-zone summary").first().click();
  await c.submit("account.delete", { password: PW });
  await c.go("/ru/signin");
  await c.submit("auth.signin", { login: c.username, password: PW }, { expectE: "invalid_credentials" });
}

/** Every public game page fits a 390 px phone screen (no sideways scrolling). */
async function phoneWidth(browser) {
  step("game pages at 390 px");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ru-RU" });
  const pg = await ctx.newPage();
  await pg.goto(`${BASE}/ru/games`);
  const slugs = [...new Set(await pg.locator('a[href^="/ru/games/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href").split("/")[3]).filter(Boolean)))];
  if (!slugs.length) problems.push("[phone] no game pages listed");
  for (const slug of slugs) {
    await pg.goto(`${BASE}/ru/games/${slug}`);
    const over = await pg.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) problems.push(`[phone] /ru/games/${slug} is ${over}px wider than the screen`);
  }
  console.log(`[phone] ${slugs.length} game pages checked`);
  await ctx.close();
}

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  await phoneWidth(browser);
  await main(browser);
} catch (error) {
  problems.push(`stopped: ${String(error?.message ?? error).split("\n")[0]}`);
} finally {
  await browser.close();
}
if (problems.length) {
  console.log("\nPROBLEMS:");
  for (const p of problems) console.log(` - ${p}`);
  process.exit(1);
}
console.log(`\nBROWSER SMOKE OK against ${BASE} (run ${RUN})`);
