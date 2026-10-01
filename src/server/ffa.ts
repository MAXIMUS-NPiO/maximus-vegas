/**
 * Free-for-all lobbies, version MV-FFA-1. Pure — no I/O, covered by unit tests.
 *
 *  - Entrants (players or squads) are dealt into lobbies of at most `lobbySize` in a snake by seed.
 *  - Every lobby plays `games` games per round. A game result gives every entrant who played a unique
 *    placement 1…m and a number of kills; an entrant who did not play scores nothing in that game.
 *  - Points of a game = placement points from the organiser's table (places beyond the table score 0)
 *    + kills × kill points.
 *  - Lobby table: points → games won → kills → best single-game placement → seed. Disqualified entrants are
 *    listed last and hold no rank.
 *  - With several lobbies, the top `advance` of each lobby go to the next round — never a whole lobby (at most
 *    its ranked entrants minus one, at least one) — re-seeded across lobbies by lobby place, then points per
 *    game played, wins, kills and seed. A round with a single lobby is the final.
 *  - Final places: the final lobby by its table; entrants eliminated earlier follow, later rounds first; within
 *    a round, the same lobby place is a shared place.
 */
import { fail } from "./errors.ts";
import { snakeGroups } from "./stages.ts";

export const FFA_VERSION = "MV-FFA-1";
export const FFA_DEFAULT_POINTS = [10, 6, 5, 4, 3, 2, 1, 1];
export const FFA_MAX_LOBBY = 100;
export const FFA_MAX_GAMES = 12;
export const FFA_MAX_ROUNDS = 20;

export type FfaSettings = {
  v: 1;
  lobbySize: number;
  games: number;
  advance: number;
  placementPoints: number[];
  killPoints: number;
  /** Hours between rounds: round r is scheduled at the start + (r − 1) × hours; 0 = only round 1 is dated. */
  roundHours: number;
  ffa: string;
};

export type FfaSettingsInput = {
  lobbySize?: unknown;
  ffaGames?: unknown;
  ffaAdvance?: unknown;
  ffaPoints?: unknown;
  killPoints?: unknown;
  roundHours?: unknown;
};

const intOr = (value: unknown, fallback: number, min: number, max: number) => {
  const text = String(value ?? "").trim();
  if (text === "") return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < min || n > max) fail("invalid_ffa_settings");
  return n;
};

/** Placement points: 1–64 whole numbers 0–1000, never rising for lower places. */
export function parsePointsTable(value: unknown): number[] {
  const text = String(value ?? "").trim();
  if (!text) return [...FFA_DEFAULT_POINTS];
  const list = text.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (!list.length || list.length > 64 || list.some((n) => !Number.isInteger(n) || n < 0 || n > 1000)) fail("invalid_ffa_settings");
  for (let i = 1; i < list.length; i++) if (list[i] > list[i - 1]) fail("invalid_ffa_settings");
  return list;
}

export function parseFfaSettings(input: FfaSettingsInput): FfaSettings {
  const lobbySize = intOr(input.lobbySize, 16, 2, FFA_MAX_LOBBY);
  return {
    v: 1,
    lobbySize,
    games: intOr(input.ffaGames, 3, 1, FFA_MAX_GAMES),
    advance: intOr(input.ffaAdvance, Math.max(1, Math.floor(lobbySize / 2)), 1, FFA_MAX_LOBBY - 1),
    placementPoints: parsePointsTable(input.ffaPoints),
    killPoints: intOr(input.killPoints, 1, 0, 10),
    roundHours: intOr(input.roundHours, 0, 0, 720),
    ffa: FFA_VERSION,
  };
}

/** Stored settings with defaults filled in (defensive against partial JSON). */
export function ffaSettingsOf(t: { format_settings?: unknown }): FfaSettings {
  const raw = (t.format_settings ?? {}) as Partial<FfaSettings>;
  const lobbySize = Number.isInteger(raw.lobbySize) ? raw.lobbySize! : 16;
  return {
    v: 1,
    lobbySize,
    games: Number.isInteger(raw.games) ? raw.games! : 3,
    advance: Number.isInteger(raw.advance) ? raw.advance! : Math.max(1, Math.floor(lobbySize / 2)),
    placementPoints: Array.isArray(raw.placementPoints) ? raw.placementPoints.map(Number) : [...FFA_DEFAULT_POINTS],
    killPoints: Number.isInteger(raw.killPoints) ? raw.killPoints! : 1,
    roundHours: Number.isInteger(raw.roundHours) ? raw.roundHours! : 0,
    ffa: raw.ffa ?? FFA_VERSION,
  };
}

export const lobbyCount = (entrants: number, lobbySize: number) => Math.max(1, Math.ceil(entrants / lobbySize));

/** Lobbies of a round, in a snake by seed (ids in seed order). */
export const dealLobbies = <T>(seeded: T[], lobbySize: number) => snakeGroups(seeded, lobbyCount(seeded.length, lobbySize));

export type GameLine = { reg: string; placement: number; kills: number };
export type FfaEntrant = { id: string; seed: number; disqualified?: boolean };
export type FfaGame = { status: string; lines: GameLine[] };
export type FfaRow = {
  id: string;
  seed: number;
  disqualified: boolean;
  played: number;
  wins: number;
  kills: number;
  placementPoints: number;
  killPoints: number;
  points: number;
  /** Best single-game placement (null before the first game). */
  best: number | null;
  rank: number | null;
};

export const placementPoints = (table: number[], placement: number) => table[placement - 1] ?? 0;

/**
 * Validates a game result: every listed entrant belongs to the lobby, those who played hold the placements
 * 1…m exactly once, kills are 0–999. Entrants without a placement did not play.
 */
export function validateGame(lobby: string[], lines: Array<{ reg: string; placement: unknown; kills: unknown }>): GameLine[] {
  const members = new Set(lobby);
  const out: GameLine[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    if (!members.has(l.reg) || seen.has(l.reg)) fail("invalid_ffa_results");
    seen.add(l.reg);
    const placementText = String(l.placement ?? "").trim();
    if (placementText === "") continue;
    const placement = Number(placementText);
    const killsText = String(l.kills ?? "").trim();
    const kills = killsText === "" ? 0 : Number(killsText);
    if (!Number.isInteger(placement) || placement < 1 || !Number.isInteger(kills) || kills < 0 || kills > 999) fail("invalid_ffa_results");
    out.push({ reg: l.reg, placement, kills });
  }
  if (!out.length) fail("invalid_ffa_results");
  const places = out.map((l) => l.placement).sort((a, b) => a - b);
  if (places.some((p, i) => p !== i + 1)) fail("invalid_ffa_results");
  return out.sort((a, b) => a.placement - b.placement);
}

/** Ordering of lobby rows: disqualified last, then points, wins, kills, best placement, seed. */
export function ffaOrder(x: FfaRow, y: FfaRow): number {
  if (x.disqualified !== y.disqualified) return x.disqualified ? 1 : -1;
  const keys = [y.points - x.points, y.wins - x.wins, y.kills - x.kills, (x.best ?? 1e9) - (y.best ?? 1e9)];
  for (const k of keys) if (k !== 0) return k;
  return x.seed - y.seed;
}

/** The table of one lobby from its completed games. */
export function lobbyTable(entrants: FfaEntrant[], games: FfaGame[], settings: Pick<FfaSettings, "placementPoints" | "killPoints">): FfaRow[] {
  const rows = new Map<string, FfaRow>(
    entrants.map((e) => [
      e.id,
      { id: e.id, seed: e.seed, disqualified: Boolean(e.disqualified), played: 0, wins: 0, kills: 0, placementPoints: 0, killPoints: 0, points: 0, best: null, rank: null },
    ]),
  );
  for (const g of games) {
    if (g.status !== "completed") continue;
    for (const l of g.lines) {
      const row = rows.get(l.reg);
      if (!row) continue;
      row.played += 1;
      if (l.placement === 1) row.wins += 1;
      row.kills += l.kills;
      row.placementPoints += placementPoints(settings.placementPoints, l.placement);
      row.killPoints += l.kills * settings.killPoints;
      row.best = row.best === null ? l.placement : Math.min(row.best, l.placement);
    }
  }
  const sorted = [...rows.values()];
  for (const r of sorted) r.points = r.placementPoints + r.killPoints;
  sorted.sort(ffaOrder);
  let rank = 0;
  for (const r of sorted) r.rank = r.disqualified ? null : ++rank;
  return sorted;
}

/** How many leave a lobby for the next round: never all ranked entrants, at least one while anyone is ranked. */
export function advancingCount(rows: FfaRow[], advance: number): number {
  const ranked = rows.filter((r) => r.rank !== null).length;
  if (ranked === 0) return 0;
  return Math.min(advance, Math.max(1, ranked - 1));
}

const perGame = (value: number, played: number) => (played > 0 ? value / played : 0);

/**
 * Qualifiers for the next round in seed order: all lobby winners first (ordered across lobbies), then
 * second places, and so on. Lobbies may differ in size and games played, so points are compared per game.
 */
export function nextRoundSeeds(lobbies: FfaRow[][], advance: number): string[] {
  const tiers = new Map<number, Array<FfaRow & { lobby: number }>>();
  lobbies.forEach((rows, lobby) => {
    const n = advancingCount(rows, advance);
    for (const r of rows) if (r.rank !== null && r.rank <= n) tiers.set(r.rank, [...(tiers.get(r.rank) ?? []), { ...r, lobby }]);
  });
  const out: string[] = [];
  for (const tier of [...tiers.keys()].sort((a, b) => a - b)) {
    const rows = tiers.get(tier)!;
    rows.sort(
      (x, y) =>
        perGame(y.points, y.played) - perGame(x.points, x.played) ||
        perGame(y.wins, y.played) - perGame(x.wins, x.played) ||
        perGame(y.kills, y.played) - perGame(x.kills, x.played) ||
        x.seed - y.seed ||
        x.lobby - y.lobby,
    );
    out.push(...rows.map((r) => r.id));
  }
  return out;
}

/** The rounds an event of n entrants would play (for previews): entrants and lobbies per round. */
export function planRounds(n: number, settings: Pick<FfaSettings, "lobbySize" | "advance">): Array<{ round: number; entrants: number; lobbies: number }> {
  const out: Array<{ round: number; entrants: number; lobbies: number }> = [];
  let entrants = n;
  for (let round = 1; round <= FFA_MAX_ROUNDS && entrants >= 2; round++) {
    const lobbies = lobbyCount(entrants, settings.lobbySize);
    out.push({ round, entrants, lobbies });
    if (lobbies === 1) break;
    const sizes = snakeGroups(Array.from({ length: entrants }, (_, i) => i), lobbies).map((g) => g.length);
    entrants = sizes.reduce((sum, size) => sum + Math.min(settings.advance, Math.max(1, size - 1)), 0);
  }
  return out;
}

/** An event of n entrants reaches a single final lobby within the round limit. */
export const ffaPlanConverges = (n: number, settings: Pick<FfaSettings, "lobbySize" | "advance">) => {
  const plan = planRounds(n, settings);
  return plan.length > 0 && plan[plan.length - 1].lobbies === 1;
};

export type FfaRound = { round: number; lobbies: FfaRow[][] };

/**
 * Final places. `rounds` holds every played round with its lobby tables (in round order); `survivors` are the
 * entrants who qualified out of the last round when it was not a single-lobby final (the event ended because
 * fewer than two qualified): they take the first places.
 */
export function ffaPlaces(rounds: FfaRound[], survivors: string[] = []): Map<string, number> {
  const places = new Map<string, number>();
  let base = 0;
  for (const id of survivors) places.set(id, ++base);
  for (let i = rounds.length - 1; i >= 0; i--) {
    const round = rounds[i];
    const later = new Set<string>(survivors);
    for (let j = i + 1; j < rounds.length; j++) for (const lobby of rounds[j].lobbies) for (const r of lobby) later.add(r.id);
    const out = round.lobbies.flat().filter((r) => r.rank !== null && !later.has(r.id) && !places.has(r.id));
    for (const r of out) places.set(r.id, base + 1 + out.filter((o) => o.rank! < r.rank!).length);
    base += out.length;
  }
  return places;
}

/** Points table as the organiser writes it ("10, 6, 5 …"). */
export const pointsText = (table: number[]) => table.join(", ");
