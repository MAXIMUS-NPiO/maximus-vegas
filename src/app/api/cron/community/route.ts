import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/server/db.ts";
import { sweepCommunityVoice } from "@/server/community-voice.ts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  const expected=Buffer.from(process.env.CRON_SECRET??""),supplied=Buffer.from(request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")??"");
  if(expected.length<16 || expected.length!==supplied.length || !timingSafeEqual(expected,supplied)) return new Response("Not found",{status:404});
  try { return Response.json(await sweepCommunityVoice(await getDb()),{headers:{"Cache-Control":"no-store"}}); }
  catch { return Response.json({error:"cleanup_failed"},{status:503,headers:{"Cache-Control":"no-store"}}); }
}
