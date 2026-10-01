import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase, type Database } from "../src/server/db.ts";
import { deleteAccount, exportAccount, signUp, sessionUser, type SessionUser } from "../src/server/auth.ts";
import { createTeam } from "../src/server/teams.ts";
import { applicationsToDecide, applyToPost, closePost, createPost, decideApplication, listPosts, memberTeamIds, myFinder, pendingPostIds, teamVacancies, withdrawApplication } from "../src/server/finder.ts";
import { verifyAuditChain } from "../src/server/audit.ts";
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
const notes = (userId: string, kind: string) => db.query<{ data: Record<string, string> }>("select data from notifications where user_id = $1 and kind = $2", [userId, kind]);
const members = async (teamId: string) => (await db.query<{ user_id: string }>("select user_id from team_members where team_id = $1", [teamId])).map((r) => r.user_id);

test.before(async () => {
  db = await openDatabase({ embedded: true, dataDir: "memory://" });
});
test.after(async () => {
  await db.close();
});

test("LFT and LFG posts: validation, one open post per kind and game, listing, closing and expiry", async () => {
  const p1 = await mk("fdp1");
  const other = await mk("fdother");
  await rejects(createPost(db, p1, { kind: "boss", game: "cs2" }), "invalid_input");
  await rejects(createPost(db, p1, { kind: "lft", game: "chess" }), "invalid_game");
  const first = await createPost(db, p1, { kind: "lft", game: "cs2", region: "MENA", roles: "AWP", languages: "RU, EN", note: "Evenings" });
  const second = await createPost(db, p1, { kind: "lft", game: "cs2", region: "EU", roles: "Entry" });
  let list = await listPosts(db, { kind: "lft", game: "cs2" });
  assert.deepEqual(list.map((p) => p.id), [second.id], "posting again replaces the open post");
  assert.equal((await listPosts(db, { kind: "lft", region: "eu" })).length, 1, "region filter ignores case");
  assert.equal((await listPosts(db, { kind: "lft", region: "asia" })).length, 0);
  await createPost(db, p1, { kind: "lfg", game: "cs2" });
  assert.equal((await listPosts(db, { kind: "lft" })).length, 1, "an LFG post does not replace the LFT post");
  await rejects(closePost(db, other, second.id), "forbidden");
  assert.deepEqual(await closePost(db, p1, second.id), { changed: true });
  assert.deepEqual(await closePost(db, p1, second.id), { changed: false });
  assert.equal((await listPosts(db, { kind: "lft" })).length, 0);
  const third = await createPost(db, p1, { kind: "lft", game: "dota2" });
  await db.query("update finder_posts set expires_at = now() - interval '1 day' where id = $1", [third.id]);
  assert.equal((await listPosts(db, { kind: "lft" })).length, 0, "expired posts leave the list");
  void first;
});

test("vacancies: leaders open up to three; applications are accepted into the team until the places are filled", async () => {
  const cap = await mk("fdcap");
  const mate = await mk("fdmate");
  const [a1, a2, a3] = [await mk("fda1"), await mk("fda2"), await mk("fda3")];
  const team = await createTeam(db, cap, { name: "Finder Five", tag: "FF", game: "cs2" });
  await db.query("insert into team_members (team_id, user_id) values ($1, $2)", [team.id, mate.id]);
  await rejects(createPost(db, mate, { kind: "vacancy", teamId: team.id, roles: "IGL" }), "not_team_leader");
  const vacancy = await createPost(db, cap, { kind: "vacancy", teamId: team.id, roles: "Rifler", slots: "2", game: "valorant" });
  const [stored] = await teamVacancies(db, team.id);
  assert.deepEqual([stored.game, stored.slots, stored.team_name], ["cs2", 2, "Finder Five"], "a vacancy takes the team's game");
  await createPost(db, cap, { kind: "vacancy", teamId: team.id, roles: "AWP" });
  await createPost(db, cap, { kind: "vacancy", teamId: team.id, roles: "Coach" });
  await rejects(createPost(db, cap, { kind: "vacancy", teamId: team.id, roles: "Analyst" }), "finder_limit");
  // Applying.
  await rejects(applyToPost(db, mate, vacancy.id, "I am already in"), "invalid_input");
  await rejects(applyToPost(db, cap, vacancy.id, "Own post"), "invalid_input");
  const app1 = await applyToPost(db, a1, vacancy.id, "Faceit level 8, evenings");
  assert.deepEqual(await applyToPost(db, a1, vacancy.id, "Again"), { id: app1.id, created: false });
  assert.deepEqual([...(await pendingPostIds(db, a1.id))], [vacancy.id], "the card shows a sent answer instead of the form");
  assert.deepEqual((await memberTeamIds(db, mate.id)).includes(team.id), true, "a member is not offered the team's own vacancy");
  const app2 = await applyToPost(db, a2, vacancy.id, "");
  const app3 = await applyToPost(db, a3, vacancy.id, "");
  assert.equal((await notes(cap.id, "finder_application")).length, 3);
  assert.equal((await applicationsToDecide(db, cap.id)).length, 3);
  // Deciding.
  await rejects(decideApplication(db, mate, app1.id, true), "forbidden");
  assert.deepEqual(await decideApplication(db, cap, app1.id, true), { changed: true });
  assert.ok((await members(team.id)).includes(a1.id), "an accepted applicant joins the team");
  assert.equal((await pendingPostIds(db, a1.id)).size, 0);
  assert.equal((await notes(a1.id, "finder_accepted")).length, 1);
  assert.deepEqual(await decideApplication(db, cap, app1.id, true), { changed: false });
  await decideApplication(db, cap, app2.id, true);
  const [post] = await db.query<{ status: string }>("select status from finder_posts where id = $1", [vacancy.id]);
  assert.equal(post.status, "closed", "filled places close the vacancy");
  const [left] = await db.query<{ status: string }>("select status from finder_applications where id = $1", [app3.id]);
  assert.equal(left.status, "declined", "the rest are declined when the vacancy closes");
  await rejects(applyToPost(db, a3, vacancy.id, "Late"), "finder_closed");
  assert.equal((await verifyAuditChain(db)).valid, true);
});

test("LFG answers connect two players; applications can be withdrawn; LFT posts take invitations, not applications", async () => {
  const host = await mk("fdhost");
  const guest = await mk("fdguest");
  const lfg = await createPost(db, host, { kind: "lfg", game: "cs2", note: "Premier tonight" });
  const lft = await createPost(db, host, { kind: "lft", game: "dota2" });
  await rejects(applyToPost(db, guest, lft.id, "Hi"), "invalid_input");
  const app = await applyToPost(db, guest, lfg.id, "Count me in");
  assert.deepEqual(await withdrawApplication(db, guest, app.id), { changed: true });
  assert.deepEqual(await withdrawApplication(db, guest, app.id), { changed: false });
  const again = await applyToPost(db, guest, lfg.id, "Changed my mind");
  await decideApplication(db, host, again.id, true);
  const [n] = await notes(guest.id, "finder_lfg_accepted");
  assert.equal(n.data.profile, "fdhost", "the answer links the host's profile");
  const mine = await myFinder(db, guest.id);
  assert.deepEqual(mine.applications.map((a) => a.status).sort(), ["accepted", "withdrawn"]);
  // A platform administrator removes any post; pending answers are declined with it.
  const mod = await mk("fdmod");
  const late = await applyToPost(db, mod, lfg.id, "Still room?");
  await db.query("insert into user_roles (user_id, role) values ($1, 'admin')", [mod.id]);
  const admin: SessionUser = { ...mod, roles: [...mod.roles, "admin"] };
  assert.deepEqual(await closePost(db, admin, lft.id), { changed: true });
  const other = await createPost(db, guest, { kind: "lfg", game: "dota2" });
  const pendingOnOther = await applyToPost(db, host, other.id, "Me");
  assert.deepEqual(await closePost(db, admin, other.id), { changed: true });
  const [declined] = await db.query<{ status: string }>("select status from finder_applications where id = $1", [pendingOnOther.id]);
  assert.equal(declined.status, "declined");
  void late;
});

test("the account export carries finder posts and applications; deleting the account erases them", async () => {
  const p = await mk("fderase");
  const host = await mk("fderasehost");
  const post = await createPost(db, p, { kind: "lft", game: "cs2", note: "Contact me via the portal" });
  const lfg = await createPost(db, host, { kind: "lfg", game: "cs2" });
  await applyToPost(db, p, lfg.id, "Hello");
  const data = (await exportAccount(db, p)) as unknown as { finderPosts: unknown[]; finderApplications: unknown[] };
  assert.equal(data.finderPosts.length, 1);
  assert.equal(data.finderApplications.length, 1);
  await deleteAccount(db, p, PASSWORD);
  const [left] = await db.query<{ posts: number; apps: number }>(
    "select (select count(*)::int from finder_posts where user_id = $1) as posts, (select count(*)::int from finder_applications where user_id = $1) as apps",
    [p.id],
  );
  assert.deepEqual(left, { posts: 0, apps: 0 });
  void post;
});
