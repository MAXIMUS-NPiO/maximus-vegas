import { context, errorCode, redirect, sameOrigin, withParam } from "@/server/http.ts";
import { fail } from "@/server/errors.ts";
import { gate } from "@/server/system.ts";
import { beginSteamVerification, connectExperience, disconnectExperience, disconnectSteamIdentity, refreshExperience, setExperienceSharing, setPartnerExperienceSharing } from "@/server/player-experience.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function POST(request: Request, route: { params: Promise<{ action: string }> }) {
  let lang: "ru" | "en" = "ru";
  try {
    if (!sameOrigin(request)) fail("bad_origin");
    if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded") || Number(request.headers.get("content-length") ?? 0) > 4096) fail("invalid_input");
    const reader = request.body?.getReader(); if (!reader) return fail("invalid_input");
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 4096) { await reader.cancel(); fail("file_too_large"); } chunks.push(part.value); }
    const c = await context(new Request(request.url, { method: "POST", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") })); lang = c.lang;
    if (!c.user) return fail("unauthorized");
    const { action } = await route.params, { db, user, form } = c;
    const back = `/${lang}/experience`;
    // Withdrawing consent remains possible even while a feature is paused.
    if (!["disconnect", "disconnect-steam", "sharing", "partner-sharing"].includes(action)) await gate(db, "stats.link", user);
    let result = "saved";
    if (action === "verify-steam") return redirect((await beginSteamVerification(db, user, { lang, consent: form.consent === "on" })).url);
    if (action === "connect") {
      const id = await connectExperience(db, user, { provider: form.provider, consent: form.consent === "on", shared: form.shared === "on" });
      await refreshExperience(db, user, id); result = "connected";
    } else if (action === "refresh") { await refreshExperience(db, user, form.connection ?? ""); result = "checked"; }
    else if (action === "sharing") await setExperienceSharing(db, user, form.connection ?? "", form.shared === "on");
    else if (action === "partner-sharing") await setPartnerExperienceSharing(db, user, form.shared === "on");
    else if (action === "disconnect") { if (form.confirm !== "on") fail("consent_required"); await disconnectExperience(db, user, form.connection ?? ""); result = "disconnected"; }
    else if (action === "disconnect-steam") { if (form.confirm !== "on") fail("consent_required"); await disconnectSteamIdentity(db, user); result = "disconnected"; }
    else fail("invalid_input");
    return redirect(`${back}?result=${result}`);
  } catch (error) { return redirect(withParam(`/${lang}/experience`, "e", errorCode(error))); }
}
