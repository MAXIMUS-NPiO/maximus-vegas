import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import type { SessionUser } from "./auth.ts";
import { canManageOrg, requireSection } from "./access.ts";
import { activeAccount } from "./product-access.ts";
import { fail, isUniqueViolation } from "./errors.ts";
import { audit } from "./audit.ts";
import { seal, unseal } from "./secret-box.ts";
import { isGame } from "../lib/games.ts";
import { canonicalStats, merkleTree, statsEnvelope, verifyStatsSignature } from "../lib/stats-proof.ts";
import * as v from "./validate.ts";

export type StatsSource = { id: string; org_id: string; name: string; games: string[]; status: string; public_key: string; evidence_url: string; created_by: string; review_note: string };
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const uuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
function publicKey(input: unknown) {
  try { const k = createPublicKey(v.clean(input, 1000)); if (k.asymmetricKeyType !== "ed25519") return fail("invalid_input"); return k.export({ format: "pem", type: "spki" }).toString(); } catch { return fail("invalid_input"); }
}
export async function createStatsSource(db: Database, user: SessionUser, orgId: string, input: Record<string, unknown>, games: string[]) {
  const name = v.displayName(input.name, 80), key = publicKey(input.publicKey), evidence = v.optionalUrl(input.evidence);
  if (!evidence.startsWith("https://") || !games.length || games.length > 20 || games.some(g => !isGame(g))) fail("invalid_input");
  return db.tx(async q => {
    await activeAccount(q, user); if (!(await canManageOrg(q, orgId, user))) fail("forbidden");
    await q.query("select id from organizations where id=$1 for update", [orgId]);
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from stats_sources where org_id=$1", [orgId]); if (n.n >= 10) fail("api_key_limit");
    const [s] = await q.query<{ id: string }>("insert into stats_sources(org_id,name,games,public_key,evidence_url,created_by) values($1,$2,$3,$4,$5,$6) returning id", [orgId, name, [...new Set(games)], key, evidence, user.id]);
    await audit(q, { actorId: user.id, action: "stats.source_created", entity: "stats_source", entityId: s.id }); return s.id;
  });
}
export async function reviewStatsSource(db: Database, user: SessionUser, sourceId: string, status: string, note: string) {
  requireSection(user, "system"); if (!["approved", "suspended"].includes(status) || note.trim().length < 10) fail("invalid_input");
  await db.tx(async q => {
    const [s] = await q.query<StatsSource>("select * from stats_sources where id=$1 for update", [sourceId]); if (!s) fail("not_found");
    if (s.created_by === user.id || await canManageOrg(q, s.org_id, { ...user, roles: [] })) fail("cannot_modify_self");
    await q.query("update stats_sources set status=$2,review_note=$3,reviewed_by=$4,reviewed_at=now() where id=$1", [sourceId, status, v.clean(note, 1000), user.id]);
    await audit(q, { actorId: user.id, action: "stats.source_reviewed", entity: "stats_source", entityId: sourceId, data: { status } });
  });
}
export async function rotateStatsKey(db: Database, user: SessionUser, sourceId: string, input: unknown) {
  const key = publicKey(input);
  await db.tx(async q => {
    const [s] = await q.query<StatsSource>("select * from stats_sources where id=$1 for update", [sourceId]);
    if (!s || !(await canManageOrg(q, s.org_id, user))) fail("forbidden");
    await q.query("update stats_sources set public_key=$2,status='pending',reviewed_by=null,reviewed_at=null where id=$1", [sourceId, key]);
    await q.query("update stats_links set status='revoked',challenge_sealed='' where source_id=$1", [sourceId]);
    await audit(q, { actorId: user.id, action: "stats.key_rotated", entity: "stats_source", entityId: sourceId });
  });
}
export async function linkStatsSource(db: Database, user: SessionUser, sourceId: string, game: string, handleInput: unknown) {
  const handle = v.oneLine(handleInput, 100); if (!handle || !isGame(game)) fail("invalid_input");
  return db.tx(async q => {
    await activeAccount(q, user);
    const [s] = await q.query<StatsSource>("select * from stats_sources where id=$1 and status='approved'", [sourceId]); if (!s || !s.games.includes(game)) fail("offer_unavailable");
    await q.query("delete from stats_links where source_id=$1 and game=$2 and status='pending' and expires_at<now()", [sourceId, game]);
    const challenge = randomBytes(24).toString("base64url"), sealed = JSON.stringify(seal("stats-link", challenge));
    try {
      const [l] = await q.query<{ id: string }>(`insert into stats_links(source_id,user_id,game,handle,challenge_hash,challenge_sealed,expires_at) values($1,$2,$3,$4,$5,$6,now()+interval '1 day')
        on conflict(source_id,user_id,game) do update set handle=excluded.handle,status='pending',challenge_hash=excluded.challenge_hash,challenge_sealed=excluded.challenge_sealed,expires_at=excluded.expires_at,verified_at=null returning id`, [sourceId, user.id, game, handle, digest(challenge), sealed]);
      return l.id;
    } catch (e) { if (isUniqueViolation(e)) fail("already_registered"); throw e; }
  });
}
export async function revokeStatsLink(db: Database, user: SessionUser, id: string) {
  await db.query("update stats_links set status='revoked',challenge_sealed='' where id=$1 and user_id=$2", [id, user.id]);
}
type IntakeHeaders = { source: string; nonce: string; timestamp: string; signature: string };
export async function ingestStatistics(db: Database, headers: IntakeHeaders, body: string, now = Date.now()) {
  if (!uuid(headers.source) || !uuid(headers.nonce) || !/^\d{9,11}$/.test(headers.timestamp) || Math.abs(Number(headers.timestamp) * 1000 - now) > 300_000 || body.length > 20000 || headers.signature.length > 128) fail("token_invalid");
  let data: Record<string, unknown>; try { data = JSON.parse(body); } catch { return fail("invalid_input"); }
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("invalid_input");
  return db.tx(async q => {
    const [source] = await q.query<StatsSource>("select * from stats_sources where id=$1 and status='approved' for update", [headers.source]);
    if (!source || !verifyStatsSignature(source.public_key, headers.signature, statsEnvelope(headers.source, headers.nonce, headers.timestamp, body))) fail("token_invalid");
    const bodyHash = digest(body), [old] = await q.query<{ body_hash: string; observation_id: string | null }>("select body_hash,observation_id from stats_receipts where source_id=$1 and nonce=$2", [headers.source, headers.nonce]);
    if (old) { if (old.body_hash !== bodyHash) fail("token_invalid"); return { id: old.observation_id, replay: true }; }
    const [rate] = await q.query<{ n: number }>("select count(*)::int as n from stats_receipts where source_id=$1 and received_at>now()-interval '1 minute'", [source.id]); if (rate.n >= 120) fail("request_limit");
    const game = v.oneLine(data.game, 40), handle = v.oneLine(data.handle, 100);
    if (!source.games.includes(game)) fail("invalid_game");
    const [link] = await q.query<{ id: string; user_id: string; status: string; challenge_hash: string; expires_at: Date }>("select l.* from stats_links l join users u on u.id=l.user_id where l.source_id=$1 and l.game=$2 and lower(l.handle)=lower($3) and l.status<>'revoked' and u.status='active' for update of l", [source.id, game, handle]);
    if (!link) fail("consent_required");
    let id: string | null = null;
    if (data.kind === "link") {
      if (link.status !== "pending" || new Date(link.expires_at).getTime() < now || digest(String(data.challenge ?? "")) !== link.challenge_hash) fail("token_invalid");
      await q.query("update stats_links set status='verified',verified_at=now(),challenge_sealed='' where id=$1", [link.id]);
    } else if (data.kind === "match") {
      if (link.status !== "verified") fail("consent_required");
      const ref = v.oneLine(data.matchRef, 150), playedAt = new Date(String(data.playedAt)), input = data.metrics;
      if (!ref || !Number.isFinite(playedAt.getTime()) || playedAt.getTime() > now + 300_000 || playedAt.getTime() < now - 365 * 86400_000 || !input || typeof input !== "object" || Array.isArray(input)) return fail("invalid_input");
      const metrics: Record<string, number> = {}, allowed = ["kills", "assists", "deaths", "headshots", "damage", "placement", "score", "durationSeconds"];
      for (const [key, value] of Object.entries(input)) { if (!allowed.includes(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e9) fail("invalid_input"); metrics[key] = value as number; }
      if (!Object.keys(metrics).length) fail("invalid_input");
      const envelope = statsEnvelope(source.id, headers.nonce, headers.timestamp, body);
      const [existing] = await q.query<{ id: string; digest: string }>("select id,digest from stats_observations where source_id=$1 and user_id=$2 and game=$3 and match_ref=$4", [source.id, link.user_id, game, ref]);
      if (existing) { if (existing.digest !== bodyHash) fail("duplicate_entry"); id = existing.id; }
      else {
        const [row] = await q.query<{ id: string }>("insert into stats_observations(source_id,user_id,game,match_ref,played_at,metrics,digest,signed_body,signature,public_key) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id", [source.id, link.user_id, game, ref, playedAt, JSON.stringify(metrics), bodyHash, envelope, headers.signature, source.public_key]); id = row.id;
      }
    } else fail("invalid_input");
    await q.query("insert into stats_receipts(source_id,nonce,body_hash,observation_id) values($1,$2,$3,$4)", [source.id, headers.nonce, bodyHash, id]);
    await audit(q, { actorId: null, action: "stats.signed_record_received", entity: "stats_source", entityId: source.id, data: { observation: id, digest: bodyHash, kind: data.kind } });
    return { id, replay: false };
  });
}
export async function reviewObservation(db: Database, user: SessionUser, id: string, status: string, note: string) {
  if (!["confirmed", "rejected"].includes(status) || note.trim().length < 10) fail("invalid_input");
  await db.tx(async q => {
    const [r] = await q.query<{ org_id: string; user_id: string; status: string }>("select s.org_id,o.user_id,o.status from stats_observations o join stats_sources s on s.id=o.source_id where o.id=$1 for update of o", [id]);
    if (!r || !(await canManageOrg(q, r.org_id, user)) || r.user_id === user.id) fail("forbidden");
    if (r.status !== "pending") fail("invalid_transition");
    await q.query("update stats_observations set status=$2,reviewed_by=$3,review_note=$4 where id=$1", [id, status, user.id, v.clean(note, 1000)]);
    await audit(q, { actorId: user.id, action: "stats.record_reviewed", entity: "stats_observation", entityId: id, data: { status } });
  });
}
export async function statsOverview(q: Queryable, userId: string) {
  const sources = await q.query<StatsSource>("select id,org_id,name,games,status,public_key,evidence_url,review_note from stats_sources where status='approved' order by name limit 100");
  const links = await q.query<{ id: string; name: string; source_id: string; game: string; handle: string; status: string; challenge_sealed: string; expires_at: Date }>("select l.*,s.name from stats_links l join stats_sources s on s.id=l.source_id where l.user_id=$1 order by l.created_at desc", [userId]);
  const observations = await q.query<{ id: string; name: string; game: string; match_ref: string; played_at: Date; metrics: Record<string, number>; status: string; review_note: string }>("select o.id,s.name,o.game,o.match_ref,o.played_at,o.metrics,o.status,o.review_note from stats_observations o join stats_sources s on s.id=o.source_id where o.user_id=$1 order by o.played_at desc limit 100", [userId]);
  const snapshots = await q.query<{ id: string; root: string; leaf_count: number; shared: boolean; created_at: Date; signature: string | null }>("select id,root,leaf_count,shared,created_at,signature from stats_snapshots where user_id=$1 order by created_at desc limit 30", [userId]);
  return { sources, observations, snapshots, links: links.map(({ challenge_sealed, ...l }) => { const s = challenge_sealed ? JSON.parse(challenge_sealed) : null; return { ...l, challenge: l.status === "pending" && s && new Date(l.expires_at).getTime() > Date.now() ? unseal("stats-link", s.value, s.scheme) : null }; }) };
}
export async function createSnapshot(db: Database, user: SessionUser, fromInput?: string, untilInput?: string) {
  const from = fromInput ? new Date(fromInput) : new Date(0), until = untilInput ? new Date(new Date(untilInput).getTime() + 86400_000) : new Date();
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(until.getTime()) || until <= from) fail("invalid_date");
  return db.tx(async q => {
    await q.query("set transaction isolation level repeatable read");
    await activeAccount(q, user); await q.query("select id from users where id=$1 for update", [user.id]);
    const [n] = await q.query<{ n: number }>("select count(*)::int as n from stats_snapshots where user_id=$1 and created_at>now()-interval '1 day'", [user.id]); if (n.n >= 5) fail("request_limit");
    const source = await q.query("select o.id,o.source_id,s.name as source,o.game,o.match_ref,o.played_at,o.metrics,o.signed_body,o.signature,o.public_key,o.review_note from stats_observations o join stats_sources s on s.id=o.source_id where o.user_id=$1 and o.status='confirmed' and o.played_at >= $2 and o.played_at < $3 order by o.id limit 5001", [user.id, from, until]);
    const xp = await q.query("select id,amount,reason,game,ref,created_at from xp_events where user_id=$1 and created_at >= $2 and created_at < $3 order by id limit 5001", [user.id, from, until]);
    const coins = await q.query("select id,delta,reason,ref,balance_after,created_at from coin_ledger where user_id=$1 and created_at >= $2 and created_at < $3 order by id limit 5001", [user.id, from, until]);
    const payments = await q.query(`select i.id,i.number,i.status,i.amount_minor::text,i.currency,i.exponent,i.refunded_minor::text,i.paid_at,
      (select count(*)::int from payment_attempts a where a.invoice_id=i.id and a.mode='live' and a.status='succeeded') as successful_live_provider_attempts
      from invoices i where i.user_id=$1 and i.paid_at >= $2 and i.paid_at < $3 order by i.id limit 5001`, [user.id, from, until]);
    if ([source, xp, coins, payments].some(rows => rows.length > 5000)) fail("too_many_entries");
    const encoded = JSON.stringify([{ type: "scope", from, until, coinsHaveMonetaryValue: false }, ...source.map(r => ({ type: "source_statistic", ...r })), ...xp.map(r => ({ type: "confirmed_activity", ...r })), ...coins.map(r => ({ type: "internal_coin_ledger", ...r })), ...payments.map(r => ({ type: "invoice_record", ...r }))]);
    if (Buffer.byteLength(encoded) > 1500_000) fail("too_many_entries");
    const records = JSON.parse(encoded) as unknown[];
    const { root } = merkleTree(records), id = randomUUID(), envelope = canonicalStats({ version: "MV-STATS-1", id, root, count: records.length });
    let signature: string | null = null, key: string | null = null;
    if (process.env.MV_STATS_SIGNING_KEY?.trim()) {
      const privateKey = createPrivateKey(process.env.MV_STATS_SIGNING_KEY.replace(/\\n/g, "\n")); if (privateKey.asymmetricKeyType !== "ed25519") fail("server_error");
      signature = sign(null, Buffer.from(envelope), privateKey).toString("base64"); key = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    }
    await q.query("insert into stats_snapshots(id,user_id,root,leaf_count,records,signature,public_key) values($1,$2,$3,$4,$5,$6,$7)", [id, user.id, root, records.length, JSON.stringify(records), signature, key]);
    await audit(q, { actorId: user.id, action: "stats.snapshot_created", entity: "stats_snapshot", entityId: id, data: { root, count: records.length } }); return id;
  });
}
export async function snapshotProof(q: Queryable, id: string, userId?: string, recordIndex?: number) {
  if (!uuid(id)) return null;
  const [s] = await q.query<{ id: string; user_id: string; root: string; leaf_count: number; records: unknown[]; signature: string | null; public_key: string | null; shared: boolean; created_at: Date }>("select * from stats_snapshots where id=$1", [id]);
  if (!s || (!s.shared && s.user_id !== userId)) return null;
  const [anchor] = await q.query("select chain_id,contract_address,transaction_hash,block_number,verified_at from stats_anchors where snapshot_id=$1", [id]);
  const own = s.user_id === userId;
  const single = own && recordIndex !== undefined && Number.isSafeInteger(recordIndex) && recordIndex >= 0 && recordIndex < s.records.length;
  return { version: "MV-STATS-1", id: s.id, dataset: digest(`MV-STATS-1:${s.id}`), root: s.root, count: s.leaf_count, createdAt: s.created_at, signature: s.signature, publicKey: s.public_key, anchor: anchor ?? null,
    ...(single ? { record: s.records[recordIndex!], proof: merkleTree(s.records).proofs[recordIndex!] } : own ? { records: s.records } : {}),
    scope: "Integrity proof. Partner signatures identify the submitting source; organiser review is not publisher verification. Internal coins are not money. No blockchain inclusion is claimed without a verified anchor." };
}
export async function shareSnapshot(db: Database, user: SessionUser, id: string, shared: boolean) {
  await db.query("update stats_snapshots set shared=$3 where id=$1 and user_id=$2", [id, user.id, shared]);
}
export async function statisticsExport(q: Queryable, userId: string) {
  return { links: await q.query("select source_id,game,handle,status,created_at,verified_at from stats_links where user_id=$1", [userId]), records: await q.query("select id,source_id,game,match_ref,played_at,metrics,status,review_note from stats_observations where user_id=$1", [userId]), snapshots: await q.query("select id,root,leaf_count,shared,created_at from stats_snapshots where user_id=$1", [userId]) };
}
export async function eraseStatistics(q: Queryable, userId: string) {
  await q.query("delete from stats_links where user_id=$1", [userId]);
  await q.query("delete from stats_observations where user_id=$1", [userId]);
  await q.query("delete from stats_snapshots where user_id=$1", [userId]);
}
