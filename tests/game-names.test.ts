import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrations } from "../src/server/schema.ts";
import { changeGameName } from "../src/server/game-names.ts";
import type { Database } from "../src/server/db.ts";
test("game names preserve originals, deduplicate, isolate users and remove individual names", async () => {
 const pg = new PGlite();
 const query = async <T>(sql: string, params?: unknown[]) => (await pg.query(sql, params)).rows as T[];
 const db = { query, tx: async (fn: (q: {query: typeof query}) => Promise<unknown>) => pg.transaction(async tx => fn({query: async <T>(sql:string,p?:unknown[]) => (await tx.query(sql,p)).rows as T[]})), kind:"embedded", close:async()=>{} } as Database;
 const a="00000000-0000-0000-0000-000000000001", b="00000000-0000-0000-0000-000000000002";
 try {
 await pg.exec("create table users(id uuid primary key); create table linked_game_accounts(user_id uuid references users(id), game text, handle text, verified boolean default false, created_at timestamptz default now(), primary key(user_id,game))");
 await pg.query("insert into users values ($1),($2)",[a,b]);
 await pg.query("insert into linked_game_accounts(user_id,game,handle) values ($1,'cs2','Original')",[a]);
 for(const sql of migrations.find(m=>m.id===25)!.statements) await pg.exec(sql);
 await changeGameName(db,a,"cs2","Second");
 await changeGameName(db,a,"cs2","Second");
 await changeGameName(db,a,"cs2","Original");
 assert.equal((await query("select * from all_game_accounts where user_id=$1",[a])).length,2);
 await changeGameName(db,b,"cs2",undefined,"Original");
 assert.equal((await query("select * from all_game_accounts where user_id=$1",[a])).length,2);
 await changeGameName(db,a,"cs2",undefined,"Original");
 assert.deepEqual(await query("select handle from linked_game_accounts where user_id=$1",[a]),[{handle:"Second"}]);
 await changeGameName(db,a,"cs2",undefined,"Second");
 assert.equal((await query("select * from all_game_accounts where user_id=$1",[a])).length,0);
 await assert.rejects(changeGameName(db,a,"cs2","   "));
 } finally {await pg.close();}
});
