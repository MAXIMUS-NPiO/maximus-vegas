# C-29 — Native broadcasts and POV recordings

## Source and scope

Owner request, 4 October 2026: start streaming directly on MAXIMUS VEGAS; offer the service for payment through a technical partner; let each customer choose how long to retain their recording; begin implementation in the canonical repository. This task adds a service within the MAXIMUS ecosystem. It does not appoint a partner or set commercial rates on the owner's behalf.

| ID | Requirement | Implementation / acceptance |
| --- | --- | --- |
| R1 | Start a stream on the site | Authenticated desktop browser studio; screen/window/tab and optional microphone, explicit capture consent; direct viewer page |
| R2 | Record POV | Recording-only and live-with-recording modes; private MP4 output; owner-only archive |
| R3 | Paid optional service | Server-calculated prepaid duration, audience allowance and storage; hosted checkout; authoritative payment reconciliation; no browser payment assertions |
| R4 | User chooses storage | Any whole number of days within configured supported range, quoted before payment; access expires at the displayed time; retryable physical erasure |
| R5 | Partnership / earn revenue | Provider adapter and configurable approved tariff; provider account, agreement, rates and merchant approval are external activation requirements |
| R6 | Preserve existing portal | Isolated new schema and routes; existing external streams, memberships, legal copy and brand unchanged |
| R7 | Actually start coding here | Branch core/C-29-native-streaming, PR #32; verification and external activation evidence recorded below |

LiveKit and private S3 storage are technical integration choices, not a claim of a partnership. Browser screen capture is a desktop flow. Capturing another application's screen on iOS requires a separate native extension and is outside this web delivery. User-selected retention does not remove the operator's duties to implement deletion, access controls and service limits.

## State

Code implemented; external activation remains separate. Operational settings and exact boundaries are in `docs/BROADCASTS.md`. Local typecheck and production build passed. The initial complete check passed 297 tests with 17 PostgreSQL-only checks skipped; after adding the dedicated native-service concurrency case, CI also verifies that case against PostgreSQL. Seven native-service domain scenarios pass locally. Local browser execution is blocked by the execution environment's socket restrictions, so the browser acceptance harness runs in CI and saves its screenshots/report. No production provider test, charge, tariff approval or operational launch is claimed. Required CI must pass on the released head.

MIPA internal provenance: the original implementation is recorded in `docs/IP_RECORD.md`; no new external registration is asserted.
