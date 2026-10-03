import { canonicalStats } from "./stats-canonical.ts";
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, "0")).join("");
const bytes = (s: string) => new Uint8Array(s.match(/.{2}/g)!.map(x => parseInt(x, 16)));
async function hash(prefix: number, ...arrays: Uint8Array[]) { const data = new Uint8Array(1 + arrays.reduce((n, a) => n + a.length, 0)); data[0] = prefix; let offset = 1; for (const array of arrays) { data.set(array, offset); offset += array.length; } return hex(await crypto.subtle.digest("SHA-256", data)); }
export async function verifyProofFile(file: { version: string; id: string; root: string; count: number; records?: unknown[]; record?: unknown; proof?: Array<{ side: string; hash: string }>; signature?: string; publicKey?: string }) {
  if (file.version !== "MV-STATS-1" || !/^[a-f0-9]{64}$/.test(file.root)) throw new Error("Invalid proof format");
  let integrity: boolean | null = null;
  if (Array.isArray(file.records)) {
    if (file.records.length > 20001 || file.records.length !== file.count) return { integrity: false, signature: null };
    let level: string[] = [];
    for (let at = 0; at < file.records.length; at += 256) level.push(...await Promise.all(file.records.slice(at, at + 256).map(r => hash(0, new TextEncoder().encode(canonicalStats(r))))));
    if (!level.length) level = [await hash(0)];
    while (level.length > 1) { const next = []; for (let i = 0; i < level.length; i += 2) next.push(await hash(1, bytes(level[i]), bytes(level[i + 1] ?? level[i]))); level = next; }
    integrity = level[0] === file.root;
  } else if (Array.isArray(file.proof) && file.proof.length <= 32 && "record" in file) {
    let value = await hash(0, new TextEncoder().encode(canonicalStats(file.record)));
    for (const step of file.proof) { if (!/^[a-f0-9]{64}$/.test(step.hash) || !["left", "right"].includes(step.side)) throw new Error("Invalid proof path"); value = step.side === "left" ? await hash(1, bytes(step.hash), bytes(value)) : await hash(1, bytes(value), bytes(step.hash)); }
    integrity = value === file.root;
  }
  let signature: boolean | null = null;
  if (file.signature && file.publicKey) {
    const pem = file.publicKey.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("spki", der, "Ed25519", false, ["verify"]);
    signature = await crypto.subtle.verify("Ed25519", key, Uint8Array.from(atob(file.signature), c => c.charCodeAt(0)), new TextEncoder().encode(canonicalStats({ version: file.version, id: file.id, root: file.root, count: file.count })));
  }
  return { integrity, signature };
}
