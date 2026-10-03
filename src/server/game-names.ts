import type { Database } from "./db.ts";
import { oneLine } from "./validate.ts";
import { fail } from "./errors.ts";

/** Keep the original row for compatibility; additional names never replace it. */
export async function changeGameName(db: Database, userId: string, game: string, handle: unknown, removeHandle?: unknown) {
  const remove = typeof removeHandle === "string";
  const value = oneLine(remove ? removeHandle : handle, 60);
  if (!value) fail("invalid_input");
  await db.tx(async q => {
    await q.query("select id from users where id = $1 for update", [userId]);
    const [primary] = await q.query<{ handle: string }>("select handle from linked_game_accounts where user_id = $1 and game = $2", [userId, game]);
    if (remove) {
      if (primary?.handle === value) {
        const [next] = await q.query<{ handle: string; verified: boolean; created_at: Date }>("select handle, verified, created_at from additional_game_accounts where user_id = $1 and game = $2 order by created_at, handle limit 1", [userId, game]);
        if (next) {
          await q.query("update linked_game_accounts set handle = $3, verified = $4, created_at = $5 where user_id = $1 and game = $2", [userId, game, next.handle, next.verified, next.created_at]);
          await q.query("delete from additional_game_accounts where user_id = $1 and game = $2 and handle = $3", [userId, game, next.handle]);
        } else {
          await q.query("delete from linked_game_accounts where user_id = $1 and game = $2", [userId, game]);
        }
      } else {
        await q.query("delete from additional_game_accounts where user_id = $1 and game = $2 and handle = $3", [userId, game, value]);
      }
    } else if (!primary) {
      await q.query("insert into linked_game_accounts (user_id, game, handle) values ($1, $2, $3)", [userId, game, value]);
    } else if (primary.handle !== value) {
      await q.query("insert into additional_game_accounts (user_id, game, handle) values ($1, $2, $3) on conflict do nothing", [userId, game, value]);
    }
  });
}
