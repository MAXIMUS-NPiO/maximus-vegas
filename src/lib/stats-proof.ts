import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalStats } from "./stats-canonical.ts";
export { canonicalStats } from "./stats-canonical.ts";

/** MV-STATS-1 uses canonical JSON, SHA-256 with separate leaf/node prefixes and Ed25519. */
const hash = (...values: Array<string | Uint8Array>) => { const h = createHash("sha256"); for (const v of values) h.update(v); return h.digest("hex"); };
export const leafHash = (record: unknown) => hash(new Uint8Array([0]), canonicalStats(record));
export type MerkleProof = Array<{ side: "left" | "right"; hash: string }>;
export function merkleTree(records: unknown[]) {
  const levels = [records.map(leafHash)];
  if (!levels[0].length) return { root: hash(new Uint8Array([0])), proofs: [] as MerkleProof[] };
  while (levels[levels.length - 1].length > 1) {
    const current = levels[levels.length - 1], next: string[] = [];
    for (let i = 0; i < current.length; i += 2) next.push(hash(new Uint8Array([1]), Buffer.from(current[i], "hex"), Buffer.from(current[i + 1] ?? current[i], "hex")));
    levels.push(next);
  }
  const proofs = records.map((_, index) => {
    const proof: MerkleProof = []; let at = index;
    for (let level = 0; level < levels.length - 1; level++) { const values = levels[level]; const sibling = at % 2 ? at - 1 : Math.min(at + 1, values.length - 1); proof.push({ side: at % 2 ? "left" : "right", hash: values[sibling] }); at = Math.floor(at / 2); }
    return proof;
  });
  return { root: levels[levels.length - 1][0], proofs };
}
export function verifyMerkle(record: unknown, proof: MerkleProof, root: string) {
  if (!/^[a-f0-9]{64}$/.test(root) || !Array.isArray(proof) || proof.length > 32) return false;
  let h = leafHash(record);
  for (const step of proof) {
    if (!step || typeof step !== "object" || !/^[a-f0-9]{64}$/.test(step.hash) || !["left", "right"].includes(step.side)) return false;
    const left = step.side === "left" ? step.hash : h, right = step.side === "left" ? h : step.hash;
    h = hash(new Uint8Array([1]), Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  }
  return h === root;
}
export const statsEnvelope = (source: string, nonce: string, timestamp: string, body: string) => `MV-STATS-1\n${source}\n${nonce}\n${timestamp}\n${body}`;
export function verifyStatsSignature(key: string, signature: string, envelope: string) {
  try { const publicKey = createPublicKey(key); return publicKey.asymmetricKeyType === "ed25519" && verify(null, Buffer.from(envelope), publicKey, Buffer.from(signature, "base64")); } catch { return false; }
}
