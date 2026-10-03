/** Local-only UI acceptance data. No provider account, charge or remote stream is created. */
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/server/db.ts";
import { signUp } from "../src/server/auth.ts";
const dataDir = process.env.MV_DATA_DIR;
if (!dataDir?.startsWith("/tmp/c29-")) throw new Error("An isolated /tmp/c29- data directory is required");
const db = await openDatabase({ embedded: true, dataDir });
try {
  const tag = randomUUID().slice(0, 8);
  const account = await signUp(db, { email: `studio_${tag}@example.test`, username: `studio_${tag}`, displayName: "Studio acceptance",
    password: `test-${randomUUID()}`, adult: true, terms: true });
  await mkdir("artifacts", { recursive: true });
  await writeFile("artifacts/c29-browser-state.json", JSON.stringify({ cookies: [{ name: "mv_session", value: account.token, domain: "127.0.0.1", path: "/",
    httpOnly: true, secure: false, sameSite: "Lax", expires: Math.floor(Date.now() / 1000) + 86400 }], origins: [] }), { mode: 0o600 });
  console.log("Isolated studio account and browser state prepared.");
} finally { await db.close(); }
