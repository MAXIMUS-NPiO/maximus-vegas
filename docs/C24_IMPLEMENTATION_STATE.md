# C-24 five-work implementation state

Owner instruction: implement all five directions and continue through verification and publication. Release path: PR #27 on `core/C-24-five-works`. Accepted software and reproducible checks are recorded in `docs/RELEASE_C24.md`; the merged SHA, production deployment and read-only public acceptance are recorded in the pull request. Local acceptance alone is not proof of deployment.

## Software acceptance completed on 3 October 2026

- WOS 004171: UTC daily/weekly/90-day seasonal assignments; game preferences frozen per assignment; confirmed activity progress; atomic, replay-safe reward claims; season history; verified-venue gift stock, reservation and collection-code handover.
- WOS 004170: separate 18+ opt-in profile and consent; gaming/friendship/dating intent; discovery filters; reciprocal matching; participant-only paginated messages; delivery idempotency; blocking, withdrawal, report excerpts, moderation suspension, account export/erasure.
- WOS 004174: clubhouse opening hours, station inventory, conflict-checked reservations, free events and capacity, waiting-list promotion, linked single-entry passes, operator workspace; device-scoped offline manifests and queued provisional arrivals with server reconciliation, revocation and replay checks.
- WOS 004173: reviewed host registry, live availability, exclusive allocation and bounded leases, participant-only signalling, temporary TURN credentials, browser video and input, a host-rendered MAXIMUS Arena, explicit screen sharing, bounded confirmed contribution credits, scoped/revocable native host keys. Linux adapter provides a dedicated Xvfb display, sandboxed allowlisted game execution, video/audio capture and bounded input. Real GPU/publisher compatibility and public relay connectivity still need actual infrastructure acceptance.

- WOS 004172: Ed25519 source registration with independent approval, player-handle challenge/consent, exact-byte signed intake with replay protection, organiser review, private period snapshots, local Merkle verification and optional portal signatures. A compiled nonpayable Solidity anchor and read-only receipt/code/finality verifier are provided; chain deployment and regulated financial operations remain gated.
- Cancellation and inventory pause controls, moderation restoration, staff scanning, navigation, fractional metering and session termination on key revocation are implemented.

## Verified evidence

- Typecheck, production build and the standard test suite passed: 256 passed, 10 PostgreSQL-only tests skipped in that configuration. The 10 were separately run against isolated PostgreSQL 16 and all passed. No failed tests.
- Eight complete new browser scenarios passed, including mutual messaging, missions and gift reservation, clubhouse capacity, real offline scanning and reconciliation, signed statistical intake and local proof verification, real WebRTC video frames and keyboard control, and host-key lifecycle.
- Eight populated screens were checked in RU and EN at 390 and 1440 px: 32 screenshots, no horizontal overflow. No unexpected browser/console errors or HTTP 5xx. Expected disconnected-network failures were recorded only during the intentional offline-scanner step.
- Existing full HTTP end-to-end and browser-smoke scenarios passed on the local production build. The production database was not used for test data.
- Two native adapter protocol/configuration tests passed and the Python scripts compiled. Contract compilation and runtime/receipt verification tests passed.

## External acceptance still required

The portal workflows have passed software acceptance; operating infrastructure still requires connection and verification. Operating GPU hosts and public relay connectivity, native installed-game/publisher/anti-cheat compatibility, publisher-specific source credentials, actual venue operators and gift stock, and chain deployment/RPC evidence cannot be inferred from code. No public GPU fleet or blockchain inclusion is claimed. Windows/macOS host agents and server rental remain separate extensions of the supplied P2P concept. The offline scanner requires its page to remain open; arrivals are provisional until reconciliation.

MIPA implementation provenance is recorded in `docs/IP_RECORD.md`.

## Constraints carried forward

No gambling, bought/transferred/withdrawable coins, paid chance or financial gaming mechanics. Gift eligibility uses progression and verified partner inventory, not coin redemption. No unconfirmed venues, hardware, participant metrics or publisher access are invented. No new paid service is provisioned. Existing publication authorization is retained; software gaps must be completed before asking for any genuinely missing external access.
