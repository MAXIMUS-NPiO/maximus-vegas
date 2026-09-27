import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { getDb, type Database } from "./db.ts";
import { SESSION_COOKIE, sessionUser, type SessionUser } from "./auth.ts";

export type Viewer = { db: Database | null; user: SessionUser | null; dbError: boolean };

/** Per-request database handle and signed-in user. Never throws: pages render an honest state instead. */
export const viewer = cache(async (): Promise<Viewer> => {
  // Portal data is per-request: never let a build-time snapshot (e.g. a database outage) become static HTML.
  await connection();
  let db: Database | null = null;
  try {
    db = await getDb();
  } catch (error) {
    console.error("[db] unavailable:", (error as Error).message);
    return { db: null, user: null, dbError: true };
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  try {
    return { db, user: await sessionUser(db, token), dbError: false };
  } catch (error) {
    console.error("[session] lookup failed:", (error as Error).message);
    return { db, user: null, dbError: false };
  }
});
