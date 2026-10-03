import { readFileSync } from "node:fs";
import { canonicalStats, merkleTree, verifyMerkle, verifyStatsSignature } from "../src/lib/stats-proof.ts";
import { anchorCalldata, datasetFor } from "../src/lib/stats-anchor.ts";
const file = process.argv[2]; if (!file) throw new Error("Usage: node --experimental-strip-types scripts/verify-statistics.mjs proof.json [--index N] [--calldata]");
const raw = readFileSync(file, "utf8"); if (Buffer.byteLength(raw) > 3_000_000) throw new Error("Proof file too large"); const p = JSON.parse(raw);
const tree = Array.isArray(p.records) ? merkleTree(p.records) : null;
const integrity = tree ? tree.root === p.root && p.records.length === p.count : p.proof ? verifyMerkle(p.record, p.proof, p.root) : null;
const signature = p.signature && p.publicKey ? verifyStatsSignature(p.publicKey, p.signature, canonicalStats({ version: p.version, id: p.id, root: p.root, count: p.count })) : null;
console.log(JSON.stringify({ integrity, signature, root: p.root, count: p.count, dataset: datasetFor(p.id) }));
if (integrity === false || signature === false) process.exitCode = 1;
const at = process.argv.indexOf("--index");
if (at >= 0) { const index = Number(process.argv[at + 1]); if (!tree || !Number.isSafeInteger(index) || index < 0 || index >= p.records.length) throw new Error("Record index out of range"); console.log(JSON.stringify({ version: p.version, id: p.id, count: p.count, root: p.root, signature: p.signature, publicKey: p.publicKey, record: p.records[index], proof: tree.proofs[index] }, null, 2)); }
if (process.argv.includes("--calldata")) { if (integrity !== true) throw new Error("Verify the complete records before preparing calldata"); console.log(JSON.stringify({ data: anchorCalldata(p.id, p.root, p.count), value: "0x0", sent: false })); }
