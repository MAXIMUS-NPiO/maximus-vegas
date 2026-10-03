# C-26 — Gamer compatibility and consent-bound calls

MIPA internal implementation record. Date: 3 October 2026. Continues the owner-authorized five-work implementation from production main `9898ef35209096848d5f6ddd32cf316657819099` (C-25, PR #28). No external message sending or new paid infrastructure is authorised by this record.

Source: supplied `technical-en.pdf` (local `project_sources/01-technical-en.pdf`), section 15.3, printed page 9: competitive-gaming compatibility, participant-validated voice/video and block/report/mute/unmatch. WOS 004170 and its C-24 implementation remain the baseline in `docs/FIVE_WORKS_IMPLEMENTATION.md`. The technical document describes separate existing apps; their source repositories have not been inspected or supplied here.

| ID | Preserved requirement and chosen implementation | Acceptance |
|---|---|---|
| C26-01 | Separate optional consent for use of confirmed portal rating/activity in discovery; never infer publisher MMR or playtime | Existing profiles remain opted out; withdrawal immediately removes use |
| C26-02 | Explainable gaming compatibility, up to 25 points per shared discipline; existing intent/age/city and bidirectional block filters retained | Deterministic ranking, consent and privacy tests; no new private statistic disclosed |
| C26-03 | Voice/video scoped to one active mutual match with an invitation and explicit acceptance; one live call per participant, bounded duration | Role/scope/replay and real PostgreSQL race checks |
| C26-04 | Microphone/camera start only on participant action; local mute, camera off, hang up; relay-only WebRTC with short-lived credentials | Actual two-context browser audio/video; no media recording or capture before action |
| C26-05 | Blocking, unmatching, withdrawal, suspension, expiry and control-channel loss end media; temporary signalling is removed | Negative tests, interruption cleanup, account export/erasure without SDP/ICE or credentials |
| C26-06 | RU/EN accessible member flow; unavailable call infrastructure shown truthfully; existing messages remain usable | Responsive screenshots, browser controls and regression suite |

TURN is an external operating dependency: absent configuration must leave calls unavailable, without public direct-IP fallback. Testing will use an isolated local relay. No provider account or paid relay is provisioned. No app-store release, native Windows/macOS streaming adapter, selfie verification, precise geolocation/proximity, publisher playtime feed, native push or external legacy source reuse is claimed by C-26; these remain separately unfinished source requirements. Commercial gaming/payment boundaries and official branding remain unchanged.

Current state: requirements recorded; implementation and acceptance in progress.
