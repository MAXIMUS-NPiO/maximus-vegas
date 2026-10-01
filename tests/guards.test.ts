// Repository guards shared by every lane: migration order, the official lion, authorship lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrations } from "../src/server/schema.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const LION_SHA256 = "24248c7e209ebbdb689407eaa02fb7ac2a844bf7d057e1e4c85d5d6a2074c789";

test("migrations are numbered 1..n without gaps or duplicate names", () => {
  assert.deepEqual(
    migrations.map((m) => m.id),
    migrations.map((_, i) => i + 1),
  );
  assert.equal(new Set(migrations.map((m) => m.name)).size, migrations.length);
});

test("the official lion is byte-for-byte unchanged", () => {
  const bytes = readFileSync(new URL("../public/brand/maximus-lion.jpg", import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), LION_SHA256);
});

test("no co-author or generated-with lines in tracked files", () => {
  let listed: string;
  try {
    listed = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  } catch {
    return; // not a git checkout (e.g. an exported archive): nothing to compare
  }
  const binary = /\.(png|jpe?g|webp|gif|ico|avif|woff2?|ttf|otf|pdf|mp3|wav|ogg|mp4|webm|zip)$/i;
  // Assembled from parts so this file does not match itself.
  const pattern = new RegExp(
    [
      ["co", "-authored", "-by", ":"].join(""),
      ["generated (with|by) \\[?(cla", "ude|chat", "gpt|cod", "ex|copi", "lot)"].join(""),
      ["noreply@", "anthropic\\.com"].join(""),
      ["codex@", "openai\\.com"].join(""),
    ].join("|"),
    "i",
  );
  const hits = listed
    .split("\0")
    .filter((f) => f && !binary.test(f) && f !== "package-lock.json")
    .filter((f) => pattern.test(readFileSync(`${root}${f}`, "utf8")));
  assert.deepEqual(hits, []);
});

test("pages with forms never use the no-referrer policy: browsers then send Origin: null and the action route refuses the form", () => {
  let listed: string;
  try {
    listed = execFileSync("git", ["ls-files", "-z", "src/app"], { cwd: root, encoding: "utf8" });
  } catch {
    return; // not a git checkout
  }
  const offenders = listed
    .split("\0")
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .filter((f) => /referrer:\s*["']no-referrer["']/.test(readFileSync(`${root}${f}`, "utf8")));
  assert.deepEqual(offenders, []);
});
