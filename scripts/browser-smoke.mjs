#!/usr/bin/env node
// Real-browser smoke run of the main flows: every step is a native form post clicked in Chromium, as a
// person would do it. It catches what the fetch-based e2e cannot: the browser's own headers (for example
// `Origin: null` under a no-referrer policy), hidden or closed controls, client errors and server errors.
//
// Usage: BASE=http://127.0.0.1:3100 node scripts/browser-smoke.mjs
//   Chromium: PLAYWRIGHT_BROWSERS_PATH (installed browsers) or CHROMIUM_PATH (an executable).
// Never point it at production: it creates accounts, a tournament, a team, posts and a report.
import { chromium } from "playwright-core";

const BASE = (process.env.BASE || "http://127.0.0.1:3100").replace(/\/$/, "");
if (/maximus\.vegas/i.test(BASE)) throw new Error("browser-smoke creates test records: never run it against production");
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
    await this.pg.waitForLoadState("networkidle");
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
    await this.pg.waitForLoadState("networkidle");
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
  for (const path of ["/ru", "/en", "/ru/tournaments", "/ru/games", "/ru/rankings", "/ru/players", "/ru/teams", "/ru/finder", "/ru/matchmaking", "/ru/trust", "/ru/status", "/ru/help", "/ru/terms", "/ru/privacy", "/ru/signup", "/ru/signin", "/en/trust"])
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

  step("team, invitation, acceptance");
  await b.go("/ru/teams/new");
  await b.submit("team.create", { name: `Smoke Five ${RUN}`, tag: "SF", game: "cs2" });
  await b.submit("team.invite", { username: c.username });
  await c.go("/ru/hub");
  await c.submit("team.respond", {}, { form: c.formWith("team.respond", "accept", "1") });

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

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
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
