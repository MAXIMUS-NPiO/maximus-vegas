# Community operations (C-30)

The primary experience is shared play: account → My teams & invitations, and account → My community. Discovery/dating remains a separate opt-in profile. Friendship requires recipient acceptance, and works without discovery. Hiding discovery keeps accepted friends; closing a conversation or blocking a person ends the connection and its private calls. Blocking never automatically restores friendship when lifted.

## Invitations and photos

The personal team desk shows led/joined teams, incoming invitations, outgoing invitations and reservation history. It accepts both `player` and `@player`. Every new name reservation redirects to its expanded manual delivery controls with recipient email. Reserving is not sending: email opens the user's mail application. Existing accounts receive an on-site invitation. Search finds old records by literal username; each result list is bounded to 100. Bearer reservation links remain visible only to team leadership. No old reservations are deleted by this migration.

Profile photos use the existing normalized image pipeline, with a 128 KiB output limit, metadata removal and a durable 20-per-day avatar replacement cap. Photos appear in the account, profile, player directory, rosters, friends and chats. Public profiles have public photos. A private photo is visible to the owner, accepted contacts, shared team/clan members and signed-in readers after an owner posts in global chat; bilateral blocks override access. Responses are private/no-store. Replacement deletes the old asset; account deletion removes the asset and chat content.

## Rooms and moderation

Global text chat requires an active adult account. Team/clan rooms recheck current membership on every read/write; departed players lose access. Messages are at most 1,000 characters, 10 per minute, with payload-bound retry keys. Latest/earlier pages contain at most 50 messages; visible tabs refresh every five seconds. Authors can remove their messages. Reporting saves an excerpt for independent conduct review and blocks contact. The conduct tab includes community reports, and staff receive on-site notifications. Use existing conduct sanctions for account-wide restrictions. Reports/deletion/block/voice exit remain available during maintenance.

Friendship requests are bounded to 20 per day with a seven-day retry cooldown after refusal, cancellation or termination. Clan alliance/rivalry proposals require both leaderships, expire in seven days and can be ended by either clan. In-game matches keep existing consensual rules. Transparent hosts may facilitate meetings; no fabricated members, targeted harassment, hidden flirtation campaigns, addiction incentives or false clinical claims are deployed.

## Group voice activation

Code uses the existing LiveKit SDK but a distinct audio-only room lifecycle. No commercial account is created and no configuration secret is changed by this release. Production activation requires:

1. A reviewed LiveKit **Cloud** account and `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (the URL must be a bare `wss://*.livekit.cloud` origin). Self-hosted token revocation is not assumed equivalent.
2. An authenticated external scheduler calling `GET /api/cron/community` every minute with the existing `CRON_SECRET`. The default daily maintenance schedule is insufficient. Keep the credentials and worker while any cleanup remains pending.
3. Run the worker successfully, then enable `MV_COMMUNITY_VOICE_ENABLED=1`. New joins require a healthy heartbeat younger than 150 seconds and the connections feature on. Missing configuration leaves voice visibly unavailable and text chat usable.
4. A real two-device acceptance: join as listeners; explicitly enable each microphone; deny and re-allow permission; hear both directions; mute/leave; close a tab; remove a team member; block a participant; end the meeting; verify refreshed tokens cannot rejoin and the provider room is deleted. Observe worker failures/retries and provider usage before public activation. None of these real media/provider checks is claimed by CI.

Initial bounds: 4 concurrent rooms platform-wide, 8 concurrent members per room, 30 minutes per meeting, 12 joins per account per hour. A user joins one voice room at a time with an opaque browser/device identity. The UI never opens the microphone automatically; camera, screen and data publishing are not granted. The platform makes no recordings. These statements do not guarantee other participants cannot record using their own devices.

Authorization is enforced in the app and by scoped audio-only provider tokens. Token TTL is 60 seconds **and is not treated as disconnection**: Cloud may refresh tokens. Leave revokes the seat identity explicitly with a forward cutoff; the minute worker revokes all remaining identities and deletes a room on expiry, missing heartbeat, changed membership, account restriction, a participant block or a disabled feature. A safety change closes the meeting for all participants. Cleanup failure keeps a closing record and disables new joins via the unhealthy heartbeat. Cleanup tombstones are retried for at least 90 seconds to cover ambiguous creation. Worker health must be monitored; an outage can delay termination of existing media, even though it stops new joins. The interface and polling alone are not an enforcement boundary.

Provider source: https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/ and https://docs.livekit.io/frontends/reference/tokens-grants/ (reviewed 4 October 2026), plus installed server SDK v2.19.1. The explicit revocation cutoff also suppresses an absent-participant error. Keep provider and scheduler operating for cleanup; do not remove their credentials as an off switch.

## Hosts and professional support

`/community/support` separates community hosts from professional psychological support (ПСИХОЛОГИНЯ). It starts empty. No practitioner, employment relationship, qualification, availability or tariff is invented. Real applicants provide public descriptions and professional-source/booking URLs; no identity documents, clinical intake or health records are collected through this form. Staff review in the existing academy section requires MFA, independent review, evidence notes, a current application version and an explicit expiry no later than credential expiry. Edits unpublish the card pending review; expired/suspended cards disappear. Staff must verify identity, scope of practice, applicable practitioner/facility permissions and the external booking terms before approval. URLs are links to reviewed external provider pages, not an integrated clinical appointment service.

Official UAE/Dubai scope sources reviewed for this boundary:
- https://www.dha.gov.ae/uploads/012025/DHA%20Mental%20Health%20Services%20Scope%20of%20Practice2025154594.pdf
- https://www.dha.gov.ae/uploads/012025/Standards%20for%20Mental%20Health2025144952.pdf

Those sources do not establish permission for every provider or jurisdiction. A directory approval is not a substitute for the provider's applicable practice permissions. Clinical operation, staffing, commercial terms and real group-media operation remain separate activation work.
