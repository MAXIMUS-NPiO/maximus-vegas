import { getDb } from "@/server/db.ts";
import { json, jsonError, readJsonText } from "@/server/json-api.ts";
import { ingestStatistics } from "@/server/statistics.ts";
import { gate } from "@/server/system.ts";
export async function POST(request: Request) {
  try {
    const db = await getDb(); await gate(db, "stats.intake", null);
    const body = await readJsonText(request, 20000), header = (key: string) => request.headers.get(`MV-Stats-${key}`) ?? "";
    return json(await ingestStatistics(db, { source: header("Source"), nonce: header("Nonce"), timestamp: header("Timestamp"), signature: header("Signature") }, body));
  } catch (error) { return jsonError(error); }
}
