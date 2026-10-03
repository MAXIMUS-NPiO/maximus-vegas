import { createHash } from "node:crypto";
export const ANCHOR_EVENT = "0xf2270ca1abc2180be7e9d1a28d9a44740c091cfa7d29aeb62b89e48a09517ffb";
export const ANCHOR_RUNTIME_SHA256 = "b61146b3bda6fd31f1e965055ff2fe36086806fd5ce9df490ec9ecbcf8e04094";
export const datasetFor = (id: string) => createHash("sha256").update(`MV-STATS-1:${id}`).digest("hex");
export function anchorCalldata(id: string, root: string, count: number) {
  if (!/^[a-f0-9]{64}$/.test(root) || !Number.isSafeInteger(count) || count < 1) throw new Error("Invalid snapshot");
  return `0x5d610ec5${datasetFor(id)}${root}${BigInt(count).toString(16).padStart(64, "0")}`;
}
export type AnchorReceipt = { status: string; to: string; transactionHash: string; blockNumber: string; blockHash: string; logs: Array<{ address: string; topics: string[]; data: string; removed?: boolean; blockHash: string }> };
export function matchesAnchor(receipt: AnchorReceipt, expected: { id: string; root: string; count: number; contract: string; transaction: string }, head: bigint, confirmations = 12) {
  try {
    if (receipt.status !== "0x1" || receipt.to.toLowerCase() !== expected.contract.toLowerCase() || receipt.transactionHash.toLowerCase() !== expected.transaction.toLowerCase() || !/^0x[0-9a-f]+$/i.test(receipt.blockNumber) || head - BigInt(receipt.blockNumber) + 1n < BigInt(confirmations)) return false;
    return receipt.logs.some(log => !log.removed && log.blockHash === receipt.blockHash && log.address.toLowerCase() === expected.contract.toLowerCase()
      && log.topics.length === 2 && log.topics[0].toLowerCase() === ANCHOR_EVENT && log.topics[1].toLowerCase() === `0x${datasetFor(expected.id)}`
      && log.data.toLowerCase() === `0x${expected.root}${BigInt(expected.count).toString(16).padStart(64, "0")}`);
  } catch { return false; }
}
