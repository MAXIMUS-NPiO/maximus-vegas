import type { BracketMatch } from "../server/queries.ts";

/** A match slot left empty on both sides by a short field (shown dashed, never played). */
export const isEmptySlot = (m: Pick<BracketMatch, "a_void" | "b_void">) => Boolean(m.a_void && m.b_void);
/** A real match still to be decided. */
export const isOpenMatch = (m: Pick<BracketMatch, "a_void" | "b_void" | "status">) => !isEmptySlot(m) && !["completed", "cancelled"].includes(m.status);
/** One of the viewer's entries plays in the match. */
export const hasEntry = (m: Pick<BracketMatch, "a_reg" | "b_reg">, mine?: Set<string>) =>
  Boolean(mine?.size && ((m.a_reg && mine.has(m.a_reg)) || (m.b_reg && mine.has(m.b_reg))));

export type RoundSummary = { round: number; done: number; total: number; mine: boolean };

/**
 * The rounds of one bracket for the phone list: played and total real matches per round, whether the viewer
 * has an open match in it, the round being played (the first with an open match, else the last), and the
 * viewer's first open match.
 */
export function roundSummary(matches: BracketMatch[], mine?: Set<string>) {
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  const summary: RoundSummary[] = rounds.map((round) => {
    const real = matches.filter((m) => m.round === round && !isEmptySlot(m));
    return {
      round,
      done: real.filter((m) => m.status === "completed").length,
      total: real.length,
      mine: real.some((m) => isOpenMatch(m) && hasEntry(m, mine)),
    };
  });
  const current = rounds.find((r) => matches.some((m) => m.round === r && isOpenMatch(m))) ?? rounds[rounds.length - 1] ?? null;
  const myMatch = [...matches].sort((a, b) => a.round - b.round || a.position - b.position).find((m) => isOpenMatch(m) && hasEntry(m, mine))?.id ?? null;
  return { rounds: summary, current, myMatch };
}
