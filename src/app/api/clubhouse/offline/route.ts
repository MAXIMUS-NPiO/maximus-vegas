import { json, jsonContext, jsonError } from "@/server/json-api.ts";
import { offlineManifest, syncOfflineScan } from "@/server/clubhouse.ts";
import { requireStaffMfa } from "@/server/mfa.ts";
import { fail } from "@/server/errors.ts";
export async function POST(request: Request) {
  try {
    const { db, user, data } = await jsonContext(request, "club.offline");
    await requireStaffMfa(db, user);
    if (data.action === "manifest") {
      const venue = String(data.venue ?? ""); if (!/^[0-9a-f-]{36}$/i.test(venue)) fail("invalid_input");
      return json(await offlineManifest(db, user, venue));
    }
    if (data.action !== "sync") fail("invalid_input");
    const result = await syncOfflineScan(db, user, { id: String(data.id ?? ""), manifest: String(data.manifest ?? ""), token: String(data.token ?? ""), observedAt: String(data.observedAt ?? "") });
    return json({ result });
  } catch (error) { return jsonError(error); }
}
