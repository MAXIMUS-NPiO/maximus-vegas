# PR45 integration and review remediation — 11 October 2026

Status: draft candidate, not a production release. PR #49 preserves PR45's existing branch and integrates its candidate with current main, including the published dependency/clan fixes and MAXIMUS Rewards information.

## Requirement coverage
| Finding | Implemented change | Verification |
|---|---|---|
| Historical standings can change after a scoring update | Completed and archived public pages, partner responses and widgets use saved places; missing historical metrics are not invented | Historical best-N fixture, ties, gaps, public/widget rendering and unchanged settlement records |
| Organizer cannot correct a rejected result after the player deadline | Specific entry, expected revision and required reason; authorized organizer form; stale changes rejected | Deadline/rejection/correction/independent approval lifecycle and rendered RU/EN forms |
| Insecure new evidence URLs | New and replacement links require HTTPS without embedded credentials; unchanged historical evidence and identical retries remain readable and idempotent | Participant/organizer rejection tests and historical URL preservation |
| Pending reviews disappear behind 500 recent rows | Separate oldest-first pending query, bounded batches with remaining count, plus paginated complete history | 1,101-row fixture with 501 old pending entries; every history row reachable and queue drained |
| Correction provenance and review context | Latest actor/source stored; prior snapshot, reason and stats retained and displayed to reviewers | Correction provenance/history regression |
| Legacy blank references have unusable review forms | Approval explains the missing match ID; rejection requires a meaningful reason and allows subsequent correction | Typecheck and review-form inspection |
| Intermediate upgrades | Existing migrations 44–47 unchanged; populated 43/44/45/46 upgrade paths covered | Embedded database upgrade tests; hosted rehearsal remains separate |

Local focused correction/queue tests: 5 passed, 0 failed or skipped. Fresh dependency installation completed with 0 reported vulnerabilities. Full integrated quality checks and exact-head independent review are recorded on the pull request when complete.

## Boundaries
- No production database, payment configuration, secret or external provider setting changed.
- Existing financial features stay disabled; tournaments remain free, with no cash prizes; skins remain TEST MODE.
- The official lion and published rewards page are unchanged.
- Automatic deployment is disabled only for this draft branch and the original PR45 branch until preview database isolation is verified. Main deployment is not disabled.
- Finished partner leaderboard responses use the existing placements response shape; consumers must support it. No historical points/KDA snapshot is fabricated.

## Remaining release conditions
1. Full current-head quality gate, real PostgreSQL concurrency and browser acceptance.
2. Actual hosted certificate/hostname verification and isolated failure tests for the strict TLS path.
3. A recent recovery point, isolated restore drill and rehearsal of migrations 44–47; production data counts and rollback limitations recorded. The additive nonblank-reference trigger can reject blank inserts from rolled-back code.
4. Explicit tournament policy for staff reviewing their own playing roster, review SLA and final rules. Existing policy is not silently replaced by this remediation.
5. Measure large photographic/screenshot evidence derivatives: the current lossless WebP output may exceed the upload-size budget despite a valid original.
6. Other feature-specific gates in QA_REMEDIATION.md: email delivery, administrator/MFA, publisher ownership/live verification, payment readiness and voice/broadcast provider acceptance.

The independent review of the original PR45 candidate concluded that it must not be merged unchanged. This draft resolves the concrete issues listed above; it does not substitute for the outstanding production evidence.
