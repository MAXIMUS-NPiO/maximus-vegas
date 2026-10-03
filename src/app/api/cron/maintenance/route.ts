import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/server/db.ts";
import { drainOutbox } from "@/server/mail.ts";
import { sweepPayments } from "@/server/billing.ts";
import { expireSocialCalls } from "@/server/social-calls.ts";
import { expireStale } from "@/server/challenges.ts";
import { pulseAllQueues } from "@/server/quickmatch.ts";
import { settleWars } from "@/server/clans.ts";
import { pruneApiUsage, pumpWebhooks } from "@/server/partner.ts";
import { recordRun } from "@/server/system.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Scheduled recovery: retries queued email, reconciles open payment attempts with the provider,
 * expires memberships, challenges and the quick-match queue, ends overdue ready checks, settles overdue clan wars, sends webhook deliveries. Requires CRON_SECRET (Vercel Cron sends it
 * as a Bearer token); without the secret the endpoint is disabled.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret || secret.length < 16 || given.length !== secret.length || !timingSafeEqual(Buffer.from(given), Buffer.from(secret)))
    return new Response("Not found", { status: 404 });
  const db = await getDb();
  const mail = await drainOutbox(db, 50);
  await sweepPayments(db);
  await expireStale(db);
  await expireSocialCalls(db);
  await pulseAllQueues(db);
  await settleWars(db);
  const webhooks = await pumpWebhooks(db);
  await pruneApiUsage(db);
  await recordRun(db, "maintenance", { mail, webhooks });
  return Response.json({ ok: true, mail, webhooks }, { headers: { "Cache-Control": "no-store" } });
}
