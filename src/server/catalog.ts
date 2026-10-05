import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { GAMES, type Game, type Platform } from "../lib/games.ts";
import { isAdmin } from "./access.ts";
import { requireStepUp } from "./mfa.ts";
import { audit } from "./audit.ts";
import { fail } from "./errors.ts";
import * as v from "./validate.ts";

export const CATALOG_FORMATS = [
  "single_elimination",
  "double_elimination",
  "round_robin",
  "swiss",
  "groups",
  "gauntlet",
  "ffa",
  "leaderboard",
] as const;
export const GAME_MODES = [
  "head_to_head",
  "battle_royale",
  "racing",
  "other",
] as const;
export type CatalogGame = Game & {
  mode: (typeof GAME_MODES)[number];
  formats: string[];
  retired: boolean;
  version: number;
};
export const initialGame = (g: Game): CatalogGame => ({
  ...g,
  mode:
    g.scoring === "racing"
      ? "racing"
      : g.bracket
        ? "head_to_head"
        : "battle_royale",
  formats: g.bracket ? [...CATALOG_FORMATS] : ["ffa", "leaderboard"],
  retired: false,
  version: 1,
});
type CatalogRow = {
  slug: string;
  data: CatalogGame;
  retired: boolean;
  version: number;
};
const fromRow = (r: CatalogRow): CatalogGame => ({
  ...r.data,
  slug: r.slug,
  retired: r.retired,
  version: r.version,
});
export async function listGames(
  q: Queryable,
  includeRetired = false,
): Promise<CatalogGame[]> {
  return (
    await q.query<CatalogRow>(
      "select slug,data,retired,version from game_catalog where ($1 or not retired) order by sort_order,lower(data->>'name'),slug",
      [includeRetired],
    )
  ).map(fromRow);
}
export async function findGame(
  q: Queryable,
  slug: unknown,
): Promise<CatalogGame | null> {
  if (typeof slug !== "string") return null;
  const [r] = await q.query<CatalogRow>(
    "select slug,data,retired,version from game_catalog where slug=$1 for share",
    [slug],
  );
  return r ? fromRow(r) : null;
}
export async function requireCatalogGame(
  q: Queryable,
  slug: unknown,
  active = true,
): Promise<CatalogGame> {
  const g = await findGame(q, slug);
  if (!g || (active && g.retired)) fail("invalid_game");
  return g!;
}
/** Public read fallback only. Write paths always read the authoritative database. */
export async function publicGames(
  q: Queryable | null,
  includeRetired = false,
): Promise<CatalogGame[]> {
  return q ? listGames(q, includeRetired) : GAMES.map(initialGame);
}
export type GameInput = Record<string, unknown>;
export async function saveGame(
  db: Database,
  actor: SessionUser,
  input: GameInput,
) {
  if (!isAdmin(actor)) fail("forbidden");
  requireStepUp(actor);
  const slug = v.oneLine(input.slug, 48);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) fail("invalid_input");
  const name = v.displayName(input.name, 80),
    teamSize = v.intIn(input.teamSize, 1, 10);
  const mode = GAME_MODES.includes(input.mode as never)
    ? (input.mode as CatalogGame["mode"])
    : fail("invalid_input");
  const platforms = Array.isArray(input.platforms)
    ? ([...new Set(input.platforms)].map(String) as Platform[])
    : [];
  const formats = Array.isArray(input.formats)
    ? [...new Set(input.formats)].map(String)
    : [];
  if (
    !platforms.length ||
    platforms.some((p) => !["pc", "console", "mobile"].includes(p)) ||
    !formats.length ||
    formats.some((f) => !CATALOG_FORMATS.includes(f as never))
  )
    fail("invalid_input");
  const genre = {
    ru: v.displayName(input.genreRu, 80),
    en: v.displayName(input.genreEn, 80),
  };
  const reason = v.clean(input.reason, 500);
  if (reason.length < 10) fail("invalid_input");
  const expected = v.intIn(input.version ?? 0, 0, 2147483647);
  return db.tx(async (q) => {
    await q.query("select pg_advisory_xact_lock($1)", [7461330]);
    const old = await findGame(q, slug);
    if (old ? old.version !== expected : expected !== 0) fail("not_editable");
    const g: CatalogGame = {
      slug,
      name,
      teamSize,
      platforms,
      mode,
      formats,
      genre,
      bracket: formats.some((f) => !["ffa", "leaderboard"].includes(f)),
      ...(mode === "racing" ? { scoring: "racing" as const } : {}),
      ...(old?.apiNote ? { apiNote: old.apiNote } : {}),
      ...(old?.legacy ? { legacy: true } : {}),
      retired: input.retired === "1" || input.retired === true,
      version: expected + 1,
    };
    await q.query(
      `insert into game_catalog(slug,data,retired,version,updated_by) values($1,$2,$3,1,$4)
      on conflict(slug) do update set data=excluded.data,retired=excluded.retired,version=game_catalog.version+1,updated_by=$4,updated_at=now()`,
      [slug, JSON.stringify(g), g.retired, actor.id],
    );
    await audit(q, {
      actorId: actor.id,
      action: old ? "game.updated" : "game.created",
      entity: "game",
      entityId: slug,
      data: { before: old, after: g, reason },
    });
    return g;
  });
}
