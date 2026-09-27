import { createHash } from "node:crypto";
import type { Queryable } from "./db.ts";

const GENESIS = "0".repeat(64);
const AUDIT_LOCK = 7461002;

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export type AuditEntry = {
  actorId: string | null;
  action: string;
  entity: string;
  entityId: string;
  data?: Record<string, unknown>;
};

function digest(prev: string, at: string, e: AuditEntry): string {
  return createHash("sha256")
    .update([prev, at, e.actorId ?? "", e.action, e.entity, e.entityId, canonical(e.data ?? {})].join("|"))
    .digest("hex");
}

/** Appends a hash-chained audit record. Must run inside the caller's transaction. */
export async function audit(q: Queryable, input: AuditEntry): Promise<void> {
  // Hash exactly what will be stored: Dates and other JSON-serialisable values are normalised first,
  // so verification over the stored jsonb reproduces the same digest.
  const entry: AuditEntry = { ...input, data: JSON.parse(JSON.stringify(input.data ?? {})) };
  await q.query("select pg_advisory_xact_lock($1)", [AUDIT_LOCK]);
  const [last] = await q.query<{ hash: string }>(
    "select hash from audit_log order by id desc limit 1",
  );
  const prev = last?.hash ?? GENESIS;
  const at = new Date().toISOString();
  const hash = digest(prev, at, entry);
  await q.query(
    `insert into audit_log (at, actor_id, action, entity, entity_id, data, prev_hash, hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [at, entry.actorId, entry.action, entry.entity, entry.entityId, JSON.stringify(entry.data ?? {}), prev, hash],
  );
}

export type ChainReport = { records: number; valid: boolean; brokenAt: number | null };

/** Recomputes the whole chain; any edited, removed or reordered record breaks it. */
export async function verifyAuditChain(q: Queryable): Promise<ChainReport> {
  const rows = await q.query<{
    id: string | number;
    at: Date;
    actor_id: string | null;
    action: string;
    entity: string;
    entity_id: string;
    data: Record<string, unknown>;
    prev_hash: string;
    hash: string;
  }>("select * from audit_log order by id asc");
  let prev = GENESIS;
  for (const r of rows) {
    const at = new Date(r.at).toISOString();
    const expected = digest(prev, at, {
      actorId: r.actor_id,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      data: r.data,
    });
    if (r.prev_hash !== prev || r.hash !== expected)
      return { records: rows.length, valid: false, brokenAt: Number(r.id) };
    prev = r.hash;
  }
  return { records: rows.length, valid: true, brokenAt: null };
}
