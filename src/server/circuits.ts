/**
 * Circuits: a season of linked tournaments with cumulative points, qualification and divisions.
 * Rules version MV-CIRCUIT-1.
 *
 *  - Points per event: the points table gives points for 1st, 2nd, 3rd … place (tied places share the
 *    same row); any lower place earns the participation points. The event's weight multiplies them
 *    (100 = ×1.0), rounded half up to a whole number. Only completed events count; entrants without a
 *    place (disqualified, missed check-in) earn nothing.
 *  - Order: points → event wins → best place → events played → name.
 *  - Qualification: the top N of the table (of division 1 when there are divisions). A tournament can
 *    admit only the qualified entrants of a circuit.
 *  - Divisions: members are assigned to divisions; each event belongs to one division and only its
 *    members may enter. Closing the season freezes the table, promotes the top members of every lower
 *    division and relegates the bottom members of every upper division into the next season.
 *  - The points table is locked once an event is completed, so published standings never change
 *    retroactively. A closed season is read from its frozen table and is never recomputed.
 */
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { audit } from "./audit.ts";
import { canManageOrg, notify } from "./access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { uniqueSlug } from "./teams.ts";
import { gameBySlug } from "../lib/games.ts";
import * as v from "./validate.ts";

export const CIRCUIT_VERSION = "MV-CIRCUIT-1";
export const MAX_DIVISIONS = 5;

export type CircuitRow = {
  id: string;
  slug: string;
  org_id: string;
  name: string;
  season: string;
  game: string;
  participant_type: "solo" | "team";
  description: string;
  points_table: number[];
  participation_points: number;
  qualify_top: number;
  divisions: number;
  promote: number;
  relegate: number;
  status: "active" | "closed";
  rules_version: string;
  previous_id: string | null;
  created_by: string;
  created_at: Date;
  closed_at: Date | null;
};

export type CircuitInput = {
  name: unknown;
  season: unknown;
  game?: unknown;
  participantType?: unknown;
  description: unknown;
  pointsTable: unknown;
  participationPoints: unknown;
  qualifyTop: unknown;
  divisions?: unknown;
  promote: unknown;
  relegate: unknown;
};

export function parsePointsTable(value: unknown): number[] {
  const parts = String(value ?? "")
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length < 1 || parts.length > 64) fail("invalid_points_table");
  const table = parts.map((p) => Number(p));
  if (table.some((n) => !Number.isInteger(n) || n < 0 || n > 1000)) fail("invalid_points_table");
  for (let i = 1; i < table.length; i++) if (table[i] > table[i - 1]) fail("invalid_points_table");
  return table;
}

const optInt = (value: unknown, min: number, max: number, fallback: number) =>
  String(value ?? "").trim() === "" ? fallback : v.intIn(value, min, max);

function parseCircuit(input: CircuitInput) {
  const name = v.displayName(input.name, 80);
  const season = v.oneLine(input.season, 40);
  if (season.length < 1) fail("invalid_input");
  const table = parsePointsTable(input.pointsTable);
  const participation = optInt(input.participationPoints, 0, 1000, 0);
  if (participation > table[table.length - 1]) fail("invalid_points_table");
  return {
    name,
    season,
    description: v.clean(input.description, 2000),
    table,
    participation,
    qualifyTop: optInt(input.qualifyTop, 0, 256, 0),
    divisions: optInt(input.divisions, 1, MAX_DIVISIONS, 1),
    promote: optInt(input.promote, 0, 64, 0),
    relegate: optInt(input.relegate, 0, 64, 0),
  };
}

export async function lockCircuit(q: Queryable, id: string): Promise<CircuitRow> {
  const [c] = await q.query<CircuitRow>("select * from circuits where id = $1 for update", [id]);
  if (!c) fail("not_found");
  return c;
}

async function requireOrgManager(q: Queryable, orgId: string, user: SessionUser) {
  if (!(await canManageOrg(q, orgId, user))) fail("forbidden");
}

export async function createCircuit(db: Database, user: SessionUser, orgId: string, input: CircuitInput) {
  const data = parseCircuit(input);
  const game = gameBySlug(String(input.game ?? ""));
  if (!game || !game.bracket) fail("invalid_game");
  const participantType = input.participantType === "team" ? "team" : input.participantType === "solo" ? "solo" : fail("invalid_input");
  if (data.divisions === 1 && (data.promote > 0 || data.relegate > 0)) fail("invalid_input");
  return db.tx(async (q) => {
    await requireOrgManager(q, orgId, user);
    const slug = await uniqueSlug(q, "circuits", `${data.name} ${data.season}`);
    const [c] = await q.query<{ id: string; slug: string }>(
      `insert into circuits (slug, org_id, name, season, game, participant_type, description, points_table, participation_points,
         qualify_top, divisions, promote, relegate, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id, slug`,
      [slug, orgId, data.name, data.season, game!.slug, participantType, data.description, data.table, data.participation,
        data.qualifyTop, data.divisions, data.promote, data.relegate, user.id],
    );
    await audit(q, { actorId: user.id, action: "circuit.created", entity: "circuit", entityId: c.id, data: { name: data.name, season: data.season, game: game!.slug, participantType, divisions: data.divisions } });
    return c;
  });
}

export async function updateCircuit(db: Database, user: SessionUser, circuitId: string, input: CircuitInput) {
  const data = parseCircuit(input);
  await db.tx(async (q) => {
    const c = await lockCircuit(q, circuitId);
    await requireOrgManager(q, c.org_id, user);
    if (c.status !== "active") fail("circuit_closed");
    const [state] = await q.query<{ completed: number; events: number; members: number }>(
      `select (select count(*)::int from tournaments where circuit_id = $1 and status in ('COMPLETED','ARCHIVED')) as completed,
              (select count(*)::int from tournaments where circuit_id = $1) as events,
              (select count(*)::int from circuit_members where circuit_id = $1) as members`,
      [c.id],
    );
    const tableChanged = data.table.join(",") !== c.points_table.join(",") || data.participation !== c.participation_points;
    if (tableChanged && (state?.completed ?? 0) > 0) fail("points_table_locked");
    const divisions = String(input.divisions ?? "").trim() === "" ? c.divisions : data.divisions;
    if (divisions !== c.divisions && ((state?.events ?? 0) > 0 || (state?.members ?? 0) > 0)) fail("not_editable");
    if (divisions === 1 && (data.promote > 0 || data.relegate > 0)) fail("invalid_input");
    await q.query(
      `update circuits set name=$2, season=$3, description=$4, points_table=$5, participation_points=$6, qualify_top=$7,
         divisions=$8, promote=$9, relegate=$10, updated_at=now() where id=$1`,
      [c.id, data.name, data.season, data.description, data.table, data.participation, data.qualifyTop, divisions, data.promote, data.relegate],
    );
    await audit(q, { actorId: user.id, action: "circuit.updated", entity: "circuit", entityId: c.id, data: { tableChanged, divisions } });
  });
}

type Identity = { userId: string | null; teamId: string | null };
const keyOf = (i: Identity) => (i.userId ? `u:${i.userId}` : `t:${i.teamId}`);

async function resolveEntrant(q: Queryable, c: CircuitRow, handle: unknown): Promise<Identity & { name: string }> {
  const text = v.oneLine(handle, 60).toLowerCase().replace(/^@/, "");
  if (!text) fail("invalid_input");
  if (c.participant_type === "solo") {
    const [u] = await q.query<{ id: string; display_name: string }>("select id, display_name from users where username = $1 and status = 'active'", [text]);
    if (!u) fail("not_found");
    return { userId: u.id, teamId: null, name: u.display_name };
  }
  const [t] = await q.query<{ id: string; name: string; game: string }>("select id, name, game from teams where slug = $1", [text]);
  if (!t) fail("not_found");
  if (t.game !== c.game) fail("team_game_mismatch");
  return { userId: null, teamId: t.id, name: t.name };
}

export async function setCircuitMember(db: Database, user: SessionUser, circuitId: string, handle: unknown, divisionInput: unknown) {
  await db.tx(async (q) => {
    const c = await lockCircuit(q, circuitId);
    await requireOrgManager(q, c.org_id, user);
    if (c.status !== "active") fail("circuit_closed");
    if (c.divisions < 2) fail("invalid_input");
    const division = v.intIn(divisionInput, 1, c.divisions);
    const who = await resolveEntrant(q, c, handle);
    const updated = await q.query(
      `update circuit_members set division = $3, source = 'assigned', added_by = $4, added_at = now()
        where circuit_id = $1 and ${who.userId ? "user_id" : "team_id"} = $2 returning circuit_id`,
      [c.id, who.userId ?? who.teamId, division, user.id],
    );
    if (!updated.length) {
      try {
        await q.query("insert into circuit_members (circuit_id, division, user_id, team_id, added_by) values ($1,$2,$3,$4,$5)", [
          c.id,
          division,
          who.userId,
          who.teamId,
          user.id,
        ]);
      } catch (error) {
        if (isUniqueViolation(error)) fail("already_member");
        throw error;
      }
    }
    await audit(q, { actorId: user.id, action: "circuit.member_set", entity: "circuit", entityId: c.id, data: { ...who, division } });
  });
}

export async function removeCircuitMember(db: Database, user: SessionUser, circuitId: string, handle: unknown) {
  await db.tx(async (q) => {
    const c = await lockCircuit(q, circuitId);
    await requireOrgManager(q, c.org_id, user);
    if (c.status !== "active") fail("circuit_closed");
    const who = await resolveEntrant(q, c, handle);
    const rows = await q.query(`delete from circuit_members where circuit_id = $1 and ${who.userId ? "user_id" : "team_id"} = $2 returning circuit_id`, [
      c.id,
      who.userId ?? who.teamId,
    ]);
    if (!rows.length) fail("not_found");
    await audit(q, { actorId: user.id, action: "circuit.member_removed", entity: "circuit", entityId: c.id, data: { ...who } });
  });
}

export type CircuitStanding = {
  key: string;
  userId: string | null;
  teamId: string | null;
  name: string;
  link: string | null;
  division: number;
  points: number;
  events: number;
  titles: number;
  best: number | null;
  member: boolean;
  rank: number;
  qualified: boolean;
  movement: "promoted" | "relegated" | "stayed" | null;
};

export const eventPoints = (table: number[], participation: number, placement: number, weight: number) => {
  const base = placement >= 1 && placement <= table.length ? table[placement - 1] : participation;
  return Math.floor((base * weight + 50) / 100);
};

/**
 * Standings of an active circuit, per division. For a closed season use `frozenStandings`.
 * Movement shows where each member would go if the season closed now.
 */
export async function circuitStandings(q: Queryable, c: CircuitRow): Promise<Map<number, CircuitStanding[]>> {
  const placed = await q.query<{ user_id: string | null; team_id: string | null; placement: number; circuit_weight: number; circuit_division: number | null }>(
    `select r.user_id, r.team_id, r.placement, t.circuit_weight, t.circuit_division
       from registrations r join tournaments t on t.id = r.tournament_id
      where t.circuit_id = $1 and t.status in ('COMPLETED','ARCHIVED') and r.placement is not null`,
    [c.id],
  );
  const members = await q.query<{ user_id: string | null; team_id: string | null; division: number }>(
    "select user_id, team_id, division from circuit_members where circuit_id = $1",
    [c.id],
  );
  const memberDivision = new Map(members.map((m) => [keyOf({ userId: m.user_id, teamId: m.team_id }), m.division]));
  const byDivision = new Map<number, Map<string, CircuitStanding>>();
  const rowFor = (division: number, who: Identity) => {
    if (!byDivision.has(division)) byDivision.set(division, new Map());
    const map = byDivision.get(division)!;
    const key = keyOf(who);
    if (!map.has(key))
      map.set(key, {
        key,
        userId: who.userId,
        teamId: who.teamId,
        name: "",
        link: null,
        division,
        points: 0,
        events: 0,
        titles: 0,
        best: null,
        member: memberDivision.get(key) === division,
        rank: 0,
        qualified: false,
        movement: null,
      });
    return map.get(key)!;
  };
  for (let d = 1; d <= c.divisions; d++) byDivision.set(d, new Map());
  for (const m of members) rowFor(m.division, { userId: m.user_id, teamId: m.team_id });
  for (const p of placed) {
    const division = c.divisions > 1 ? p.circuit_division : 1;
    if (!division) continue;
    const row = rowFor(division, { userId: p.user_id, teamId: p.team_id });
    row.points += eventPoints(c.points_table, c.participation_points, p.placement, p.circuit_weight);
    row.events += 1;
    if (p.placement === 1) row.titles += 1;
    row.best = row.best === null ? p.placement : Math.min(row.best, p.placement);
  }
  // Names and links.
  const all = [...byDivision.values()].flatMap((m) => [...m.values()]);
  const userIds = [...new Set(all.filter((r) => r.userId).map((r) => r.userId!))];
  const teamIds = [...new Set(all.filter((r) => r.teamId).map((r) => r.teamId!))];
  const users = userIds.length ? await q.query<{ id: string; display_name: string; username: string; status: string }>("select id, display_name, username, status from users where id = any($1)", [userIds]) : [];
  const teams = teamIds.length ? await q.query<{ id: string; name: string; slug: string }>("select id, name, slug from teams where id = any($1)", [teamIds]) : [];
  const uMap = new Map(users.map((u) => [u.id, u]));
  const tMap = new Map(teams.map((t) => [t.id, t]));
  for (const r of all) {
    if (r.userId) {
      const u = uMap.get(r.userId);
      r.name = u?.display_name ?? "—";
      r.link = u && u.status !== "deleted" ? u.username : null;
    } else {
      const t = tMap.get(r.teamId!);
      r.name = t?.name ?? "—";
      r.link = t?.slug ?? null;
    }
  }
  const out = new Map<number, CircuitStanding[]>();
  for (const [division, map] of byDivision) {
    const rows = [...map.values()].sort(
      (a, b) =>
        b.points - a.points ||
        b.titles - a.titles ||
        (a.best ?? 1e9) - (b.best ?? 1e9) ||
        b.events - a.events ||
        a.name.localeCompare(b.name, "en") ||
        (a.key < b.key ? -1 : 1),
    );
    rows.forEach((r, i) => {
      r.rank = i + 1;
      r.qualified = division === 1 && r.rank <= c.qualify_top;
    });
    if (c.divisions > 1) {
      const ms = rows.filter((r) => r.member);
      const up = division > 1 ? ms.slice(0, Math.min(c.promote, ms.length)) : [];
      const down = division < c.divisions ? ms.slice(Math.max(0, ms.length - c.relegate)).filter((r) => !up.includes(r)) : [];
      for (const r of ms) r.movement = up.includes(r) ? "promoted" : down.includes(r) ? "relegated" : "stayed";
    }
    out.set(division, rows);
  }
  return out;
}

export async function frozenStandings(q: Queryable, circuitId: string): Promise<Map<number, CircuitStanding[]>> {
  const rows = await q.query<{
    division: number; rank: number; user_id: string | null; team_id: string | null; name: string; points: number; events: number;
    titles: number; best: number | null; member: boolean; qualified: boolean; movement: CircuitStanding["movement"]; username: string | null; slug: string | null;
  }>(
    `select r.*, u.username, tm.slug from circuit_results r
       left join users u on u.id = r.user_id and u.status <> 'deleted' left join teams tm on tm.id = r.team_id
      where r.circuit_id = $1 order by r.division, r.rank`,
    [circuitId],
  );
  const out = new Map<number, CircuitStanding[]>();
  for (const r of rows) {
    const list = out.get(r.division) ?? [];
    list.push({
      key: keyOf({ userId: r.user_id, teamId: r.team_id }),
      userId: r.user_id,
      teamId: r.team_id,
      name: r.name,
      link: r.username ?? r.slug ?? null,
      division: r.division,
      points: r.points,
      events: r.events,
      titles: r.titles,
      best: r.best,
      member: r.member,
      rank: r.rank,
      qualified: r.qualified,
      movement: r.movement,
    });
    out.set(r.division, list);
  }
  return out;
}

export async function standingsOf(q: Queryable, c: CircuitRow) {
  return c.status === "closed" ? frozenStandings(q, c.id) : circuitStandings(q, c);
}

/** Identities qualified from a circuit: frozen for a closed season, live otherwise. */
export async function qualifiedKeys(q: Queryable, circuitId: string): Promise<Set<string>> {
  const [c] = await q.query<CircuitRow>("select * from circuits where id = $1", [circuitId]);
  if (!c) return new Set();
  const table = await standingsOf(q, c);
  return new Set((table.get(1) ?? []).filter((r) => r.qualified).map((r) => r.key));
}

/** Registration rules added by circuits: division membership and qualification. */
export async function checkCircuitEligibility(
  q: Queryable,
  t: { circuit_id: string | null; circuit_division: number | null; qualifier_circuit_id: string | null },
  who: Identity,
) {
  if (t.circuit_id) {
    const [c] = await q.query<{ divisions: number }>("select divisions from circuits where id = $1", [t.circuit_id]);
    if (c && c.divisions > 1) {
      const [m] = await q.query<{ division: number }>(
        `select division from circuit_members where circuit_id = $1 and ${who.userId ? "user_id" : "team_id"} = $2`,
        [t.circuit_id, who.userId ?? who.teamId],
      );
      if (!m || m.division !== t.circuit_division) fail("not_in_division");
    }
  }
  if (t.qualifier_circuit_id && !(await qualifiedKeys(q, t.qualifier_circuit_id)).has(keyOf(who))) fail("not_qualified");
}

export type CircuitLinkInput = { circuitId?: unknown; circuitDivision?: unknown; circuitWeight?: unknown; qualifierCircuitId?: unknown };
export type CircuitLink = { circuitId: string | null; circuitDivision: number | null; circuitWeight: number; qualifierCircuitId: string | null };

const uuidOrNull = (value: unknown) => {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^[0-9a-f-]{36}$/i.test(text)) fail("invalid_input");
  return text;
};

/** Validates a tournament's link to a circuit (points) and to a qualifying circuit (entry filter). */
export async function validateCircuitLink(
  q: Queryable,
  t: { orgId: string; game: string; participantType: string; format: string },
  input: CircuitLinkInput,
): Promise<CircuitLink> {
  const circuitId = uuidOrNull(input.circuitId);
  const qualifierCircuitId = uuidOrNull(input.qualifierCircuitId);
  const weight = String(input.circuitWeight ?? "").trim() === "" ? 100 : v.intIn(input.circuitWeight, 10, 1000);
  let division: number | null = null;
  if (circuitId) {
    if (t.format === "leaderboard") fail("circuit_mismatch");
    const [c] = await q.query<CircuitRow>("select * from circuits where id = $1", [circuitId]);
    if (!c || c.org_id !== t.orgId || c.status !== "active" || c.game !== t.game || c.participant_type !== t.participantType) fail("circuit_mismatch");
    if (c!.divisions > 1) division = v.intIn(input.circuitDivision, 1, c!.divisions);
  }
  if (qualifierCircuitId) {
    const [c] = await q.query<CircuitRow>("select * from circuits where id = $1", [qualifierCircuitId]);
    if (!c || c.org_id !== t.orgId || c.game !== t.game || c.participant_type !== t.participantType || c.qualify_top < 1 || qualifierCircuitId === circuitId)
      fail("circuit_mismatch");
  }
  return { circuitId, circuitDivision: division, circuitWeight: weight, qualifierCircuitId };
}

async function leadersOf(q: Queryable, who: Identity): Promise<string[]> {
  if (who.userId) return [who.userId];
  const [t] = await q.query<{ owner_id: string; captain_id: string }>("select owner_id, captain_id from teams where id = $1", [who.teamId]);
  return t ? [...new Set([t.owner_id, t.captain_id])] : [];
}

/**
 * Closes a season: freezes the table, marks qualification and movement, and optionally opens the next
 * season with members moved between divisions. Blocked while any linked event is still open.
 */
export async function closeSeason(db: Database, user: SessionUser, circuitId: string, input: { nextSeason?: unknown; createNext?: unknown }) {
  const createNext = v.bool(input.createNext);
  const nextSeason = v.oneLine(input.nextSeason, 40);
  return db.tx(async (q) => {
    const c = await lockCircuit(q, circuitId);
    await requireOrgManager(q, c.org_id, user);
    if (c.status !== "active") fail("circuit_closed");
    if (createNext && (!nextSeason || nextSeason === c.season)) fail("invalid_input");
    const [open] = await q.query<{ n: number }>(
      "select count(*)::int as n from tournaments where circuit_id = $1 and status not in ('COMPLETED','CANCELLED','ARCHIVED')",
      [c.id],
    );
    if ((open?.n ?? 0) > 0) fail("circuit_open_events");
    const table = await circuitStandings(q, c);
    let count = 0;
    for (const [division, rows] of table)
      for (const r of rows) {
        await q.query(
          `insert into circuit_results (circuit_id, division, rank, user_id, team_id, name, points, events, titles, best, member, qualified, movement)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [c.id, division, r.rank, r.userId, r.teamId, r.name, r.points, r.events, r.titles, r.best, r.member, r.qualified, r.movement],
        );
        count++;
        if (r.qualified) await notify(q, await leadersOf(q, r), "circuit_qualified", { circuit: `${c.name} · ${c.season}`, circuitSlug: c.slug });
        if (r.movement === "promoted" || r.movement === "relegated")
          await notify(q, await leadersOf(q, r), r.movement === "promoted" ? "circuit_promoted" : "circuit_relegated", {
            circuit: `${c.name} · ${c.season}`,
            circuitSlug: c.slug,
            division: String(r.division + (r.movement === "promoted" ? -1 : 1)),
          });
      }
    await q.query("update circuits set status = 'closed', closed_at = now(), updated_at = now() where id = $1", [c.id]);
    let next: { id: string; slug: string } | null = null;
    if (createNext) {
      const slug = await uniqueSlug(q, "circuits", `${c.name} ${nextSeason}`);
      [next] = await q.query<{ id: string; slug: string }>(
        `insert into circuits (slug, org_id, name, season, game, participant_type, description, points_table, participation_points,
           qualify_top, divisions, promote, relegate, previous_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id, slug`,
        [slug, c.org_id, c.name, nextSeason, c.game, c.participant_type, c.description, c.points_table, c.participation_points,
          c.qualify_top, c.divisions, c.promote, c.relegate, c.id, user.id],
      );
      if (c.divisions > 1)
        for (const rows of table.values())
          for (const r of rows.filter((x) => x.member)) {
            const division = r.movement === "promoted" ? r.division - 1 : r.movement === "relegated" ? r.division + 1 : r.division;
            await q.query("insert into circuit_members (circuit_id, division, user_id, team_id, source, added_by) values ($1,$2,$3,$4,$5,$6)", [
              next!.id,
              division,
              r.userId,
              r.teamId,
              r.movement ?? "stayed",
              user.id,
            ]);
          }
    }
    await audit(q, { actorId: user.id, action: "circuit.season_closed", entity: "circuit", entityId: c.id, data: { results: count, next: next?.id ?? null } });
    return { nextSlug: next?.slug ?? null };
  });
}

// ---------- Read models ----------

export type CircuitCard = CircuitRow & { org_name: string; org_slug: string; events: number; completed: number };

export async function listCircuits(q: Queryable, opts: { orgId?: string; status?: "active" | "closed" } = {}) {
  return q.query<CircuitCard>(
    `select c.*, o.name as org_name, o.slug as org_slug,
            (select count(*)::int from tournaments t where t.circuit_id = c.id and t.status not in ('DRAFT','CANCELLED')) as events,
            (select count(*)::int from tournaments t where t.circuit_id = c.id and t.status in ('COMPLETED','ARCHIVED')) as completed
       from circuits c join organizations o on o.id = c.org_id
      where ($1::uuid is null or c.org_id = $1) and ($2::text is null or c.status = $2)
      order by case when c.status = 'active' then 0 else 1 end, c.created_at desc limit 200`,
    [opts.orgId ?? null, opts.status ?? null],
  );
}

export async function circuitBySlug(q: Queryable, slug: string) {
  const [c] = await q.query<CircuitCard>(
    `select c.*, o.name as org_name, o.slug as org_slug,
            (select count(*)::int from tournaments t where t.circuit_id = c.id and t.status not in ('DRAFT','CANCELLED')) as events,
            (select count(*)::int from tournaments t where t.circuit_id = c.id and t.status in ('COMPLETED','ARCHIVED')) as completed
       from circuits c join organizations o on o.id = c.org_id where c.slug = $1`,
    [slug],
  );
  if (!c) return null;
  const events = await q.query<{ id: string; slug: string; name: string; status: string; format: string; starts_at: Date; circuit_division: number | null; circuit_weight: number }>(
    `select id, slug, name, status, format, starts_at, circuit_division, circuit_weight from tournaments
      where circuit_id = $1 and status <> 'DRAFT' order by starts_at asc`,
    [c.id],
  );
  const finals = await q.query<{ slug: string; name: string; status: string; starts_at: Date }>(
    "select slug, name, status, starts_at from tournaments where qualifier_circuit_id = $1 and status <> 'DRAFT' order by starts_at asc",
    [c.id],
  );
  const [previous] = c.previous_id ? await q.query<{ slug: string; season: string }>("select slug, season from circuits where id = $1", [c.previous_id]) : [];
  const [next] = await q.query<{ slug: string; season: string }>("select slug, season from circuits where previous_id = $1", [c.id]);
  const standings = await standingsOf(q, c);
  return { circuit: c, events, finals, previous: previous ?? null, next: next ?? null, standings };
}

/** Closed-season results of a player or team, for the gaming passport. */
export async function seasonHistory(q: Queryable, who: Identity) {
  return q.query<{ slug: string; name: string; season: string; division: number; rank: number; points: number; qualified: boolean; movement: string | null; divisions: number }>(
    `select c.slug, c.name, c.season, r.division, r.rank, r.points, r.qualified, r.movement, c.divisions
       from circuit_results r join circuits c on c.id = r.circuit_id
      where ${who.userId ? "r.user_id" : "r.team_id"} = $1 order by c.closed_at desc limit 30`,
    [who.userId ?? who.teamId],
  );
}
