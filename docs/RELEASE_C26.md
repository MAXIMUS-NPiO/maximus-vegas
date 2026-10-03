# C-26 — consent-based gaming fit and private calls

3 October 2026. Pull request #29. Based on C-25 production `9898ef35209096848d5f6ddd32cf316657819099`. Source trace: `docs/C26_IMPLEMENTATION_STATE.md`; operator and data-handling details: `docs/SOCIAL_CALLS.md`.

## Delivered

- Optional, versioned bilateral gaming consent, default off for existing profiles; confirmed portal rating/activity only. Up to 25 points per shared discipline, top three, explained without exposing exact ratings. Ranking precedes pagination and preserves existing discovery filters and blocks.
- Audio/video invitation and explicit acceptance inside active mutual conversations; one call per participant across matches, one owning browser per side, 60-second invitation and 30-minute media limits.
- Relay-only native WebRTC, opaque expiring TURN credentials, private bounded/replay-safe signalling, mute/camera/end/decline controls and no capture before a click. No media recording.
- Device/control loss, leaving the conversation, blocking/reporting, unmatching, withdrawal, platform/profile suspension and account erasure close media control. Safety actions remain available in maintenance. Ended signalling and reservations are deleted; the existing daily maintenance job sweeps abandoned sessions.
- RU/EN member UI and portal call notifications; exact call-relay configuration state in `/api/health`. Messaging remains independent of relay availability. Existing commercial and brand boundaries are unchanged.

## Verification

Local testing used isolated PostgreSQL 16 and synthetic browser devices, never production accounts or data.

- `npm run check`: typecheck, 290 tests passed with zero failures/skips, production build passed. The subsequently added numeric coin-history boundary test and all seven companion community checks also passed (291 distinct tests in the final suite). The required pull-request workflow must pass on the final head before merge.
- Ten complete browser scenarios passed: native permission denial; no unsolicited capture; bilateral relay-only audio/video with decoded RTP; RU controls; decline; control loss and heartbeat expiry; navigation cleanup; connected-call blocking; gaming consent/filter/reset; unauthenticated and cross-origin rejection. Sixteen populated RU/EN desktop/mobile screenshots at 390/1440 px were checked for overflow; representative views were visually inspected.
- Existing HTTP e2e passed, including second-factor enrolment, all control-centre tabs, moderation, venues, switches/maintenance and academy. Existing real-browser smoke passed.
- Fourteen dedicated-server agent tests and two streaming-host agent tests passed.

The repeated-call acceptance exposed lexical sorting of signal IDs across 99/100. Ordering now uses the numeric database column, with a deterministic boundary regression. The same issue in free coin-history display was corrected and tested; balance calculations retain their existing path.

Local evidence is kept in ignored acceptance artifacts. CI, merge SHA and public deployment/readiness evidence are recorded in PR #29 after publication.

## Operating boundaries

No new paid infrastructure, provider account or external message was created. The public site must not be described as offering working Internet calls solely because code has deployed: `MV_TURN_URLS`, `MV_TURN_SECRET`, relay capacity and external-network/browser acceptance are required. The local acceptance uses synthetic devices, native WebRTC and a real loopback relay; it proves transport implementation, not an external service deployment. The daily stale-signalling sweep requires the existing cron secret and scheduler; call-end cleanup is transactional and does not depend on cron.

The source's native applications, native push, precise proximity, selfie verification and publisher playtime are not supplied or completed here. C-24/C-25 external machine, licence, venue and blockchain dependencies remain open. This release advances the dating direction, not a claim that the entire five-work operating ecosystem is complete.
