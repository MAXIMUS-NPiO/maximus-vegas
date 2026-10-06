import sharp from "sharp";
import { fail } from "./errors.ts";

/** Logos retain their entire geometry, centred on a transparent square. */
export async function normalizeBrandImage(input: Uint8Array, logo: boolean, limit: number) {
  if (input.length > 20 * 1024 * 1024) fail("file_too_large");
  try {
    for (const size of logo ? [512,384,256] : [1600,1200,800]) {
      const bytes = await sharp(input, {limitInputPixels: 80_000_000, animated: false})
        .rotate()
        .resize({width:size,height:size,fit:logo?"contain":"inside",background:{r:0,g:0,b:0,alpha:0},withoutEnlargement:!logo})
        .webp({quality:85})
        .toBuffer();
      if (bytes.length<=limit) return new Uint8Array(bytes);
    }
  } catch { fail("invalid_file"); }
  return fail("file_too_large");
}

/**
 * Evidence keeps its original bytes, so its digest still identifies what the participant submitted. It is
 * accepted only when it decodes completely, within a pixel limit, as the format its signature claims.
 */
export async function verifyEvidenceImage(input: Uint8Array, type: "image/png" | "image/jpeg" | "image/webp") {
  const expected = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" }[type];
  let ok = false;
  try {
    const image = sharp(input, { limitInputPixels: 50_000_000, animated: false, failOn: "error" });
    const meta = await image.metadata();
    if (meta.format === expected && (meta.width ?? 0) > 0 && (meta.height ?? 0) > 0) {
      await image.stats();
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok) fail("invalid_file");
}
