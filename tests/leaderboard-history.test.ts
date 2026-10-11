import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import type { Locale } from "../src/lib/i18n.ts";
import { openDatabase, type Database, type Queryable } from "../src/server/db.ts";
import { signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { createTournament, register, settleTournament, transition } from "../src/server/tournaments.ts";
import { leaderboardStandings, reviewScore, submitScore } from "../src/server/leaderboard.ts";
import { apiStandings, standingsFor } from "../src/server/partner-api.ts";
import { getTournament, participants } from "../src/server/queries.ts";

let db: Database, owner: SessionUser, players: SessionUser[], org: string;
let sequence = 0;
let hooks: ReturnType<typeof registerHooks>;
let renderPublic: (slug: string, lang: Locale) => Promise<string>;
let renderEmbed: (standings: Awaited<ReturnType<typeof standingsFor>>, lang: Locale) => string;
test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
  const users: SessionUser[] = [];
  for (const name of ["historyowner", "historya", "historyb", "historyc"]) {
    const account = await signUp(db, { email: `${name}@example.test`, username: name, displayName: name, password: "isolated history password", adult: "on", terms: "on" });
    users.push((await sessionUser(db, account.token))!);
  }
  [owner, ...players] = users;
  org = (await createOrg(db, owner, { name: "Historical standings", description: "" })).id;
  // Execute the real TSX page and widget with only request authentication replaced by our isolated DB.
  const sourceRoot = new URL("../src/", import.meta.url);
  hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("@/")) specifier = new URL(specifier.slice(2), sourceRoot).href;
      if ((specifier.startsWith(".") || specifier.startsWith("file:")) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        const url = new URL(specifier, context.parentURL);
        for (const extension of [".tsx", ".ts"]) {
          if (existsSync(fileURLToPath(url) + extension)) { specifier = url.href + extension; break; }
        }
      }
      if (/^next\/[a-z-]+$/.test(specifier)) specifier += ".js";
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === new URL("server/viewer.ts", sourceRoot).href)
        return { format: "module", shortCircuit: true, source: 'export async function viewer() { return globalThis[Symbol.for("history-test-viewer")]; }' };
      if (url.endsWith(".tsx")) {
        const source = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        return { format: "module", shortCircuit: true, source };
      }
      return nextLoad(url, context);
    },
  });
  const { default: PublicPage } = await import("../src/app/[lang]/tournaments/[slug]/page.tsx");
  const { EmbedStandings } = await import("../src/components/embed.tsx");
  renderPublic = async (slug, lang) => {
    (globalThis as Record<symbol, unknown>)[Symbol.for("history-test-viewer")] = { db: withoutScoreReads(), user: null, dbError: false };
    return renderToStaticMarkup(await PublicPage({ params: Promise.resolve({ slug, lang }), searchParams: Promise.resolve({}) }));
  };
  renderEmbed = (standings, lang) => renderToStaticMarkup(createElement(EmbedStandings, { standings, lang }));
});
test.after(async () => {
  hooks?.deregister();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("history-test-viewer")];
  await db.close();
});

async function event(size = 2) {
  const t = await createTournament(db, owner, org, {
    name: `History ${++sequence}`, game: "pubg", format: "leaderboard", participantType: "solo", teamSize: 1,
    maxParticipants: size, checkInRequired: "", region: "", startsAt: "2030-01-01T12:00", timeZone: "UTC",
    description: "", rules: "", bestOf: 1, eligibleGameLimit: 20,
  });
  await transition(db, owner, t.id, "PUBLISHED");
  await transition(db, owner, t.id, "REGISTRATION_OPEN");
  for (const p of players.slice(0, size)) await register(db, p, t.id);
  await transition(db, owner, t.id, "REGISTRATION_CLOSED");
  await transition(db, owner, t.id, "IN_PROGRESS");
  return (await getTournament(db, t.slug))!;
}

async function addScore(tournamentId: string, player: SessionUser, suffix: string, kills: number, deaths: number) {
  const entry = await submitScore(db, player, tournamentId, {
    matchRef: `history-${sequence}-${suffix}`, kills, deaths, evidenceUrl: "https://evidence.example.test/replay",
  });
  await reviewScore(db, owner, entry.id, "approve", "Replay verified", 1);
}

/** Exact review fixture: old all-game KDA gave A first; counted best-1 KDA now gives B first. */
async function reviewedFixture() {
  const t = await event();
  await addScore(t.id, players[0], "a1", 10, 2);
  await addScore(t.id, players[0], "a2", 9, 0);
  await addScore(t.id, players[1], "b1", 10, 1);
  await addScore(t.id, players[1], "b2", 0, 100);
  return t;
}

async function saveLegacyPlaces(tournamentId: string, status: "COMPLETED" | "ARCHIVED") {
  await db.tx(async (q) => {
    await q.query("update registrations set placement = case when user_id = $2 then 1 else 2 end where tournament_id = $1", [tournamentId, players[0].id]);
    await q.query("update tournaments set status = $2, completed_at = now(), prize_coins = 50 where id = $1", [tournamentId, status]);
    await settleTournament(q, tournamentId);
  });
}

async function outcomeSnapshot(tournamentId: string) {
  return {
    registrations: await db.query("select id, placement, status from registrations where tournament_id = $1 order by id", [tournamentId]),
    xp: await db.query("select * from xp_events where ref = $1 order by id", [tournamentId]),
    awards: await db.query("select * from tournament_awards where tournament_id = $1 order by registration_id", [tournamentId]),
    coins: await db.query("select * from coin_ledger where ref = $1 order by id", [tournamentId]),
    wallets: await db.query("select * from wallets order by user_id"),
    audit: await db.query("select * from audit_log where entity_id = $1 order by id", [tournamentId]),
  };
}

const withoutScoreReads = (): Queryable => ({
  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    assert.doesNotMatch(sql, /\bscore_entries\b/i, "historical results must not recalculate current score metrics");
    return db.query<T>(sql, params);
  },
});

for (const status of ["COMPLETED", "ARCHIVED"] as const) {
  test(`${status} keeps the stored A=1/B=2 result although live best-1 is B=1/A=2`, async () => {
    const t = await reviewedFixture();
    const live = await leaderboardStandings(db, t);
    assert.deepEqual(live.map((r) => [r.username, r.rank, r.points, r.kda]), [
      ["historyb", 1, 50, 10], ["historya", 2, 50, 5],
    ]);
    await saveLegacyPlaces(t.id, status);
    const before = await outcomeSnapshot(t.id);
    assert.equal(before.awards.length, 1, "fixture contains the old champion award");
    assert.equal(before.xp.length, 6, "fixture contains entry XP and both placement awards");
    const stored = (await getTournament(db, t.slug))!;
    const output = await standingsFor(db, stored);
    assert.equal(output.kind, "placements");
    assert.equal(output.final, true);
    if (output.kind !== "placements") assert.fail("expected stored final places");
    assert.deepEqual(output.rows.map((r) => [r.name, r.placement]), [["historya", 1], ["historyb", 2]]);
    for (const row of output.rows) assert.deepEqual(Object.keys(row).sort(), ["name", "placement", "registration"]);
    assert.deepEqual(await apiStandings(withoutScoreReads(), org, t.slug), output);
    assert.deepEqual(await standingsFor(withoutScoreReads(), stored), output);
    for (const lang of ["ru", "en"] as const) {
      const publicHtml = await renderPublic(t.slug, lang);
      const finalSection = publicHtml.match(/<section id="standings"[\s\S]*?<\/section>/)?.[0];
      assert.ok(finalSection, "public page renders final results");
      assert.match(finalSection, /<td>1<\/td><td>historya<\/td>[\s\S]*<td>2<\/td><td>historyb<\/td>/);
      const liveSection = publicHtml.match(/<section id="leaderboard"[\s\S]*?<\/section>/)?.[0];
      assert.ok(liveSection);
      assert.doesNotMatch(liveSection, /<table|KDA/, "public final results must not show a recomputed aggregate table");
      const widget = renderEmbed(output, lang);
      assert.match(widget, /<td>1<\/td><td>historya<\/td>[\s\S]*<td>2<\/td><td>historyb<\/td>/);
      assert.doesNotMatch(widget, /KDA|Points|Очки/);
    }
    assert.deepEqual(await outcomeSnapshot(t.id), before, "reading final results must not rewrite dependent outcomes");
  });
}

test("stored shared places and gaps survive without renumbering", async () => {
  const t = await event(3);
  await db.query("update registrations set placement = case when user_id = $2 then 4 else 1 end where tournament_id = $1", [t.id, players[2].id]);
  await db.query("update tournaments set status = 'COMPLETED', completed_at = now() where id = $1", [t.id]);
  const output = await standingsFor(withoutScoreReads(), (await getTournament(db, t.slug))!);
  assert.equal(output.kind, "placements");
  if (output.kind !== "placements") assert.fail("expected stored final places");
  assert.deepEqual(output.rows.map((r) => r.placement), [1, 1, 4]);
  assert.deepEqual([...renderEmbed(output, "en").matchAll(/<td>(\d+)<\/td>/g)].map((m) => Number(m[1])), [1, 1, 4]);
});

test("finished events without stored places do not invent a winner from approved scores", async () => {
  const t = await reviewedFixture();
  for (const status of ["COMPLETED", "ARCHIVED"]) {
    await db.query("update tournaments set status = $2, completed_at = now() where id = $1", [t.id, status]);
    const output = await standingsFor(withoutScoreReads(), (await getTournament(db, t.slug))!);
    assert.deepEqual(output, { kind: "placements", final: true, rows: [] });
    for (const lang of ["ru", "en"] as const) {
      const expected = lang === "ru" ? "Итоговые места не сохранены." : "Final placements were not recorded.";
      assert.ok((await renderPublic(t.slug, lang)).includes(expected));
      assert.ok(renderEmbed(output, lang).includes(expected));
    }
  }
});

test("live and paused API rankings preserve sporting ties and best-N metrics", async () => {
  const t = await event(3);
  await addScore(t.id, players[0], "a1", 10, 1);
  await addScore(t.id, players[0], "a2", 1, 100);
  await addScore(t.id, players[1], "b1", 10, 1);
  await addScore(t.id, players[2], "c1", 9, 1);
  for (const status of ["IN_PROGRESS", "PAUSED"]) {
    if (status === "PAUSED") await transition(db, owner, t.id, status);
    const output = await standingsFor(db, (await getTournament(db, t.slug))!);
    assert.equal(output.kind, "leaderboard");
    assert.equal(output.final, false);
    if (output.kind !== "leaderboard") assert.fail("expected live standings");
    assert.deepEqual(output.rows.map((r) => r.rank), [1, 1, 3]);
    assert.deepEqual(output.rows.map((r) => [r.points, r.kills]), [[50, 10], [50, 10], [45, 9]]);
  }
  await transition(db, owner, t.id, "IN_PROGRESS");
  await transition(db, owner, t.id, "COMPLETED");
  assert.deepEqual((await participants(db, t.id)).map((r) => r.placement), [1, 1, 3], "new final places retain the sporting tie");
});

test("new completion stores the current rankings once and rejects replay", async () => {
  const t = await reviewedFixture();
  await db.query("update tournaments set prize_coins = 50 where id = $1", [t.id]);
  await transition(db, owner, t.id, "COMPLETED");
  assert.deepEqual((await participants(db, t.id)).map((r) => [r.username, r.placement]), [["historyb", 1], ["historya", 2]]);
  const before = await outcomeSnapshot(t.id);
  assert.equal(before.awards.length, 1);
  assert.equal(before.xp.length, 6);
  const winner = (await participants(db, t.id))[0];
  assert.equal(before.awards[0].registration_id, winner.id);
  assert.deepEqual(before.xp.filter((row) => row.reason === "tournament_placement").map((row) => [row.user_id, row.amount]).sort(),
    [[players[1].id, 300], [players[0].id, 200]].sort());
  await assert.rejects(transition(db, owner, t.id, "COMPLETED"), { code: "invalid_transition" });
  const result = await standingsFor(withoutScoreReads(), (await getTournament(db, t.slug))!);
  assert.equal(result.kind, "placements");
  assert.deepEqual(await outcomeSnapshot(t.id), before);
  await transition(db, owner, t.id, "ARCHIVED");
  assert.deepEqual(await standingsFor(withoutScoreReads(), (await getTournament(db, t.slug))!), result);
  const { audit: oldAudit, ...settled } = before;
  const { audit: archivedAudit, ...archived } = await outcomeSnapshot(t.id);
  assert.deepEqual(archived, settled, "archiving must preserve placements, XP, awards, coins and wallets");
  assert.deepEqual(archivedAudit.slice(0, oldAudit.length), oldAudit, "existing audit entries remain unchanged");
  assert.equal(archivedAudit.length, oldAudit.length + 1);
  assert.equal(archivedAudit.at(-1)?.action, "tournament.status");
  assert.deepEqual(archivedAudit.at(-1)?.data, { from: "COMPLETED", to: "ARCHIVED" });
});
