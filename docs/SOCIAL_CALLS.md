# Mutual connections: gaming fit and calls

C-26, migration 35. Implements the browser path for the supplied technical description §15.3. This is original portal implementation; no legacy mobile application source was supplied or reused.

## Gaming consent and scoring

Existing connection profiles start with `gaming_consent=false`. The optional profile checkbox records `MV-CONNECTION-FIT-1` and its timestamp independently of basic discovery consent. Disabling it removes ranking use immediately; withdrawing a profile also clears it. Both people must opt in. Only portal `ratings` with at least one confirmed rated match qualify. No publisher MMR, playtime or inferred personal characteristic is used.

For each shared discipline: 10 points for rated participation, 10 more when the rating gap is at most 200, and 5 more when both rating records were updated in the previous 30 days. The top three disciplines count, up to 75 points. The score orders the eligible set before the 40-profile limit. Cards show game, points, similar-level and recent-activity categories, without either exact rating. It is a gaming-discovery order, not a probability of friendship or a personal assessment. Intent, age, city, preferred game, bilateral blocks and existing matches/likes retain their filters.

## Consent and lifecycle

Only participants in an active mutual match can inspect its call. Both profiles must remain visible, adult and unrestricted. Start requires a user click and device permission; the recipient explicitly accepts the announced audio or video mode. Invitations expire after 60 seconds, accepted calls after 30 minutes. One active call per account is enforced across matches. Browser identities scope media credentials and signals to the starting/accepting tabs; another signed-in tab may end a call but cannot silently join it.

The UI offers microphone mute, camera off/on, decline and end. Navigating away, device loss or control-channel loss closes the peer connection and every captured track. Polling is serial, every two seconds; a 12-second local watchdog stops capture when control is unavailable. A 30-second participant heartbeat timeout terminates the remote session on its next poll. Block, report, unmatch, profile withdrawal, moderation suspension and erasure close call records and remove live reservations. Safety actions remain reachable in maintenance. The connections switch blocks new starts/acceptances.

No media recording API is used. This cannot prevent a participant from using independent recording software. Permissions are enabled only on the conversation route; merely opening it never requests capture.

## Relay deployment

Calls require `MV_TURN_URLS` and a server-only `MV_TURN_SECRET` of at least 32 characters. The relay must support TURN REST HMAC-SHA1 authentication using that secret. Each response uses an opaque identity, with a credential lifetime of at most 32 minutes. Browser transport is always `relay`; the server refuses host/server-reflexive candidates. There is no direct-IP fallback and no paid service is provisioned by this release.

Use an operated relay with TLS/UDP availability appropriate to the supported networks, explicit bandwidth/user/allocation quotas, monitoring, a private management interface, and peer-address restrictions preventing access to internal services. Do not copy loopback acceptance settings into production. TURN REST credentials authorize relay use until expiry; they are not a media-room access token and do not support instant individual credential revocation. The portal independently enforces match/device consent on signalling and closes its own media endpoints on revocation.

A configured relay is not proof of Internet reachability. Before enabling public service, validate two independent external networks, NAT/firewall behaviour, audio/video on the supported desktop/mobile browsers and operator capacity. Local browser acceptance cannot certify these operating conditions.

## Data handling and recovery

The database stores call ID, participant and match references, audio/video mode, lifecycle times, end reason and ephemeral browser identities. Session descriptions and ICE candidates are private, scoped and bounded (64 KB per description, 4 KB per candidate, 256 signals per participant). Only the other owning participant receives them. There is one offer and answer per call; retained idempotency keys cannot be reused for another payload or call. Packets for ended calls are refused after signalling is erased. Signalling and relay keys are excluded from account exports, audit and application-error logs.

Ending a call deletes signalling and reservations in its transaction. Poll/start also expire stale calls involving those participants. The existing authenticated daily maintenance job sweeps abandoned sessions in batches of 100; `CRON_SECRET` and the existing scheduler must be operational. Abandoned signalling can remain until that sweep (or a participant's next visit), rather than being deleted at the exact heartbeat deadline while no requests execute. Account erasure deletes the participant's call rows and cascading signals; account export includes only minimal call metadata.

## Acceptance

`tests/social-calls.test.ts` covers ranking/consent, roles, device scope, relay-only configuration, signal validation/replay, interruption cleanup and local PostgreSQL races. `scripts/social-calls-fixture.ts` and `scripts/social-calls-browser.mjs` require loopback and a `c26_` database, never production. Browser acceptance uses native WebRTC with synthetic capture devices and a real local TURN relay, and checks RTP reception, decoded frames and nominated relay candidate pairs. Fixture session cookies remain in ignored local artifacts.

Protocol references: https://www.w3.org/TR/webrtc/ and https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf.

Remaining source requirements include native applications/push, precise proximity, selfie verification with approved providers, and publisher-specific playtime feeds. These are not activated or claimed by C-26.
