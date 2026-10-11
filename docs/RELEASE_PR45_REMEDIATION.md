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
| Staff can approve their own playing roster | Own-roster submissions require evidence and remain pending; server rejects self-approval, and the organizer form includes evidence and review guidance | Participant/staff modes, missing proof, rejected self-approval with unchanged XP/audit, independent approval |
| Valid originals can exceed the display-size budget after normalization | Preserve the original and try bounded WebP display encodings within the existing size limit | Reproduced 537 KB JPEG expanding beyond the limit; normalized image fits, decodes at original dimensions, and original bytes remain unchanged |
| Edge instrumentation loads a Node-only module | Use built-in Web Crypto in the shared error reporter; reject Edge incompatibility diagnostics in CI even when the build exits successfully | Node hook and actual Next Edge VM regression, redaction, export and bounded collector timeout |
| Intermediate upgrades | Existing migrations 44–47 unchanged; populated 43/44/45/46 upgrade paths covered | Embedded database upgrade tests; hosted rehearsal remains separate |

Focused final regression suite: 31 passed, 0 failed or skipped; typecheck passed. Fresh dependency installation completed with 0 reported vulnerabilities. Full CI on the previous integration revision passed, including real PostgreSQL and browser acceptance. The final revision's complete quality gate and independent review are recorded on the pull request.

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
4. Final tournament rules and operational review SLA; playing staff now require independent approval of their own roster's results.
5. Other feature-specific gates in QA_REMEDIATION.md: email delivery, administrator/MFA, publisher ownership/live verification, payment readiness and voice/broadcast provider acceptance.

The independent review of the original PR45 candidate concluded that it must not be merged unchanged. This draft resolves the concrete issues listed above; it does not substitute for the outstanding production evidence.

## Preview identity clarification
The existing branch preview `8fRv6k4TTmS5ZcRsVz5JSEF8VuM7` was inspected in Vercel. It points to `8c12d38a130d00c7e1de34213d2aa02752be6c14`, the initial coordination-only claim, whose only change from published main is `docs/COORDINATION.md`. It is not the integrated release candidate and does not include candidate migrations 44–47. The GitHub bot's retained Ready comment must not be treated as deployment evidence for later commits. Database isolation remains required before deploying or exercising the release candidate.
