import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const BASE = "http://127.0.0.1:3111";
const env = { ...process.env, DATABASE_URL: "", POSTGRES_URL: "", NEON_DATABASE_URL: "", MV_DATA_DIR: `/tmp/c31-browser-${process.pid}-${Date.now()}`, MV_EMBEDDED_DB: "1", MV_LOCAL: "1", NEXT_PUBLIC_SITE_URL: BASE,
  MAIL_TRANSPORT: "test", MAIL_TEST_FAIL: "", MAIL_FROM: "", RESEND_API_KEY: "", SMTP_URL: "", MV_EXPERIENCE_DISABLED: "1", STEAM_WEB_API_KEY: "", FACEIT_API_KEY: "",
  MV_COMMUNITY_VOICE_ENABLED: "", MV_BROADCAST_ENABLED: "", LIVEKIT_URL: "", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" };
const run = args => new Promise((resolve, reject) => { const p = spawn(process.execPath, args, { env, stdio: "inherit" }); p.on("error", reject); p.on("exit", code => code === 0 ? resolve() : reject(new Error(`Child exit ${code}`))); });
await mkdir("artifacts/c31-screens", { recursive: true });
await run(["--experimental-strip-types", "scripts/player-experience-fixture.ts"]);
const fixture = JSON.parse(await readFile("artifacts/c31-fixture.json", "utf8"));
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3111"], { env, stdio: "pipe" });
let logs = "", browser; const errors = [], checks = [];
server.stdout.on("data", b => logs += b); server.stderr.on("data", b => logs += b);
const mark = s => { checks.push(s); console.log(`PASS ${s}`); };
try {
  let ready = false;
  for (let i = 0; i < 60; i++) { if (server.exitCode !== null) throw new Error("Server exited"); try { if ((await fetch(BASE + "/ru/signin")).status === 200) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 500)); }
  assert.ok(ready); browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  async function context(prefix) {
    const c = await browser.newContext({ storageState: prefix ? `artifacts/c31-${prefix}-state.json` : undefined, viewport: { width: 1440, height: 1000 } });
    await c.route("**/*", r => new URL(r.request().url()).origin === BASE ? r.continue() : r.abort()); return c;
  }
  const captain = await context("leader"), recipient = await context("veteran"), stranger = await context("other"), guest = await context();
  const page = await captain.newPage(), player = await recipient.newPage(), outsider = await stranger.newPage(), publicPage = await guest.newPage();
  for (const p of [page, player, outsider, publicPage]) { p.on("pageerror", e => errors.push(e.message)); p.on("response", r => { if (r.status() >= 500) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); }); }
  const input = { teamId: fixture.team.id, email: fixture.newEmail, username: fixture.newUsername, lang: "ru", requestId: crypto.randomUUID() };
  const anonymous = await guest.request.post(BASE + "/api/team-invitations", { headers: { origin: BASE }, data: input }); assert.equal(anonymous.status(), 401);
  const origin = await captain.request.post(BASE + "/api/team-invitations", { headers: { origin: "https://invalid.example" }, data: input }); assert.equal(origin.status(), 400);
  const forbidden = await stranger.request.post(BASE + "/api/team-invitations", { headers: { origin: BASE }, data: input }); assert.equal(forbidden.status(), 400);
  assert.equal((await guest.request.get(BASE + "/api/cron/experience")).status(), 404);
  mark("Invitation API denies anonymous, cross-origin and non-leader writes; synchronization requires authentication");

  await page.goto(`${BASE}/ru/teams/${fixture.team.slug}`);
  const compose = page.locator('[data-invitation-composer]');
  await compose.locator('input[name="username"]').fill(fixture.newUsername);
  assert.equal(await compose.locator('input[name="email"]').evaluate(el => el.checkValidity()), false);
  await compose.getByLabel("Email получателя", { exact: true }).fill(fixture.newEmail);
  await compose.getByRole("button", { name: "Отправить приглашение на email", exact: true }).click();
  await compose.getByRole("link", { name: "Открыть статус приглашения", exact: true }).waitFor();
  const statusLink = await compose.getByRole("link", { name: "Открыть статус приглашения", exact: true }).getAttribute("href");
  const newId = statusLink.split("#delivery-")[1]; assert.ok(newId);
  await page.goto(BASE + statusLink);
  const delivery = page.locator(`#delivery-${newId}`);
  await delivery.getByRole("heading", { name: fixture.newEmail, exact: true }).waitFor();
  for (let i = 0; i < 10 && !(await delivery.textContent()).includes("Почтовый сервис принял письмо"); i++) await page.reload();
  await delivery.getByText("Почтовый сервис принял письмо", { exact: true }).waitFor();
  await delivery.getByText("Ожидает ответа", { exact: true }).waitFor();
  await page.locator(`#invitation-${fixture.newUsername}`).waitFor();
  const repeat = await captain.request.post(BASE + "/api/team-invitations", { headers: { origin: BASE }, data: { ...input, requestId: crypto.randomUUID() } });
  assert.equal(repeat.status(), 200); assert.equal((await repeat.json()).invitation.id, newId);
  mark("Team page collects email before reserving; one explicit send persists exact recipient and test-transport acknowledgement; repeat does not duplicate");

  const direct = await captain.request.post(BASE + "/api/team-invitations", { headers: { origin: BASE }, data: { teamId: fixture.team.id, email: fixture.playerEmail, lang: "ru", requestId: crypto.randomUUID() } });
  assert.equal(direct.status(), 200); const directId = (await direct.json()).invitation.id;
  await outsider.goto(`${BASE}/ru/team-invitations/${directId}`);
  await outsider.getByText(/Это приглашение адресовано другому аккаунту/).waitFor();
  assert.equal(await outsider.getByRole("button", { name: "Принять и вступить в команду", exact: true }).count(), 0);
  assert.ok(!(await outsider.textContent("body")).includes(fixture.playerEmail));
  await player.goto(`${BASE}/ru/team-invitations/${directId}`);
  await player.getByRole("button", { name: "Принять и вступить в команду", exact: true }).click();
  await player.getByRole("link", { name: "Чат нашей команды", exact: true }).waitFor();
  await page.goto(`${BASE}/ru/my-teams#delivery-${directId}`);
  await page.locator(`#delivery-${directId}`).getByText("Приглашение принято", { exact: true }).waitFor();
  mark("Only the verified intended account can accept; recipient address stays private and captain sees player acceptance");

  await page.goto(`${BASE}/ru/my-teams?team=${fixture.team.id}&username=${fixture.player}#invite-player`);
  const form = page.locator('[data-invitation-composer]');
  assert.equal(await form.locator('select[name="team"]').inputValue(), fixture.team.id);
  assert.equal(await form.locator('input[name="username"]').inputValue(), fixture.player);
  await form.getByLabel("На email", { exact: true }).check(); await form.getByLabel("Email получателя", { exact: true }).fill("different@example.test");
  await form.getByRole("button", { name: "Отправить приглашение на email", exact: true }).click();
  await form.getByRole("alert").waitFor();
  assert.equal(await form.getByLabel("Email получателя", { exact: true }).inputValue(), "different@example.test");
  assert.equal(await form.locator('input[name="username"]').inputValue(), fixture.player);
  await page.locator(`#delivery-${newId}`).getByRole("button", { name: "Отозвать приглашение", exact: true }).click();
  await outsider.goto(`${BASE}/ru/team-invitations/${newId}`); await outsider.getByText("Капитан отозвал приглашение.", { exact: true }).waitFor();
  mark("Contextual team/player defaults survive navigation; mismatched recipient is refused without clearing fields; revoked link cannot be accepted");

  for (const lang of ["ru", "en"]) for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); await page.goto(`${BASE}/${lang}/my-teams`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `artifacts/c31-screens/invitations-${lang}-${width}.png`, fullPage: true });
    await player.setViewportSize({ width, height: 1000 }); await player.goto(`${BASE}/${lang}/experience`);
    await player.getByText("Ancient IV", { exact: true }).waitFor(); assert.ok(await player.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await player.screenshot({ path: `artifacts/c31-screens/experience-${lang}-${width}.png`, fullPage: true });
    await publicPage.setViewportSize({ width, height: 1000 }); await publicPage.goto(`${BASE}/${lang}/players/${fixture.player}`);
    await publicPage.getByText("Ancient IV", { exact: true }).waitFor();
    assert.ok((await publicPage.textContent("body")).includes(lang === "ru" ? "Прогресс в MAXIMUS" : "MAXIMUS progression"));
    assert.ok(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await publicPage.screenshot({ path: `artifacts/c31-screens/profile-${lang}-${width}.png`, fullPage: true });
  }
  mark("RU/EN invitation, experience and public profile screens fit 390/1440 px; source history remains visible beside zero local XP");

  await player.goto(`${BASE}/ru/experience`);
  const sharing = player.locator('form[action="/api/experience/sharing"]').filter({ has: player.locator(`input[value="${fixture.connectionId}"]`) });
  await sharing.locator('input[name="shared"]').uncheck(); await sharing.getByRole("button").click();
  await publicPage.goto(`${BASE}/ru/players/${fixture.player}`); assert.equal(await publicPage.getByText("Ancient IV", { exact: true }).count(), 0);
  await player.getByText("Ancient IV", { exact: true }).waitFor();
  await sharing.locator('input[name="shared"]').check(); await sharing.getByRole("button").click();
  await publicPage.reload(); await publicPage.getByText("Ancient IV", { exact: true }).waitFor();
  const source = player.locator('article').filter({ has: player.getByRole("heading", { name: "OpenDota · Dota 2", exact: true }) });
  await source.getByText("Отключить источник", { exact: true }).click();
  await source.locator('form[action="/api/experience/disconnect"] input[name="confirm"]').check();
  await source.locator('form[action="/api/experience/disconnect"]').getByRole("button").click();
  assert.equal(await player.getByText("Ancient IV", { exact: true }).count(), 0);
  await publicPage.reload(); assert.equal(await publicPage.getByText("Ancient IV", { exact: true }).count(), 0);
  mark("Source sharing is separate consent; withdrawing hides public history and disconnect removes imported records");

  await page.goto(BASE + "/ru/hub"); await page.locator('.account-menu > summary').click();
  await page.locator('.account-panel').getByRole("link", { name: "Пригласить игрока", exact: true }).click();
  await page.locator('[data-invitation-composer]').waitFor();
  assert.deepEqual(errors, []); mark("Account menu directly opens invite flow; all browser scenarios finish without page or server errors");
  await writeFile("artifacts/c31-browser-report.json", JSON.stringify({ checks, errors, mailTransport: "isolated in-memory test", realEmailsSent: false, providerLiveAcceptance: false, externalRecords: "disposable fixtures" }, null, 2));
} finally { await browser?.close(); server.kill("SIGTERM"); await writeFile("artifacts/c31-server.log", logs); }
