import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { rankings } from "../src/server/queries.ts";
import type { Queryable } from "../src/server/db.ts";
import { DIRECTIONS, MODULES, partnerModules } from "../src/lib/directions.ts";
import { dict } from "../src/lib/i18n.ts";
import { gameBySlug } from "../src/lib/games.ts";

test("rankings includes final placements without matches, without duplicating titles or match statistics", async () => {
  // Isolated PostgreSQL engine and minimal query schema: never connects to a service.
  const pg = new PGlite();
  const db: Queryable = { query: async <T>(sql: string, params?: unknown[]) => (await pg.query(sql, params)).rows as T[] };
  try {
    await pg.exec(`
      create table users(id text primary key, display_name text, username text, status text, profile_public boolean);
      create table teams(id text primary key, name text, slug text);
      create table tournaments(id text primary key, game text, status text);
      create table registrations(id text primary key, tournament_id text, user_id text, team_id text, placement int);
      create table matches(tournament_id text, a_reg text, b_reg text, winner_reg text, status text, outcome text);
      insert into users values ('a','A','a','active',true),('b','B','b','active',true),('p','Private','p','active',false),('z','Inactive','z','suspended',true);
      insert into teams values ('a','TA','ta'),('b','TB','tb');
      insert into tournaments values ('final','trackmania','COMPLETED'),('pending','trackmania','IN_PROGRESS'),('other','cs2','COMPLETED');
      insert into registrations values
        ('sa','final','a',null,1),('sb','final','b',null,2),('sp','final','p',null,1),('sz','final','z',null,1),
        ('ta','final',null,'a',1),('tb','final',null,'b',2),
        ('pending','pending','a',null,1),('other','other','a',null,1);
    `);
    let result = await rankings(db,"trackmania");
    assert.deepEqual(result.solo, [
      { name:"A",link:"a",wins:0,draws:0,losses:0,titles:1 },
      { name:"B",link:"b",wins:0,draws:0,losses:0,titles:0 },
    ]);
    assert.deepEqual(result.teams, [
      { name:"TA",link:"ta",wins:0,draws:0,losses:0,titles:1 },
      { name:"TB",link:"tb",wins:0,draws:0,losses:0,titles:0 },
    ]);
    await pg.exec(`
      insert into matches values ('final','sa','sb','sa','completed','played'),('final','sa','sb',null,'completed','played'),('final','sa',null,'sa','completed','bye'),
      ('final','ta','tb','ta','completed','played'),('final','ta','tb',null,'completed','played');
    `);
    result = await rankings(db,"trackmania");
    assert.deepEqual(result.solo.map(x=>[x.link,x.wins,x.draws,x.losses,x.titles]),[['a',1,1,0,1],['b',0,1,1,0]]);
    assert.deepEqual(result.teams.map(x=>[x.link,x.wins,x.draws,x.losses,x.titles]),[['ta',1,1,0,1],['tb',0,1,1,0]]);
    await pg.exec("update registrations set placement = case when placement = 1 then 2 else 1 end where tournament_id = 'final'");
    result = await rankings(db,"trackmania");
    assert.equal(result.solo[0].link,"b"); assert.equal(result.solo[0].titles,1);
    assert.equal(result.teams[0].link,"tb"); assert.equal(result.teams[0].titles,1);
    await pg.exec("update tournaments set status='IN_PROGRESS' where id='final'");
    result = await rankings(db,"trackmania");
    assert.ok([...result.solo,...result.teams].every(x=>x.titles===0));
    await pg.exec("update tournaments set status='ARCHIVED' where id='final'");
    result = await rankings(db,"trackmania");
    assert.equal(result.solo[0].titles,1); assert.equal(result.teams[0].titles,1);
  } finally { await pg.close(); }
});

test("public summaries reuse component states and preserve unfinished extensions", () => {
  const working=partnerModules(true), pending=partnerModules(false);
  for (const id of ["partner-api","stages","ffa","stage-chains"]) {
    assert.ok(working.some(x=>x.id===id));
    assert.ok(!pending.some(x=>x.id===id));
  }
  for(const [slug,id] of [["academy","academy"],["coaches","academy"],["media","media"],["venues","venues"]]) {
    assert.equal(DIRECTIONS.find(x=>x.slug===slug)?.state,MODULES.find(x=>x.id===id)?.state);
  }
  assert.ok(pending.some(x=>x.id==="sponsor-workspace"));
  assert.ok(MODULES.some(x=>x.state==="dev" && x.name.en.startsWith("Clips, highlights")));
  const map = MODULES.find(x=>x.name.en === "Venue map");
  assert.equal(map?.state,"works");
  assert.match(map!.note.en,/changes require review/);
  assert.match(map!.note.en,/Venues without coordinates remain in the list/);
});

test("racing catalogue copy does not inherit battle royale scoring", () => {
  assert.equal(gameBySlug("trackmania")?.scoring,"racing");
  for(const lang of ["ru","en"] as const) {
    const g=dict(lang).games;
    const text=[g.formatRacing,g.verificationRacing,...g.matrixRacing.flat()].join(" ");
    assert.doesNotMatch(text,/kill|убий|battle royale|королевск/i);
    assert.match(g.verificationRacing,lang==="en" ? /not connected/ : /не подключены/);
    assert.match(g.formatFfa,lang==="en" ? /kill/ : /убий/);
  }
});
