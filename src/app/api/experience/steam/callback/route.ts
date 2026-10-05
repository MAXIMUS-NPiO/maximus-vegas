import { getDb } from "@/server/db.ts";
import { sessionUser, SESSION_COOKIE } from "@/server/auth.ts";
import { errorCode, parseCookies, redirect, withParam } from "@/server/http.ts";
import { fail } from "@/server/errors.ts";
import { gate } from "@/server/system.ts";
import { completeSteamVerification } from "@/server/player-experience.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams, lang = params.get("lang") === "en" ? "en" : "ru";
  try {
    const db = await getDb(), user = await sessionUser(db, parseCookies(request.headers.get("cookie"))[SESSION_COOKIE]);
    if (!user) return fail("unauthorized");
    await gate(db, "stats.link", user);
    const result = await completeSteamVerification(db, user, params);
    return redirect(`/${result.lang}/experience?result=verified`);
  } catch (error) { return redirect(withParam(`/${lang}/experience`, "e", errorCode(error))); }
}
