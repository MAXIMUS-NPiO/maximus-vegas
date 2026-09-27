/**
 * Small image uploads stored in PostgreSQL (no external object storage is connected). Only PNG, JPEG and
 * WebP are accepted, identified by their file signature rather than the browser-supplied type. Evidence
 * images are visible only to the match's participants and its staff; logos and banners are public.
 */
import { createHash } from "node:crypto";
import type { Queryable } from "./db.ts";
import { fail } from "./errors.ts";

export type MediaKind = "team_logo" | "team_banner" | "tournament_banner" | "evidence" | "sponsor_logo";

export const MEDIA_LIMITS: Record<MediaKind, number> = {
  team_logo: 256 * 1024,
  team_banner: 1024 * 1024,
  tournament_banner: 1024 * 1024,
  evidence: 1536 * 1024,
  sponsor_logo: 256 * 1024,
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
  if (file.size > MEDIA_LIMITS[kind]) fail("file_too_large");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImage(bytes);
  if (!type) fail("invalid_file");
  if (ownerId) {
    const [usage] = await q.query<{ n: number; total: number }>(
      "select count(*)::int as n, coalesce(sum(bytes), 0)::int as total from media where owner_id = $1 and created_at > now() - interval '1 day'",
      [ownerId],
    );
    if ((usage?.n ?? 0) >= DAILY_UPLOADS || (usage?.total ?? 0) + bytes.length > DAILY_BYTES) fail("upload_limit");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const [row] = await q.query<{ id: string }>(
    "insert into media (owner_id, kind, content_type, bytes, sha256, data) values ($1, $2, $3, $4, $5, $6) returning id",
    [ownerId, kind, type, bytes.length, sha256, Buffer.from(bytes)],
  );
  return row.id;
}

export const mediaUrl = (id: string | null | undefined) => (id ? `/api/media/${id}` : null);

/** Whether `viewerId` may see an evidence image: a participant of the disputed match or its staff. */
export async function canSeeEvidence(q: Queryable, mediaId: string, viewer: { id: string; roles: string[] } | null): Promise<boolean> {
  if (!viewer) return false;
  if (viewer.roles.includes("admin") || viewer.roles.includes("referee") || viewer.roles.includes("support")) return true;
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
