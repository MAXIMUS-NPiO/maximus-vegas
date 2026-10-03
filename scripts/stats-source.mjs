// Source-side signing helper. A private key is read locally and never sent to the portal.
import { createPrivateKey, sign, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
const arg = key => { const i = process.argv.indexOf(key); return i < 0 ? undefined : process.argv[i + 1]; };
const source = arg("--source"), keyPath = arg("--key"), inputPath = arg("--input");
if (!source || !keyPath || !inputPath) throw new Error("Usage: node scripts/stats-source.mjs --source UUID --key private.pem --input record.json [--send --portal https://www.maximus.vegas]");
if (!/^[0-9a-f-]{36}$/i.test(source)) throw new Error("Invalid source UUID");
const key = createPrivateKey(readFileSync(keyPath)); if (key.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 key required");
const body = readFileSync(inputPath, "utf8"); if (Buffer.byteLength(body) > 20000) throw new Error("Payload too large"); JSON.parse(body);
const nonce = arg("--nonce") ?? randomUUID(), timestamp = String(Math.floor(Date.now() / 1000));
const signature = sign(null, Buffer.from(`MV-STATS-1\n${source}\n${nonce}\n${timestamp}\n${body}`), key).toString("base64");
const headers = { "Content-Type": "application/json", "MV-Stats-Source": source, "MV-Stats-Nonce": nonce, "MV-Stats-Timestamp": timestamp, "MV-Stats-Signature": signature };
if (process.argv.includes("--send")) {
  const origin = new URL(arg("--portal") ?? "https://www.maximus.vegas"); if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/") throw new Error("HTTPS portal origin required");
  const response = await fetch(new URL("/api/statistics/intake", origin), { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(15000) });
  console.log(JSON.stringify({ status: response.status, response: await response.json() })); if (!response.ok) process.exitCode = 1;
} else console.log(JSON.stringify({ headers, body: JSON.parse(body), sent: false }, null, 2));
