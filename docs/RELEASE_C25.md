# C-25 — Dedicated game-server lifecycle

Date: 3 October 2026. Release path: [PR #28](https://github.com/MAXIMUS-NPiO/maximus-vegas/pull/28), protected `main`, then the existing deployment to www.maximus.vegas. The pull request records the merged SHA, deployment result and subsequent public verification. Local acceptance does not establish publication by itself.

The server-rental page previously described a future service. It now connects independently reviewed nodes and game templates to reservations, commands, observed state, team access, private logs and retained local backups. This completes the dedicated-server software portion of WOS 004173 and technical overview sections 6–7, continuing C-24. Original requirements and remaining operating dependencies stay in `docs/FIVE_WORKS_IMPLEMENTATION.md`.

## Delivered behaviour

- Operators register real Linux nodes and pinned local game manifests. A different authorised reviewer approves each node and template. Only enabled nodes with fresh authenticated heartbeats, matching manifests and sufficient unreserved capacity appear in the catalogue.
- Adults reserve a free 30–240 minute session, immediately or up to 24 hours ahead. CPU, RAM, disk allowance and unique host ports are reserved transactionally. Each player has at most one unreleased reservation. Capacity stays held until the node confirms cleanup at the current command revision.
- Members start, stop, restart and release their session. The page distinguishes requested state from observed state and stale telemetry. Viewer and operator roles are revocable; sharing and final release remain owner-only for team participants. Private connection details, logs and up to three local backups belong to that session.
- Backups and restore require a confirmed stop. Restore checks the recorded digest and bounded archive contents, imports into a staging volume and persists the switch before deleting the previous volume. Replayed receipts do not repeat completed work. Release and expiry remove game data and backups.
- The unprivileged Linux agent polls outbound HTTPS with a node-scoped, hashed, revocable credential. Rootless containers use local digest-pinned images, fixed operator-approved argument vectors, resource limits and registered ports. The agent accepts no member-selected executable, image, shell command or path. Revision checks, a separate loss-of-contact watchdog, service shutdown hook and container lease timeout constrain stale execution.
- Account export excludes credentials. Erasure withdraws allocations and team access, clears private logs and anonymises operator details and template evidence. Late telemetry cannot restore erased logs. Existing membership payment and no-money gaming boundaries remain unchanged; server-rental billing is off.

Migration 34 is additive. The official lion and approved brand hierarchy are unchanged. New implementation provenance is recorded in `docs/IP_RECORD.md`; no new registration or novelty is asserted.

## Acceptance and corrections

| Check | Result |
|---|---|
| Full quality check with PostgreSQL enabled | Typecheck, all 280 tests and production build passed: zero failures and zero skips. Includes 266 standard cases and 14 real multi-connection PostgreSQL cases. |
| Allocation and control concurrency | Resource/port oversubscription, one reservation per player across nodes, key rotation, backup/release races and a deterministic cross-module audit regression passed. |
| Agent checks | 14 dedicated-server Python tests and the two existing streaming-agent tests passed. Container operations use an isolated adapter; no real game or installed Podman runtime was accepted here. |
| New browser acceptance | Seven complete scenarios passed through native forms and the real local agent HTTP endpoint: enrolment/review, allocation, team controls, backup/restore, scheduled starts, cleanup, credential rotation/revocation and guest sign-in. Twenty populated RU/EN screenshots at 390/1440 px had no overflow or unexpected browser errors. |
| Existing HTTP end-to-end | Passed, including tournament formats/repair, teams, quick match, membership, account export, staff/MFA, venue admission, permissions, switches and academy. |
| Existing browser smoke | Passed from account creation and onboarding through organiser/tournament, match, team/clan, finder/scouting and quick-match controls to notifications, password change, sign-in/out and account deletion. |
| Form compatibility | All 18 literal browser validation patterns compile under the modern `v` flag. Invalid hyphen classes on the template, membership-code and marketplace forms were corrected without changing accepted identifiers. |
| Responsive presentation | The mobile template-review port list no longer overflows. Full populated RU/EN verification is included in the browser evidence. |

Concurrent PostgreSQL testing found an existing statistics audit-chain race: a serializable snapshot could retain an older chain head while waiting for another writer. Snapshot source data is now read in a single SQL statement for a consistent dataset, while the later audit append sees the current committed chain under its existing lock. A regression test deliberately commits another audit record between these operations. Historical records are not rewritten. The agent watchdog also now allows the first validated startup contact without racing against the first newly started container, and the data-entry budget counts directories as well as files.

All destructive acceptance work used disposable localhost databases and a local production build. No production accounts, orders, reservations or messages were created as test fixtures. Temporary credentials, screenshots and reports remain ignored artifacts.

## Reproduction

Use Node 24, the pinned dependencies, Python 3.11+, PostgreSQL 16 and a compatible Chromium executable. Use separate disposable localhost databases named `c25_regression` and `c25_browser`.

```sh
npm ci
PG_TEST_URL=postgres://localhost/c25_regression RENTAL_PG_TEST_URL=postgres://localhost/c25_regression npm run check
python3 -m unittest discover -s server-agent -v
python3 -m unittest discover -s host-agent -p 'test_*.py'
RENTAL_PG_TEST_URL=postgres://localhost/c25_browser MFA_SECRET_KEY="$LOCAL_MFA_KEY" node --experimental-strip-types scripts/rentals-fixture.ts
```

Run the production build on `127.0.0.1:3100` against the same browser database with the same disposable MFA key, a disposable `ADMIN_BOOTSTRAP_TOKEN`, `MV_LOCAL=1`, `MV_INSECURE_COOKIES=1` and `MV_WEBHOOK_ALLOW_LOCAL=1`. Clear unrelated database environment aliases first. Never set local-only flags in production. Run these sequentially because the existing HTTP suite changes feature switches and maintenance state:

```sh
BASE=http://127.0.0.1:3100 CHROMIUM_PATH=/path/to/chromium node scripts/rentals-browser.mjs
BASE=http://127.0.0.1:3100 OWNER_CODE="$LOCAL_BOOTSTRAP_TOKEN" node scripts/e2e.mjs
BASE=http://127.0.0.1:3100 CHROMIUM_PATH=/path/to/chromium node scripts/browser-smoke.mjs
```

The new browser suite drives native forms for the member, operator and reviewer and communicates with the real local agent HTTP endpoint. Its container adapter is explicitly isolated and does not establish real runtime acceptance. The CI gate now provisions disposable PostgreSQL and runs all 280 cases without skips, plus the 14 dedicated-server agent cases.

## Remaining operating dependencies

An operating offer requires an actual authorised Linux node, licensed and compatible installed game image, independently reviewed resource budget, bounded storage setup, firewall policy and tested public game-port reachability. The repository supplies none of that infrastructure and did not provision paid services. Local backups do not protect against loss of the node. Per-lease data usage is monitored; only the separately configured bounded filesystem is the aggregate hard cap. Tenant-specific hard disk isolation requires additional per-volume quotas or separate nodes. See `server-agent/README.md` for setup and failure behaviour.

Interactive P2P streaming still needs actual hosts, relay capacity and game/GPU acceptance; Windows/macOS native streaming adapters are separate unfinished work. Physical Clubhouses and gifts need verified operators, equipment, stock and fulfilment. Publisher statistics need authorised source access. Blockchain inclusion needs a deployed commitment contract, configured RPC and a matching final receipt. These are not silently treated as complete by this software release.
