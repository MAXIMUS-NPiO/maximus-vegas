import { after } from "next/server";
import { json, jsonContext, jsonError } from "@/server/json-api.ts";
import { sendTeamInvitation } from "@/server/team-invitation-delivery.ts";
import { drainOutbox, mailConfigured } from "@/server/mail.ts";
import { fail } from "@/server/errors.ts";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const { db, user, data } = await jsonContext(request, "team.invite", 5000);
    if (user.restricted) fail("account_restricted");
    const invitation = await sendTeamInvitation(db, user, { teamId: String(data.teamId ?? ""), username: data.username, email: data.email, lang: data.lang === "en" ? "en" : "ru", requestId: String(data.requestId ?? "") });
    if (mailConfigured()) after(() => drainOutbox(db, 10).catch(() => console.error("[invitation] mail queue deferred")));
    return json({ invitation });
  } catch (error) { return jsonError(error); }
}
