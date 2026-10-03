import { json, jsonContext, jsonError } from "@/server/json-api.ts";
import { rotateRentalKey } from "@/server/rentals.ts";
import { requireStaffMfa } from "@/server/mfa.ts";
import { fail } from "@/server/errors.ts";
export async function POST(request: Request) {
  try {
    const { db, user, data } = await jsonContext(request, "rental.key");
    if (typeof data.id !== "string" || !/^[a-f0-9-]{36}$/i.test(data.id)) fail("invalid_input");
    await requireStaffMfa(db, user);
    return json({ token: await rotateRentalKey(db, user, String(data.id), data.revoke === true) });
  } catch (error) { return jsonError(error); }
}
