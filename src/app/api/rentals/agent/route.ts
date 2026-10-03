import { getDb } from "@/server/db.ts";
import { json, jsonError, readJsonBody } from "@/server/json-api.ts";
import { synchronizeRentalNode } from "@/server/rentals.ts";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const input = await readJsonBody(request);
    const token = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
    return json(await synchronizeRentalNode(await getDb(), token, input));
  } catch (error) { return jsonError(error); }
}
