import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { normalizeEvidenceImage, verifyEvidenceImage } from "../src/server/normalize-image.ts";

test("a valid compressed JPEG gets a bounded display copy without changing its original", async () => {
  const width=1920,height=1080,raw=Buffer.alloc(width*height*3);let state=12345;
  for(let i=0;i<raw.length;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;raw[i]=state>>>24;}
  const original=await sharp(raw,{raw:{width,height,channels:3}}).jpeg({quality:30}).toBuffer();
  const before=Buffer.from(original),limit=1572864;
  assert.ok(original.length<limit);
  await verifyEvidenceImage(original,"image/jpeg");
  const lossless=await sharp(original).webp({lossless:true}).toBuffer();
  assert.ok(lossless.length>limit,"fixture reproduces the previous size rejection");
  const result=await normalizeEvidenceImage(original,limit);
  assert.ok(result.length<=limit);
  const metadata=await sharp(result).metadata();
  assert.equal(metadata.format,"webp");assert.equal(metadata.width,width);assert.equal(metadata.height,height);
  await sharp(result).stats();
  assert.deepEqual(original,before);
});
