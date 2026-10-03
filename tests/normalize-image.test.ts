import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { randomFillSync } from "node:crypto";
import { normalizeBrandImage } from "../src/server/normalize-image.ts";
test("large logo is compressed under the storage limit and fits a transparent square without cropping", async()=>{
 const source=await sharp(randomFillSync(Buffer.alloc(1800*1200*3)),{raw:{width:1800,height:1200,channels:3}}).png().toBuffer();
 assert.ok(source.length>4.5*1024*1024);
 const output=await normalizeBrandImage(source,true,256*1024);
 assert.ok(output.length<=256*1024);
 const meta=await sharp(output).metadata();
 assert.equal(meta.width,512);assert.equal(meta.height,512);assert.equal(meta.format,"webp");assert.ok(meta.hasAlpha);
 const {data,info}=await sharp(output).raw().toBuffer({resolveWithObject:true});
 assert.equal(data[3],0);assert.ok(data[((256*info.width+256)*info.channels)+3]>0);
 await assert.rejects(normalizeBrandImage(new TextEncoder().encode("not an image"),true,256*1024));
});
