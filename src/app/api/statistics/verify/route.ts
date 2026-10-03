import { json, jsonContext, jsonError } from "@/server/json-api.ts";
import { verifyMerkle, type MerkleProof } from "@/lib/stats-proof.ts";
export async function POST(request: Request) {
  try {
    const { data } = await jsonContext(request, "stats.verify", 100_000);
    return json({ valid: verifyMerkle(data.record, data.proof as MerkleProof, String(data.root ?? "")) });
  } catch (error) { return jsonError(error); }
}
