import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { openDatabase, type Database } from "../src/server/db.ts";
import { signUp, sessionUser, deleteAccount, type SessionUser } from "../src/server/auth.ts";
import { createOrg } from "../src/server/teams.ts";
import { grantXp, moveCoins } from "../src/server/progression.ts";
import { DomainError } from "../src/server/errors.ts";
import { createStatsSource, reviewStatsSource, linkStatsSource, statsOverview, ingestStatistics, reviewObservation, createSnapshot, snapshotProof, shareSnapshot, rotateStatsKey } from "../src/server/statistics.ts";
import { merkleTree, verifyMerkle, statsEnvelope } from "../src/lib/stats-proof.ts";
import { verifyProofFile } from "../src/lib/stats-browser-proof.ts";
import { ANCHOR_EVENT, ANCHOR_RUNTIME_SHA256, anchorCalldata, datasetFor, matchesAnchor } from "../src/lib/stats-anchor.ts";

let db: Database, seq = 0;
const password = "correct test secret phrase";
async function account() { const name = `stats${++seq}`; const s = await signUp(db, { email: `${name}@example.com`, username: name, displayName: name, password, adult: "on", terms: "on" }); return (await sessionUser(db, s.token))!; }
const reject = (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof DomainError && e.code === code);
test.before(async () => { db = await openDatabase({ embedded: true, dataDir: "memory://" }); });
test.after(async () => { await db.close(); });

test("Canonical Merkle proofs handle odd leaves and reject edited records, order and siblings", async () => {
  const records = [{ b: 2, a: "Данные" }, { n: 3 }, { tail: true }], tree = merkleTree(records);
  records.forEach((r, i) => assert.equal(verifyMerkle(r, tree.proofs[i], tree.root), true));
  assert.equal(verifyMerkle({ a: "Данные", b: 2 }, tree.proofs[0], tree.root), true);
  assert.equal(verifyMerkle({ b: 3, a: "Данные" }, tree.proofs[0], tree.root), false);
  assert.notEqual(merkleTree([...records].reverse()).root, tree.root);
  const browser = await verifyProofFile({ version: "MV-STATS-1", id: randomUUID(), root: tree.root, count: records.length, records }); assert.equal(browser.integrity, true);
  const single = await verifyProofFile({ version: "MV-STATS-1", id: randomUUID(), root: tree.root, count: 3, record: records[2], proof: tree.proofs[2] }); assert.equal(single.integrity, true);
});

test("Signed intake requires independent source approval, player challenge, scoped game and an intact signature", async () => {
  const owner = await account(), player = await account(), outsider = await account(), staff = { ...(await account()), roles: ["infrastructure"] } as SessionUser;
  const org = await createOrg(db, owner, { name: "Statistics organiser", description: "" });
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const source = await createStatsSource(db, owner, org.id, { name: "Approved test source", evidence: "https://example.org/permission", publicKey }, ["cs2"]);
  await reject(reviewStatsSource(db, { ...owner, roles: ["admin"] }, source, "approved", "Trying to approve own source"), "cannot_modify_self");
  await reject(linkStatsSource(db, player, source, "cs2", "test-handle"), "offer_unavailable");
  await reviewStatsSource(db, staff, source, "approved", "Operator and permissions verified in isolated fixture");
  await linkStatsSource(db, player, source, "cs2", "test-handle");
  const challenge = (await statsOverview(db, player.id)).links[0].challenge;
  const signed = (data: unknown, nonce = randomUUID()) => {
    const body = JSON.stringify(data), timestamp = String(Math.floor(Date.now() / 1000));
    return { body, headers: { source, nonce, timestamp, signature: sign(null, Buffer.from(statsEnvelope(source, nonce, timestamp, body)), keys.privateKey).toString("base64") } };
  };
  const record = { kind: "match", game: "cs2", handle: "test-handle", matchRef: "match-001", playedAt: new Date().toISOString(), metrics: { kills: 12, deaths: 7 } };
  let request = signed(record); await reject(ingestStatistics(db, request.headers, request.body), "consent_required");
  request = signed({ kind: "link", game: "cs2", handle: "test-handle", challenge });
  await ingestStatistics(db, request.headers, request.body);
  request = signed(record); await reject(ingestStatistics(db, request.headers, request.body.replace('"kills":12', '"kills":99')), "token_invalid");
  const received = await ingestStatistics(db, request.headers, request.body); assert.ok(received.id);
  assert.equal((await ingestStatistics(db, request.headers, request.body)).replay, true);
  const changed = signed({ ...record, metrics: { kills: 13 } }, request.headers.nonce); await reject(ingestStatistics(db, changed.headers, changed.body), "token_invalid");
  const otherGame = signed({ ...record, game: "dota2" }); await reject(ingestStatistics(db, otherGame.headers, otherGame.body), "invalid_game");
  await reject(reviewObservation(db, outsider, received.id!, "confirmed", "Unauthorised record review"), "forbidden");
  await reviewObservation(db, owner, received.id!, "confirmed", "Signed evidence and match reviewed");
  await grantXp(db, [player.id], 20, "match_played", "cs2", "confirmed", "stats-proof-xp");
  await moveCoins(db, player.id, 15, "objective", "fixture", "stats-proof-coins");
  const portalKeys = generateKeyPairSync("ed25519"), previous = process.env.MV_STATS_SIGNING_KEY;
  process.env.MV_STATS_SIGNING_KEY = portalKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let snapshot: string;
  try { snapshot = await createSnapshot(db, player); } finally { if (previous === undefined) delete process.env.MV_STATS_SIGNING_KEY; else process.env.MV_STATS_SIGNING_KEY = previous; }
  assert.equal(await snapshotProof(db, snapshot!, outsider.id), null);
  const own = (await snapshotProof(db, snapshot!, player.id))!;
  assert.ok("records" in own && own.records.some((r: unknown) => (r as { type: string }).type === "source_statistic"));
  const verified = await verifyProofFile({ ...own, signature: own.signature ?? undefined, publicKey: own.publicKey ?? undefined });
  assert.equal(verified.integrity, true); assert.equal(verified.signature, true);
  await shareSnapshot(db, player, snapshot!, true);
  const shared = (await snapshotProof(db, snapshot!, outsider.id))!; assert.equal("records" in shared, false); assert.equal("user_id" in shared, false); assert.equal(shared.anchor, null);
  const nextKeys = generateKeyPairSync("ed25519"); await rotateStatsKey(db, owner, source, nextKeys.publicKey.export({ type: "spki", format: "pem" }).toString());
  assert.equal((await statsOverview(db, player.id)).links[0].status, "revoked");
  await reject(ingestStatistics(db, request.headers, request.body), "token_invalid");
  await deleteAccount(db, player, password); assert.equal(await snapshotProof(db, snapshot!, outsider.id), null);
  assert.equal((await db.query("select 1 from stats_observations where user_id=$1", [player.id])).length, 0);
});

test("Anchor verification checks contract, data, transaction success and finality; compilation matches verifier runtime", () => {
  const id = randomUUID(), root = "ab".repeat(32), contract = "0x" + "12".repeat(20), transaction = "0x" + "34".repeat(32), blockHash = "0x" + "56".repeat(32);
  const receipt = { to: contract, transactionHash: transaction, blockNumber: "0x64", blockHash, status: "0x1", logs: [{ address: contract, topics: [ANCHOR_EVENT, "0x" + datasetFor(id)], data: "0x" + root + "3".padStart(64, "0"), blockHash }] };
  assert.equal(matchesAnchor(receipt, { id, root, count: 3, contract, transaction }, 111n), true);
  assert.equal(matchesAnchor(receipt, { id, root, count: 3, contract, transaction }, 110n), false);
  assert.equal(matchesAnchor({ ...receipt, status: "0x0" }, { id, root, count: 3, contract, transaction }, 111n), false);
  assert.equal(matchesAnchor(receipt, { id, root: "cd".repeat(32), count: 3, contract, transaction }, 111n), false);
  assert.equal(anchorCalldata(id, root, 3).slice(0, 10), "0x5d610ec5");
  const require = createRequire(import.meta.url), solc = require("solc");
  const output = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "StatisticsAnchor.sol": { content: readFileSync(new URL("../contracts/StatisticsAnchor.sol", import.meta.url), "utf8") } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["evm.deployedBytecode.object"] } } } })));
  assert.equal((output.errors ?? []).some((e: { severity: string }) => e.severity === "error"), false);
  const runtime = output.contracts["StatisticsAnchor.sol"].StatisticsAnchor.evm.deployedBytecode.object;
  assert.equal(createHash("sha256").update(Buffer.from(runtime, "hex")).digest("hex"), ANCHOR_RUNTIME_SHA256);
});
