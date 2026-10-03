# C-24 five-work implementation state

Owner instruction: implement all five directions and continue through verification and publication. Work remains on `core/C-24-five-works`, draft PR #27. Nothing in this document claims that branch code is already production.

## Completed in the branch

- WOS 004171: UTC daily/weekly/90-day seasonal assignments; game preferences frozen per assignment; confirmed activity progress; atomic, replay-safe reward claims; season history; verified-venue gift stock, reservation and collection-code handover.
- WOS 004170: separate 18+ opt-in profile and consent; gaming/friendship/dating intent; discovery filters; reciprocal matching; participant-only paginated messages; delivery idempotency; blocking, withdrawal, report excerpts, moderation suspension, account export/erasure.
- WOS 004174: clubhouse opening hours, station inventory, conflict-checked reservations, free events and capacity, waiting-list promotion, linked single-entry passes, operator workspace; device-scoped offline manifests and queued provisional arrivals with server reconciliation, revocation and replay checks.
- WOS 004173: reviewed host registry, live availability, exclusive allocation and bounded leases, participant-only signalling, temporary TURN credentials, browser video and input, a host-rendered MAXIMUS Arena, explicit screen sharing, bounded confirmed contribution credits, scoped/revocable native host keys. Linux adapter provides a dedicated Xvfb display, sandboxed allowlisted game execution, video/audio capture and bounded input. Real GPU/publisher compatibility and public relay connectivity still need actual infrastructure acceptance.

- WOS 004172: Ed25519 source registration with independent approval, player-handle challenge/consent, exact-byte signed intake with replay protection, organiser review, private period snapshots, local Merkle verification and optional portal signatures. A compiled nonpayable Solidity anchor and read-only receipt/code/finality verifier are provided; chain deployment and regulated financial operations remain gated.
- Cancellation and inventory pause controls, moderation restoration, staff scanning, navigation, fractional metering and session termination on key revocation are implemented.

## Remaining work before release
- Review all new state transitions, permission checks and privacy paths; complete operator cancellation/restoration controls, navigation and status descriptions.
- Run typecheck, complete regression tests, build, browser flow and mobile verification. Existing production accounts and the production database must not be used as test fixtures.
- Review against fresh main, satisfy protected `check`, merge only the verified head, verify deployment and public routes/buttons.
- Update requirements traceability, coordination completion and IP record with actual validation evidence and remaining external dependencies.

## Validation at this checkpoint

TypeScript compilation passed. Twelve isolated domain scenarios passed: period rollover, mission replay/personalisation, reciprocal matching/privacy, report access and erasure, booking/capacity/wait-list handling, offline scope/replay/revocation, gift inventory/handover, P2P allocation/signalling/lease/key checks, and contribution-credit replay. Statistics tests also cover signed source intake, privacy/key rotation/erasure, cross-runtime proof integrity and matching Solidity runtime/receipt checks. Two Python input/configuration tests passed; the native host script compiles. Browser and real-host acceptance are not yet claimed.

## Constraints carried forward

No gambling, bought/transferred/withdrawable coins, paid chance or financial gaming mechanics. Gift eligibility uses progression and verified partner inventory, not coin redemption. No unconfirmed venues, hardware, participant metrics or publisher access are invented. No new paid service is provisioned. Existing publication authorization is retained; software gaps must be completed before asking for any genuinely missing external access.
