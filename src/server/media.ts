/**
 * Small image uploads stored in PostgreSQL (no external object storage is connected). Only PNG, JPEG and
 * WebP are accepted, identified by their file signature rather than the browser-supplied type. Brand images
 * are re-encoded; evidence serves a normalized derivative and keeps a private original/hash. Evidence images are visible
 * only to the match's participants and its staff; logos and banners are public.
 */
import { createHash } from "node:crypto";
import type { Database, Queryable } from "./db.ts";
import { audit } from "./audit.ts";
import { DomainError } from "./errors.ts";
import { fail } from "./errors.ts";
import { hasSection } from "./staff-roles.ts";

export type MediaKind = "team_logo" | "team_banner" | "tournament_banner" | "evidence" | "sponsor_logo" | "avatar";

export const MEDIA_LIMITS: Record<MediaKind, number> = {
  team_logo: 256 * 1024,
  team_banner: 1024 * 1024,
  tournament_banner: 1024 * 1024,
  evidence: 1536 * 1024,
  sponsor_logo: 256 * 1024,
  avatar: 128 * 1024,
};

const DAILY_UPLOADS = 20;
const DAILY_BYTES = 12 * 1024 * 1024;

export function sniffImage(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a)
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

/** Returns null when no file was chosen; throws on anything invalid. */
export async function storeUpload(q: Queryable, ownerId: string | null, kind: MediaKind, file: File | null | undefined): Promise<string | null> {
  if (!file || typeof file === "string" || file.size === 0) return null;
  const brand = kind !== "evidence";
  if (file.size > (brand ? 20 * 1024 * 1024 : MEDIA_LIMITS[kind])) fail("file_too_large");
  let bytes = new Uint8Array(await file.arrayBuffer());
  const original=brand?null:bytes;
  if (brand) {
    const { normalizeBrandImage } = await import("./normalize-image.ts");
    bytes = new Uint8Array(await normalizeBrandImage(bytes, kind === "team_logo" || kind === "sponsor_logo" || kind === "avatar", MEDIA_LIMITS[kind]));
  }
  let type = sniffImage(bytes);
  const originalType=type;
  if (!type) fail("invalid_file");
  if (!brand) {
    const { verifyEvidenceImage, normalizeEvidenceImage } = await import("./normalize-image.ts");
    await verifyEvidenceImage(bytes, type!);
    bytes=new Uint8Array(await normalizeEvidenceImage(bytes,MEDIA_LIMITS.evidence));
    type="image/webp";
  }
  if (ownerId) {
    const [usage] = await q.query<{ n: number; total: number }>(
      "select count(*)::int as n, coalesce(sum(bytes+original_bytes), 0)::int as total from media where owner_id = $1 and created_at > now() - interval '1 day'",
      [ownerId],
    );
    if ((usage?.n ?? 0) >= DAILY_UPLOADS || (usage?.total ?? 0) + bytes.length+(original?.length ?? 0) > DAILY_BYTES) fail("upload_limit");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const [row] = await q.query<{ id: string }>(
    "insert into media (owner_id, kind, content_type, bytes, sha256, data, original_data, original_sha256, original_bytes, original_content_type) values ($1, $2, $3, $4, $5, $6,$7,$8,$9,$10) returning id",
    [ownerId, kind, type, bytes.length, sha256, Buffer.from(bytes),original?Buffer.from(original):null,original?createHash("sha256").update(original).digest("hex"):null,original?.length ?? 0,original?originalType:null],
  );
  return row.id;
}

export const mediaUrl = (id: string | null | undefined) => (id ? `/api/media/${id}` : null);

/** Explicit operator conversion only; never called by GET or an automatic migration. */
export async function convertLegacyEvidence(db: Database, actor: { id: string; roles: string[] }, id: string, reason: string) {
  if (!hasSection(actor.roles, "disputes")) fail("forbidden");
  if (reason.trim().length < 5 || reason.length > 500) fail("invalid_input");
  return db.tx(async q => {
    const [row] = await q.query<{ data: Uint8Array; original_data: Uint8Array | null; sha256: string; content_type: string }>(
      "select data,original_data,sha256,content_type from media where id=$1 and kind='evidence' for update", [id]);
    if (!row) fail("not_found");
    if (row.original_data) return { status: "already_normalized" };
    const original = Buffer.from(row.data), hash = createHash("sha256").update(original).digest("hex"), type = sniffImage(original);
    let derivative: Uint8Array;
    try {
      if (!type || original.length > MEDIA_LIMITS.evidence || hash !== row.sha256) fail("invalid_file");
      const { verifyEvidenceImage, normalizeEvidenceImage } = await import("./normalize-image.ts");
      await verifyEvidenceImage(original, type!);
      derivative = await normalizeEvidenceImage(original, MEDIA_LIMITS.evidence);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      await audit(q, { actorId: actor.id, action: "media.legacy_conversion_refused", entity: "media", entityId: id, data: { reason, originalSha256: hash, code: error.code } });
      return { status: "invalid_legacy", code: error.code };
    }
    await q.query(`update media set original_data=$2,original_sha256=$3,original_bytes=$4,original_content_type=$5,
      data=$6,sha256=$7,bytes=$8,content_type='image/webp' where id=$1`,
      [id, original, hash, original.length, row.content_type, Buffer.from(derivative), createHash("sha256").update(derivative).digest("hex"), derivative.length]);
    await audit(q, { actorId: actor.id, action: "media.legacy_converted", entity: "media", entityId: id, data: { reason, originalSha256: hash } });
    return { status: "normalized" };
  });
}

/** Whether `viewerId` may see an evidence image: a participant of the disputed match or its staff. */
export async function canSeeEvidence(q: Queryable, mediaId: string, viewer: { id: string; roles: string[] } | null): Promise<boolean> {
  if (!viewer) return false;
  if (hasSection(viewer.roles, "disputes")) return true;
  const [row] = await q.query(
    `select 1 from disputes d join matches m on m.id = d.match_id join tournaments t on t.id = m.tournament_id
      where d.evidence_media_id = $1 and (
        exists (select 1 from roster_entries re where re.user_id = $2 and re.registration_id in (m.a_reg, m.b_reg))
        or exists (select 1 from org_members o where o.org_id = t.org_id and o.user_id = $2)
        or exists (select 1 from tournament_organizers c where c.tournament_id = t.id and c.user_id = $2))
      limit 1`,
    [mediaId, viewer.id],
  );
  return Boolean(row);
}
