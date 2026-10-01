/**
 * Schedule conflicts, version MV-SCHEDULE-1. Pure — no I/O, covered by unit tests.
 *
 * Every timed open match occupies [start, start + its tournament's match length). Two such matches conflict
 * when their intervals overlap and they share
 *   - a venue (a stage, a station, a server: one match at a time), or
 *   - an entrant (the same registration cannot play two matches at once), or
 *   - a player (the same person on two rosters — in this tournament or in another one).
 * Matches without a time never conflict. Waves place a round's matches on the venues in turn: match i goes to
 * venue i mod V in wave ⌊i / V⌋, each wave one match length after the previous one.
 */
export const SCHEDULE_VERSION = "MV-SCHEDULE-1";
export const DEFAULT_MATCH_MINUTES = 60;

export type Slot = {
  id: string;
  tournamentId: string;
  start: number;
  minutes: number;
  venue: string | null;
  regs: string[];
  users: string[];
};

export type Conflict = { kind: "venue" | "entrant" | "player"; a: string; b: string; venue?: string; reg?: string; user?: string };

const overlaps = (x: Slot, y: Slot) => x.start < y.start + y.minutes * 60_000 && y.start < x.start + x.minutes * 60_000;

/**
 * Conflicts of the `focus` matches with each other and with `others` (matches of other tournaments, or of this
 * one outside the focus). Each pair is reported once per reason, in a stable order.
 */
export function findConflicts(focus: Slot[], others: Slot[] = []): Conflict[] {
  const out: Conflict[] = [];
  const seen = new Set<string>();
  const add = (c: Conflict) => {
    const [a, b] = c.a < c.b ? [c.a, c.b] : [c.b, c.a];
    const key = `${c.kind}:${a}:${b}:${c.venue ?? c.reg ?? c.user ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...c, a, b });
  };
  const all = [...focus, ...others.filter((o) => !focus.some((f) => f.id === o.id))];
  for (const x of focus) {
    for (const y of all) {
      if (x.id === y.id || !overlaps(x, y)) continue;
      if (x.tournamentId === y.tournamentId && x.venue && x.venue === y.venue) add({ kind: "venue", a: x.id, b: y.id, venue: x.venue });
      const reg = x.tournamentId === y.tournamentId ? x.regs.find((r) => y.regs.includes(r)) : undefined;
      if (reg) add({ kind: "entrant", a: x.id, b: y.id, reg });
      // The same person in two matches: reported once per pair, unless the shared entrant already explains it.
      else {
        const user = x.users.find((u) => y.users.includes(u));
        if (user) add({ kind: "player", a: x.id, b: y.id, user });
      }
    }
  }
  return out.sort((p, q) => p.kind.localeCompare(q.kind) || p.a.localeCompare(q.a) || p.b.localeCompare(q.b));
}

/** Venue and start of each match of a round, in waves over the venues. */
export function planWaves<T>(matches: T[], venues: string[], start: number, minutes: number): Array<{ match: T; venue: string; start: number }> {
  if (!venues.length) return [];
  return matches.map((match, i) => ({ match, venue: venues[i % venues.length], start: start + Math.floor(i / venues.length) * minutes * 60_000 }));
}
