import { createHash } from "node:crypto";
import type { Database } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { fail } from "./errors.ts";
import { activeAccount } from "./product-access.ts";
import { audit } from "./audit.ts";
import { readJsonText } from "./json-api.ts";
import { ANCHOR_RUNTIME_SHA256, matchesAnchor, type AnchorReceipt } from "../lib/stats-anchor.ts";
export function anchorConfiguration() {
  const rpc = process.env.MV_ANCHOR_RPC_URL, contract = process.env.MV_ANCHOR_CONTRACT, chain = process.env.MV_ANCHOR_CHAIN_ID;
  if (!rpc?.startsWith("https://") || !/^0x[0-9a-f]{40}$/i.test(contract ?? "") || !/^\d+$/.test(chain ?? "")) return null;
  return { rpc: rpc!, contract: contract!, chain: chain! };
}
export async function verifyAndRecordAnchor(db: Database, user: SessionUser, id: string, transaction: string) {
  await activeAccount(db, user);
  const configuration = anchorConfiguration(); if (!configuration) return fail("feature_disabled");
  if (!/^0x[0-9a-f]{64}$/i.test(transaction)) fail("invalid_input");
  const [s] = await db.query<{ root: string; leaf_count: number }>("select root,leaf_count from stats_snapshots where id=$1 and user_id=$2 and shared", [id, user.id]); if (!s) fail("not_found");
  const rpc = async (method: string, params: unknown[]) => {
    const response = await fetch(configuration.rpc, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000), redirect: "error", cache: "no-store" });
    if (!response.ok) return fail("provider_error");
    const data = JSON.parse(await readJsonText(response, 200_000)); if (data.error || data.result === undefined) return fail("provider_error"); return data.result;
  };
  // Read-only RPC only. The portal never holds a blockchain spending key or broadcasts a transaction.
  const [chain, head, receipt, code] = await Promise.all([rpc("eth_chainId", []), rpc("eth_blockNumber", []), rpc("eth_getTransactionReceipt", [transaction]), rpc("eth_getCode", [configuration.contract, "latest"])]);
  if (BigInt(chain).toString() !== configuration.chain || !/^0x[0-9a-f]+$/i.test(code) || createHash("sha256").update(Buffer.from(code.slice(2), "hex")).digest("hex") !== ANCHOR_RUNTIME_SHA256) fail("invalid_evidence");
  if (!matchesAnchor(receipt as AnchorReceipt, { id, root: s.root, count: s.leaf_count, contract: configuration.contract, transaction }, BigInt(head))) fail("invalid_evidence");
  const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  if (!block || block.hash !== receipt.blockHash) fail("invalid_evidence");
  await db.tx(async q => {
    const [current] = await q.query("select 1 from stats_snapshots where id=$1 and user_id=$2 and shared for update", [id, user.id]); if (!current) fail("not_found");
    await q.query("insert into stats_anchors(snapshot_id,chain_id,contract_address,transaction_hash,block_number,recorded_by) values($1,$2,$3,$4,$5,$6) on conflict(snapshot_id) do nothing", [id, configuration.chain, configuration.contract.toLowerCase(), transaction.toLowerCase(), BigInt(receipt.blockNumber).toString(), user.id]);
    await audit(q, { actorId: user.id, action: "stats.anchor_verified", entity: "stats_snapshot", entityId: id, data: { chain: configuration.chain, transaction, block: receipt.blockNumber } });
  });
}
