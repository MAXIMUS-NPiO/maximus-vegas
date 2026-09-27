import { migrations } from "./schema.ts";

export type Row = Record<string, unknown>;
export interface Queryable {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
}
export interface Database extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  kind: "postgres" | "embedded";
  close(): Promise<void>;
}

export class DatabaseUnavailable extends Error {
  constructor(message = "Database is not configured") {
    super(message);
    this.name = "DatabaseUnavailable";
  }
}

const MIGRATION_LOCK = 7461001;

export function databaseUrl(): string | undefined {
  const url =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.NEON_DATABASE_URL;
  return url?.trim() || undefined;
}

/**
 * Production and preview deployments require a real PostgreSQL connection.
 * Local development and tests fall back to embedded PostgreSQL (PGlite).
 */
export function embeddedAllowed(): boolean {
  if (process.env.MV_EMBEDDED_DB === "1") return true;
  if (process.env.VERCEL) return false;
  return process.env.NODE_ENV !== "production" || process.env.MV_LOCAL === "1";
}

async function createPostgres(url: string): Promise<Database> {
  const { default: pg } = await import("pg");
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX || 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    ssl: local || /sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  const run = async <T>(
    client: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> },
    text: string,
    params?: unknown[],
  ) => (await client.query(text, params)).rows as T[];
  return {
    kind: "postgres",
    query: (text, params) => run(pool, text, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn({ query: (t, p) => run(client, t, p) });
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function createEmbedded(dataDir?: string): Promise<Database> {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir && !dataDir.includes("://")) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dataDir, { recursive: true });
  }
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  // PGlite is a single connection: serialise transactions explicitly.
  let chain: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  return {
    kind: "embedded",
    query: (text, params) =>
      exclusive(async () => (await db.query(text, params)).rows as never),
    tx: (fn) =>
      exclusive(() =>
        db.transaction(async (t) =>
          fn({ query: async (text, params) => (await t.query(text, params)).rows as never }),
        ),
      ),
    close: () => db.close(),
  };
}

export async function migrate(db: Database): Promise<void> {
  await db.tx(async (q) => {
    await q.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await q.query(
      "create table if not exists schema_migrations (id int primary key, name text not null, applied_at timestamptz not null default now())",
    );
    const done = new Set(
      (await q.query<{ id: number }>("select id from schema_migrations")).map((r) => r.id),
    );
    for (const m of migrations) {
      if (done.has(m.id)) continue;
      for (const statement of m.statements) await q.query(statement);
      await q.query("insert into schema_migrations (id, name) values ($1, $2)", [m.id, m.name]);
    }
  });
}

export async function openDatabase(options: { url?: string; dataDir?: string; embedded?: boolean } = {}): Promise<Database> {
  const url = options.url ?? databaseUrl();
  let db: Database;
  if (url && !options.embedded) db = await createPostgres(url);
  else if (options.embedded || embeddedAllowed())
    db = await createEmbedded(options.dataDir ?? process.env.MV_DATA_DIR ?? ".data/pglite");
  else throw new DatabaseUnavailable();
  await migrate(db);
  return db;
}

const globalKey = Symbol.for("maximus.vegas.db");
type Holder = { [globalKey]?: Promise<Database> };

export function getDb(): Promise<Database> {
  const holder = globalThis as Holder;
  if (!holder[globalKey]) {
    holder[globalKey] = openDatabase().catch((error) => {
      delete holder[globalKey];
      throw error;
    });
  }
  return holder[globalKey]!;
}
