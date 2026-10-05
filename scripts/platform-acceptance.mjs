// Full existing HTTP and browser journeys, always on a fresh local database.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const BASE = "http://127.0.0.1:3112";
const ownerCode = randomBytes(32).toString("hex");
const env = { ...process.env, BASE, DATABASE_URL: "", POSTGRES_URL: "", NEON_DATABASE_URL: "",
  MV_DATA_DIR: `/tmp/c31-platform-${process.pid}-${Date.now()}`, MV_EMBEDDED_DB: "1", MV_LOCAL: "1", MV_INSECURE_COOKIES: "1", VERCEL: "", VERCEL_ENV: "development", NEXT_PUBLIC_SITE_URL: BASE,
  OWNER_CODE: ownerCode, ADMIN_BOOTSTRAP_TOKEN: ownerCode, MV_WEBHOOK_ALLOW_LOCAL: "1", MAIL_TRANSPORT: "", MAIL_FROM: "", RESEND_API_KEY: "", SMTP_URL: "",
  MV_EXPERIENCE_DISABLED: "1", STEAM_WEB_API_KEY: "", FACEIT_API_KEY: "", MV_COMMUNITY_VOICE_ENABLED: "", MV_BROADCAST_ENABLED: "",
  LIVEKIT_URL: "", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", MV_TURN_URLS: "", MV_TURN_SECRET: "" };
await mkdir("artifacts", { recursive: true });
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3112"], { env, stdio: "pipe" });
let logs = "";
server.stdout.on("data", b => logs += b); server.stderr.on("data", b => logs += b);
async function run(script) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: "inherit" });
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${script}: exit ${code}`)));
  });
}
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error("Acceptance server exited");
    try { if ((await fetch(BASE + "/ru/signin")).status === 200) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  assert.ok(ready, "Isolated acceptance server becomes ready");
  await run("scripts/e2e.mjs");
  await run("scripts/browser-smoke.mjs");
  await writeFile("artifacts/c31-platform-report.json", JSON.stringify({ httpJourneys: "passed", browserJourneys: "passed", staffMfa: "included", realEmailsSent: false, externalPayments: false }, null, 2));
} finally {
  server.kill("SIGTERM");
  await writeFile("artifacts/c31-platform-server.log", logs);
}
