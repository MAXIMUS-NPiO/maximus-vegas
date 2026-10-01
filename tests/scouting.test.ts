import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { deleteAccount, exportAccount, signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createTeam } from "../src/server/teams.ts";
import { createPost } from "../src/server/finder.ts";
import {
  deleteFilter,
  isEmptyQuery,
  MAX_FILTERS,
  myFilters,
  parseScoutQuery,
  saveFilter,
  scoutParams,
  scoutPlayers,
  unwatchPlayer,
  watchlist,
  watchPlayer,
} from "../src/server/scouting.ts";
import { DomainError } from "../src/server/errors.ts";

let db: Database;
const PASSWORD = "correct horse battery";
async function mk(name: string): Promise<SessionUser> {
  const s = await signUp(db, { email: `${name}@example.com`, username: name, displayName: name.toUpperCase(), password: PASSWORD, adult: "on", terms: "on" });
  return (await sessionUser(db, s.token))!;
}
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code, `expected ${code}`);
}
const names = (rows: { username: string }[]) => rows.map((r) => r.username).sort();

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
});
test.after(async () => {
  await db.close();
});

test("query parsing keeps known values only and orders a reversed rating range", () => {
  const q = parseScoutQuery({ game: "cs2", country: "ae", minRating: "1500", maxRating: "1100", lft: "1", activeDays: "30", text: "  ra_ven  " });
  assert.deepEqual(q, { game: "cs2", country: "AE", minRating: 1100, maxRating: 1500, lft: true, activeDays: 30, text: "ra_ven" });
  assert.deepEqual(parseScoutQuery({ game: "chess", country: "ZZ", minRating: "50", maxRating: "9000", lft: "yes", activeDays: "3" }), {
    game: "",
    country: "",
    minRating: null,
    maxRating: null,
    lft: false,
    activeDays: null,
    text: "",
  });
  assert.equal(isEmptyQuery(parseScoutQuery({})), true);
  assert.deepEqual(parseScoutQuery(scoutParams(q)), q, "URL fields round-trip");
});

test("search covers public profiles only, by game, rating, country, looking-for-team, activity and name", async () => {
  const viewer = await mk("sc_viewer");
  const ace = await mk("sc_ace");
  const mate = await mk("sc_mate");
  const hidden = await mk("sc_hidden");
  const dota = await mk("sc_dota");
  await db.query("update users set country_code = 'AE' where id = $1", [ace.id]);
  await db.query("insert into ratings (user_id, game, rating, matches, wins, losses, peak) values ($1, 'cs2', 1240, 12, 8, 4, 1260), ($2, 'cs2', 980, 3, 1, 2, 1000), ($3, 'cs2', 1500, 20, 15, 5, 1500)", [ace.id, mate.id, hidden.id]);
  await db.query("update users set profile_public = false where id = $1", [hidden.id]);
  await createPost(db, ace, { kind: "lft", game: "cs2", roles: "AWP, IGL" });
  await createTeam(db, dota, { name: "Scout Dota", tag: "SD", game: "dota2" });
  // Recent activity: a completed quick match for the ace.
  const [c] = await db.query<{ id: string }>(
    "insert into challenges (kind, game, challenger_id, opponent_id, status, winner_id, expires_at, completed_at) values ('quick', 'cs2', $1, $2, 'completed', $1, now() + interval '1 day', now()) returning id",
    [ace.id, mate.id],
  );
  void c;
  assert.deepEqual(names(await scoutPlayers(db, viewer.id, parseScoutQuery({ game: "cs2" }))), ["sc_ace", "sc_mate"], "a private profile is never listed");
  assert.deepEqual(names(await scoutPlayers(db, viewer.id, parseScoutQuery({ game: "dota2" }))), ["sc_dota"], "a team in the game counts as playing it");
  assert.deepEqual(names(await scoutPlayers(db, viewer.id, parseScoutQuery({ game: "cs2", minRating: "1100", maxRating: "1300" }))), ["sc_ace"]);
  assert.deepEqual(names(await scoutPlayers(db, viewer.id, parseScoutQuery({ game: "cs2", minRating: "1300" }))), []);
  assert.deepEqual(names(await scoutPlayers(db, viewer.id, parseScoutQuery({ country: "AE" }))), ["sc_ace"]);
  const lft = await scoutPlayers(db, viewer.id, parseScoutQuery({ lft: "1" }));
  assert.deepEqual(names(lft), ["sc_ace"]);
  assert.equal(lft[0].lft_roles, "AWP, IGL");
  assert.deepEqual(names(await scoutPlayers(db, viewer.id, parseScoutQuery({ game: "cs2", activeDays: "7" }))), ["sc_ace", "sc_mate"], "both played the quick match");
  assert.deepEqual(names(await scoutPlayers(db, viewer.id, parseScoutQuery({ text: "ACE" }))), ["sc_ace"]);
  assert.deepEqual(names(await scoutPlayers(db, viewer.id, parseScoutQuery({ text: "sc_a" }))), ["sc_ace"], "an underscore is matched literally");
  assert.deepEqual(names(await scoutPlayers(db, viewer.id, parseScoutQuery({ text: "sc%e" }))), [], "a percent sign is not a wildcard");
  const all = await scoutPlayers(db, viewer.id, parseScoutQuery({}));
  assert.ok(!all.some((r) => r.username === "sc_viewer"), "the viewer is not listed");
  const [top] = await scoutPlayers(db, viewer.id, parseScoutQuery({ game: "cs2" }));
  assert.deepEqual([top.username, top.rating, top.matches, top.wins], ["sc_ace", 1240, 12, 8], "highest rating first");
});

test("watchlist: public profiles only, notes, a profile turning private leaves the list", async () => {
  const scout = await mk("sw_scout");
  const target = await mk("sw_target");
  const shy = await mk("sw_shy");
  await db.query("update users set profile_public = false where id = $1", [shy.id]);
  assert.deepEqual(await watchPlayer(db, scout, target.username, undefined), { created: true });
  assert.deepEqual(await watchPlayer(db, scout, target.username, "Сильный AWP"), { created: false });
  await rejects(watchPlayer(db, scout, shy.username, undefined), "not_found");
  await rejects(watchPlayer(db, scout, scout.username, undefined), "not_found");
  let list = await watchlist(db, scout.id);
  assert.deepEqual(list.map((w) => [w.username, w.note]), [["sw_target", "Сильный AWP"]]);
  await watchPlayer(db, scout, target.username, "");
  assert.equal((await watchlist(db, scout.id))[0].note, "", "an empty note field clears the note");
  const seen = await scoutPlayers(db, scout.id, parseScoutQuery({ text: "sw_target" }));
  assert.equal(seen[0].watched, true);
  await db.query("update users set profile_public = false where id = $1", [target.id]);
  assert.equal((await watchlist(db, scout.id)).length, 0, "a private profile leaves the list");
  await db.query("update users set profile_public = true where id = $1", [target.id]);
  assert.equal((await watchlist(db, scout.id)).length, 1, "and returns if made public again");
  assert.deepEqual(await unwatchPlayer(db, scout, target.username), { changed: true });
  assert.deepEqual(await unwatchPlayer(db, scout, target.username), { changed: false });
});

test("saved filters: replace by name, at most 20, delete; export and erasure", async () => {
  const scout = await mk("sf_scout");
  const target = await mk("sf_target");
  await rejects(saveFilter(db, scout, "Пусто", {}), "invalid_input");
  const first = await saveFilter(db, scout, "AWP MENA", { game: "cs2", country: "AE", lft: "1" });
  assert.equal(first.replaced, false);
  const again = await saveFilter(db, scout, "awp mena", { game: "cs2", minRating: "1200" });
  assert.deepEqual(again, { id: first.id, replaced: true }, "the same name, any case, replaces the query");
  const [stored] = await myFilters(db, scout.id);
  assert.deepEqual(stored.query, parseScoutQuery({ game: "cs2", minRating: "1200" }));
  for (let i = 1; i < MAX_FILTERS; i++) await saveFilter(db, scout, `Filter ${i}`, { game: "valorant", minRating: String(1000 + i) });
  await rejects(saveFilter(db, scout, "One too many", { game: "lol" }), "filter_limit");
  assert.deepEqual(await deleteFilter(db, scout, first.id), { changed: true });
  assert.deepEqual(await deleteFilter(db, target, first.id), { changed: false });
  // Export and erasure.
  await watchPlayer(db, scout, target.username, "note");
  await watchPlayer(db, target, scout.username, undefined);
  const data = (await exportAccount(db, scout)) as unknown as { scoutFilters: unknown[]; watchlist: unknown[] };
  assert.equal(data.scoutFilters.length, MAX_FILTERS - 1);
  assert.equal(data.watchlist.length, 1);
  await deleteAccount(db, scout, PASSWORD);
  const [left] = await db.query<{ filters: number; watch: number }>(
    "select (select count(*)::int from scout_filters where user_id = $1) as filters, (select count(*)::int from scout_watch where user_id = $1 or player_id = $1) as watch",
    [scout.id],
  );
  assert.deepEqual(left, { filters: 0, watch: 0 }, "the account leaves every watchlist");
});
