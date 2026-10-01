import { NextResponse } from "next/server";
import { getDb } from "@/server/db.ts";
import { overlayData } from "@/server/streams.ts";
import { matchLabel } from "@/components/tournament";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
const error = (status: number, code: string) => NextResponse.json({ error: { code } }, { status, headers });

/**
 * Overlay data of a public match for broadcast tools (MV-MEDIA-1): names, round, series length, status and
 * score from the match record — `official` once confirmed, `reported` while a submitted result waits.
 * GET /api/overlay/matches/{id}?lang=ru|en
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return error(404, "not_found");
  const lang = new URL(request.url).searchParams.get("lang") === "en" ? "en" : "ru";
  let db;
  try {
    db = await getDb();
  } catch {
    return error(503, "unavailable");
  }
  const o = await overlayData(db, id);
  if (!o) return error(404, "not_found");
  const m = o.match;
  return NextResponse.json(
    {
      data: {
        tournament: { name: m.t_name, slug: m.t_slug, game: m.t_game },
        match: {
          id: m.id,
          label: matchLabel(m, { format: m.t_format, playoffFormat: o.playoffFormat, wRounds: m.w_rounds, lRounds: m.l_rounds, gRounds: m.bracket === "G" ? m.rounds : 0 }, lang),
          bestOf: o.bestOf,
          status: m.status,
          scheduledAt: m.scheduled_at,
          completedAt: m.completed_at,
        },
        a: { name: o.a },
        b: { name: o.b },
        score: o.score,
        winner: o.winner,
      },
    },
    { headers },
  );
}
