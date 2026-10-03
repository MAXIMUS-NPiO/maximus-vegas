# MV-STATS-1

WOS 004172 implementation: scoped, signed source statistics; explicit player linking; organiser review; verifiable private record snapshots; optional externally published integrity commitments. This protocol does not implement purchasable coins, entry fees, betting, custody, payouts or investment products.

## Source onboarding and consent

An organisation owner submits its name, permitted games, evidence of operator/data rights and an Ed25519 **public** key through `/statistics/sources`. The matching private key stays at the data source. Independent infrastructure staff verify the operator, the scope, publisher permissions where required and control of the key before approving intake. A source cannot approve itself. Replacing a key returns the source to review and revokes player links; previously signed records retain the public key used when received.

Generate a key locally with a cryptographic tool; for example `openssl genpkey -algorithm ED25519 -out private.pem` and `openssl pkey -in private.pem -pubout -out public.pem`. Restrict access to the private file; never put it in the repository, portal forms or support messages.

A player chooses an approved source, game and handle. The portal issues a random, one-day linking challenge. The source authenticates that player with the game/publisher's approved login flow, confirms ownership of the handle, then submits the signed linking record below. Receiving a challenge alone is not proof of ownership of a game account; the source is responsible for the external authentication step. No publisher access is inferred or provisioned by this protocol.

```json
{"kind":"link","game":"cs2","handle":"player-handle","challenge":"ONE_TIME_PORTAL_CHALLENGE"}
```

Only a verified, non-revoked link accepts match records:

```json
{"kind":"match","game":"cs2","handle":"player-handle","matchRef":"provider-match-123","playedAt":"2026-10-03T12:00:00Z","metrics":{"kills":12,"assists":4,"deaths":7,"durationSeconds":1800}}
```

Allowed metrics: kills, assists, deaths, headshots, damage, placement, score, durationSeconds. Values must be finite nonnegative numbers up to 1e9. Source scope, active player consent, signature, timestamp and unique match reference are checked before storage. External records remain pending until an organisation manager other than the player reviews them. They do not automatically alter tournament results, ratings, XP or prize eligibility.

## Signature and delivery

POST the exact UTF-8 JSON bytes to `/api/statistics/intake`, at most 20,000 bytes. Headers:

- `MV-Stats-Source`: source UUID
- `MV-Stats-Nonce`: fresh request UUID
- `MV-Stats-Timestamp`: Unix seconds, within five minutes
- `MV-Stats-Signature`: base64 Ed25519 signature of the envelope

The signed bytes are `MV-STATS-1\nSOURCE\nNONCE\nTIMESTAMP\nBODY`, with real newline characters between envelope fields. `scripts/stats-source.mjs` prepares a signed request without sending; `--send` explicitly submits it. Reuse the exact nonce/body for a retry within the timestamp window. A replay returns the prior record, and reuse of a nonce with another body fails. A changed payload for an existing player/game/match reference fails instead of silently rewriting history. Intake is bounded to 120 accepted deliveries per source per minute.

## Snapshot and verification

Snapshots contain reviewed source records with their signatures, XP entries, the user's internal coin ledger and the user's paid-invoice records for a selected UTC period. Invoice status is a portal accounting record; the count of successful live provider attempts is stated separately. Test-mode attempts are never represented as real settlement. No new payment, banking verification or real-money game mechanism is introduced.

Canonical JSON recursively sorts object keys lexicographically, retains array order and serialises primitives with JSON semantics. A leaf is SHA-256 of `0x00 || canonical(record)`. A parent is SHA-256 of `0x01 || leftHash || rightHash`; an odd last node is duplicated. The optional portal signature covers canonical `{version,id,root,count}` with Ed25519, configured by `MV_STATS_SIGNING_KEY`. Missing configuration produces an unsigned commitment, explicitly labelled.

The authenticated owner downloads complete records from `/api/statistics/proofs/UUID`. `?record=N` returns one record with a Merkle inclusion path. A public link exposes only root, count, signature, key and verified anchor metadata, not the records. Revoking the public link removes public access; it cannot remove a commitment already published independently on a blockchain. Account deletion erases portal links, source records and snapshot contents. Public commitments prove integrity, not the truth of a game event or ownership of an IP right.

The browser verifies files locally without uploading them. A matching included key proves a signature mathematically; the verifier must establish trust in that key independently. The command-line verifier can also prepare one-record proofs and unsigned anchor calldata. No script broadcasts a blockchain transaction.

## Optional blockchain commitment

`contracts/StatisticsAnchor.sol` accepts no funds or tokens. Its owner records a nonempty dataset/root/count exactly once; later overwrites fail. Ownership transfer requires proposal and acceptance. Dataset is SHA-256 of `MV-STATS-1:SNAPSHOT_UUID`. Merkle hashing is identical to the off-chain format. Compile using `node scripts/compile-statistics-contract.mjs --write`; compiler version is pinned and the EVM target is Paris.

Deployment requires an approved network, owner wallet and a separately approved transaction budget. No such deployment is asserted by the repository. When a reviewed contract is deployed, configure `MV_ANCHOR_RPC_URL` (HTTPS), `MV_ANCHOR_CONTRACT`, and decimal `MV_ANCHOR_CHAIN_ID`. The read-only verifier compares the deployed runtime hash to the compiled contract, checks chain, successful receipt, event dataset/root/count, canonical block hash and at least 12 confirmations. Only then does the portal label the snapshot anchored. The shared secret environment never contains a wallet spending key. Confirmation is as of the verification time and depends on the configured RPC and chain; it is not a guarantee against future reorganisation.

Independent source/financial access, publisher approvals, hardware supply, signed service contracts and actual commercial operations remain operational dependencies. Their absence is visible in the portal; example data and private fixtures never stand in for them.
