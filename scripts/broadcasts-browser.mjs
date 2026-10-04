/** Browser/API acceptance on disposable local data. Capture is a labelled synthetic canvas, not a provider stream. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
const BASE = "http://127.0.0.1:3109", dataDir = "/tmp/c29-browser-acceptance";
const env = { ...process.env, DATABASE_URL: "", POSTGRES_URL: "", NEON_DATABASE_URL: "", MV_DATA_DIR: dataDir, MV_EMBEDDED_DB: "1", MV_LOCAL: "1", NEXT_PUBLIC_SITE_URL: BASE,
  MV_BROADCAST_ENABLED: "", MV_BROADCAST_TARIFF: "", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", LIVEKIT_URL: "" };
const run = (args, options = {}) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, args, { env, stdio: "inherit", ...options });
  p.on("error", reject); p.on("exit", code => code === 0 ? resolve() : reject(new Error(`Child exit ${code}`)));
});
await mkdir("artifacts/c29-screens", { recursive: true });
await run(["--experimental-strip-types", "scripts/broadcasts-fixture.ts"]);
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3109"], { env, stdio: "pipe" });
let logs = ""; server.stdout.on("data", b => { logs += b; }); server.stderr.on("data", b => { logs += b; });
let browser;
const checks = [], errors = [];
const mark = s => { checks.push(s); console.log(`PASS ${s}`); };
try {
  let ready = false;
  for (let n = 0; n < 60; n++) {
    if (server.exitCode !== null) throw new Error("Acceptance server failed to start");
    try { const r = await fetch(BASE + "/ru/studio"); if (r.status === 200) { ready = true; break; } } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 500));
  }
  assert.ok(ready, "local server ready");
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, headless: true });
  const anonymous = await browser.newContext();
  const guest = await anonymous.newPage(); await guest.goto(BASE + "/ru/studio");
  await guest.getByRole("link", { name: "Войти в студию", exact: true }).waitFor();
  const denied = await anonymous.request.post(BASE + "/api/broadcasts/status", { headers: { origin: BASE }, data: {} });
  assert.equal(denied.status(), 401);
  assert.equal((await anonymous.request.get(BASE + "/api/cron/broadcasts")).status(), 404);
  await anonymous.close(); mark("Studio sign-in, authenticated API and worker authentication");
  const context = await browser.newContext({ storageState: "artifacts/c29-browser-state.json", viewport: { width: 1440, height: 1000 } });
  await context.route("**/*", r => new URL(r.request().url()).origin === BASE ? r.continue() : r.abort());
  await context.addInitScript(() => {
    window.__captures = 0; window.__streams = []; window.__denyCapture = false;
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.__captures++;
      if (window.__denyCapture) throw new DOMException("Denied", "NotAllowedError");
      const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext("2d"); ctx.fillStyle = "#18232b"; ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = "white"; ctx.font = "40px sans-serif"; ctx.fillText("Local capture acceptance fixture", 100, 200);
      const stream = canvas.captureStream(5); window.__streams.push(stream); return stream;
    };
  });
  const page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  page.on("response", r => { if (r.status() >= 500) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  for (const lang of ["ru", "en"]) for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); await page.goto(`${BASE}/${lang}/studio`);
    await page.getByRole("heading", { name: lang === "ru" ? "Настройки эфира" : "Broadcast settings", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__captures), 0);
    assert.ok(await page.getByRole("button", { name: lang === "ru" ? "Перейти к оплате" : "Proceed to payment", exact: true }).isDisabled());
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `artifacts/c29-screens/studio-${lang}-${width}.png`, fullPage: true });
  }
  mark("RU/EN desktop and mobile studio; no horizontal overflow, automatic capture or enabled unpaid service");
  await page.getByLabel("Microphone", { exact: true }).uncheck();
  await page.getByRole("button", { name: "Test screen capture", exact: true }).click();
  await page.getByRole("button", { name: "Stop preview", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__captures), 1);
  assert.ok(await page.locator("video").evaluate(v => !!v.srcObject));
  await page.getByRole("button", { name: "Stop preview", exact: true }).click();
  assert.ok(await page.evaluate(() => window.__streams.every(s => s.getTracks().every(t => t.readyState === "ended"))));
  mark("Explicit local preview attaches a synthetic screen and releases every track when stopped");
  await page.evaluate(() => { window.__denyCapture = true; });
  await page.getByRole("button", { name: "Test screen capture", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Capture permission was not granted" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Stop preview", exact: true }).count(), 0);
  mark("Permission refusal is recoverable and never starts a broadcast");
  await page.getByLabel("Mode", { exact: true }).selectOption("live");
  assert.equal(await page.getByLabel("Keep recording, days", { exact: true }).count(), 0);
  await page.getByLabel("Mode", { exact: true }).selectOption("record");
  await page.getByLabel("Keep recording, days", { exact: true }).fill("123");
  assert.equal(await page.getByLabel("Keep recording, days", { exact: true }).inputValue(), "123");
  const state = await context.request.post(BASE + "/api/broadcasts/status", { headers: { origin: BASE }, data: {} });
  assert.equal(state.status(), 200); const data = await state.json(); assert.equal(data.ready, false); assert.deepEqual(data.broadcasts, []);
  const badOrigin = await context.request.post(BASE + "/api/broadcasts/status", { headers: { origin: "https://untrusted.example" }, data: {} });
  assert.equal(badOrigin.status(), 400);
  mark("User-selected retention, actual authenticated status response and cross-origin refusal");
  const policy = (await context.request.get(BASE + "/en/studio")).headers()["permissions-policy"];
  assert.match(policy, /microphone=\(self\)/); assert.match(policy, /display-capture=\(self\)/); assert.match(policy, /camera=\(\)/);
  await page.goto(BASE + "/en/media"); await page.getByRole("link", { name: "Open live & POV studio", exact: true }).waitFor();
  assert.deepEqual(errors, []); mark("Scoped capture permission policy, media entry point and no page errors");
  await writeFile("artifacts/c29-browser-report.json", JSON.stringify({ checks, errors, externalBroadcastVerified: false }, null, 2));
} finally {
  await browser?.close(); server.kill("SIGTERM");
  await writeFile("artifacts/c29-server.log", logs);
}
