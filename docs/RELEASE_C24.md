# C-24 — Five-work product implementation

Date: 3 October 2026. Release path: [PR #27](https://github.com/MAXIMUS-NPiO/maximus-vegas/pull/27), protected `main`, then the existing deployment to www.maximus.vegas. The pull request records the merged SHA, deployment result and subsequent public verification. The evidence below describes acceptance of the implementation; it does not treat a local build as a production release.

The portal previously had several foundations described in the five supplied scientific works, but no complete journeys for recurring Pass missions, opt-in matching, clubhouse operations, playable P2P sessions or signed external statistics. This release connects those journeys to persisted data, server permissions, explicit consent, lifecycle controls and the existing portal navigation. The original requirements and unresolved external boundaries remain in `docs/FIVE_WORKS_IMPLEMENTATION.md`.

## Delivered behaviour

| Direction | User and operator behaviour |
|---|---|
| Pass — 004171 | Daily, weekly and 90-day seasonal missions use confirmed activity and a frozen game preference. Rewards are claimed once. Members can reserve and cancel gifts from verified venue inventory; operators pause inventory and collect against a holder's code. Collected stock stays consumed after account deletion. |
| Dating — 004170 | Adults opt in separately, choose gaming/friendship/dating preferences, discover members, mutually match and exchange private messages. Blocking or withdrawal closes contact. Reports, independent moderation/restoration and export/erasure are integrated. |
| Offline/online Clubhouse — 004174 | Verified venue operators manage hours, stations and free events. Members book stations or join an event/waitlist. Cancellation promotes the next eligible person. Linked QR admission is single-use; device-scoped offline scanning queues provisional arrivals and reconciles with current server authority. |
| P2P — 004173 | Independently reviewed hosts publish live availability. A host and player receive an exclusive, expiring session with scoped signalling, video, input, feedback and capped non-cash contribution credits. The browser Arena runs on the host and streams to the player. Native host keys can be rotated/revoked. An isolated Linux adapter captures a configured game and accepts bounded input. |
| Statistics/Web3 — 004172 | Independently approved sources prove a player's linked handle and submit signed, replay-protected data. Organisers review records. A member downloads a private period snapshot with portable Merkle proofs and verifies it locally. Sharing exposes a commitment rather than private records and can be withdrawn. An optional contract adapter checks code, receipt, chain, commitment and finality. |

Migrations 29–33 are additive. Existing account, tournament, membership billing and legal-text behaviour is preserved. The official lion is unchanged. The new components and attribution are recorded in `docs/IP_RECORD.md`; this release makes no new external IP-registration claim.

## Acceptance actually run

| Check | Result |
|---|---|
| `npm run check` | Typecheck, 266-test suite and production build passed. In the standard configuration: 256 passed, 10 PostgreSQL-only skipped, zero failures. |
| PostgreSQL 16 multi-connection checks | All 10 separately passed: nine existing concurrency tests and the new five-work test. The latter races station booking, event capacity, gift stock, mission claims, reciprocal likes/message delivery, host allocation and the daily snapshot limit; the audit chain remains valid. |
| New browser acceptance | Eight complete scenarios passed through native forms and real API/browser behaviour; no unexpected console/page errors or HTTP 5xx. |
| Real P2P browser path | Separate host and client contexts received more than eight decoded video frames at 960 px and keyboard input visibly moved the host-rendered paddle. This proves the local browser transport, not public relay or GPU performance. |
| Offline scanner | Network was actually disconnected, an arrival queued provisionally, then reconciled as confirmed after reconnecting. Only expected disconnected-network errors within that step were excluded from unexpected errors and retained in the report. |
| Statistics | Real signed HTTP challenge and match intake, review, snapshot download, browser-local file verification and sharing/withdrawal passed. Pinned contract compilation and code/receipt matching passed. No transaction was broadcast. |
| Responsive pages | Eight populated pages in RU/EN at 390/1440 px: 32 screenshots, no horizontal overflow. Russian mobile statistics layout was also visually inspected. |
| Existing full HTTP end-to-end | Passed, including tournament formats, repair, teams, quick match, membership, account data, staff/MFA, venue admission, permissions, switches and academy. |
| Existing browser smoke | Passed from account creation through game/community workflows, settings, sign-in/out and account deletion. |
| Native adapter | Two Python protocol/configuration tests and script compilation passed. Actual installed-game, GPU and audio performance remain hardware acceptance work. |

Tests used isolated localhost PostgreSQL and a local production build. No production accounts or database were used as fixtures. Locally generated credentials, reports and screenshots remain ignored artifacts; they are not committed.

## Reproduction

Use Node 24, the pinned dependencies and a Chromium executable compatible with the repository's browser tools. Create separate disposable localhost PostgreSQL databases for concurrency and browser fixtures. `PG_TEST_URL` must be set explicitly; the browser-fixture database name must begin with `c24_`.

```sh
npm ci
npm run check
PG_TEST_URL=postgres://localhost/c24_concurrency node --experimental-strip-types --test tests/concurrency.test.ts tests/five-works-postgres.test.ts
python3 -m unittest discover -s host-agent -p 'test_*.py'
PG_TEST_URL=postgres://localhost/c24_browser node --experimental-strip-types scripts/five-works-fixture.ts
```

Run the production build locally against that same browser-fixture database with `MV_LOCAL=1`, `MV_INSECURE_COOKIES=1`, `MV_WEBHOOK_ALLOW_LOCAL=1` and a disposable local `ADMIN_BOOTSTRAP_TOKEN`. Clear unrelated database environment aliases first. Start on `127.0.0.1:3100`; never set these local flags on production. In another shell:

```sh
BASE=http://127.0.0.1:3100 CHROMIUM_PATH=/path/to/chromium node scripts/five-works-browser.mjs
BASE=http://127.0.0.1:3100 OWNER_CODE="$LOCAL_BOOTSTRAP_TOKEN" node scripts/e2e.mjs
BASE=http://127.0.0.1:3100 CHROMIUM_PATH=/path/to/chromium node scripts/browser-smoke.mjs
```

`LOCAL_BOOTSTRAP_TOKEN` above must match the disposable server bootstrap value. Fixture generation and the new browser script refuse non-local targets. The existing end-to-end suite must likewise never target production.

## Operating dependencies and remaining source scope

- Physical Clubhouses, coaching and gifts require verified operators, addresses, equipment, staff, actual stock and real fulfilment. No operating venue is invented by a test fixture.
- Public P2P requires real reviewed hosts and configured, capacity-tested STUN/TURN infrastructure. The portal supports temporary TURN credentials; see `host-agent/README.md`. Linux installed-game/GPU/publisher/anti-cheat compatibility requires acceptance on the host. The native adapter refuses relay-only mode because its transport cannot enforce that policy. Windows/macOS adapters and server-rental operations remain separate extensions.
- External statistical accuracy requires a real authorised source, its signing key and proof of player-handle ownership. The repository supplies a signed-source protocol and SDK; it does not claim an active publisher integration.
- Chain publication requires the chosen chain, deployment of the pinned commitment contract, a configured RPC endpoint and a sufficiently confirmed matching receipt. The portal holds no spending key and does not deploy or pay for transactions. A local Merkle root alone is not blockchain inclusion.
- Opt-in matching requires real members and operating moderation. Local fixtures are not audience or usage evidence.
- Paid coin packages, transferable/withdrawable value, paid game entry and other financial gaming provisions from the source are retained in the requirements record but remain disabled under the approved product boundary. Existing membership billing does not turn progression coins into money.

The release completes the implemented portal journeys and their local acceptance. It is a basis for a controlled pilot, not evidence that all five concepts have reached a commercial operating launch.
