# Player experience imports

Players can carry existing experience into MAXIMUS VEGAS without earning local XP again. Imported source ranks, playtime and match history remain separate from local progression, tournament ratings and eligibility. No cross-game rank, XP conversion, inferred MMR, anti-cheat certification or complete-history claim is created.

The management page is `/ru/experience` or `/en/experience`. A player first verifies one Steam identity, then explicitly consents to each source. Importing and public sharing are separate choices. Private is the default. The public passport also respects the player's overall profile visibility.

## Supported sources and configuration

| Source | Ownership binding | Imported data | Operator configuration |
| --- | --- | --- | --- |
| Steam | Steam OpenID assertion validated directly with Steam | Public lifetime playtime for supported Steam games; no skill rank | `NEXT_PUBLIC_SITE_URL` and server-only `STEAM_WEB_API_KEY` |
| OpenDota | Steam32 account derived from verified Steam64; returned Steam64 and account ID must both match | Dota 2 medal/stars, source win/loss totals, optional leaderboard position, up to 20 recent matches | `NEXT_PUBLIC_SITE_URL`; no API key or paid access is requested |
| FACEIT | Lookup by verified Steam64; both returned `steam_id_64` and CS2 `game_player_id` must match; player UUID remains pinned | CS2 FACEIT level/Elo, available lifetime match/win totals, up to 20 recent matches | `NEXT_PUBLIC_SITE_URL` and server-only `FACEIT_API_KEY` |

`MV_EXPERIENCE_DISABLED=1` disables new verification, connection and refresh. Missing credentials produce a visible configuration state and prevent a request. The Steam ownership check itself does not require a Web API key. Keys are read on the server and never stored in a player record, rendered, returned by exports or logged by the import code.

Steam games currently matched by App ID are Counter-Strike 1.6 (10), Counter-Strike: Source (240), Team Fortress 2 (440), Dota 2 (570), Counter-Strike 2 (730), Rocket League (252950), PUBG (578080), Apex Legends (1172470) and Deadlock (1422450). Availability in a particular player's Steam library is not assumed. Existing manually entered game nicknames cannot serve as ownership evidence, including an old generic `verified` flag with no provider assertion.

Other games and services are not advertised as automatically supported. Approved partners can use the existing signed-statistics intake. The passport reuses only records whose source is currently approved, account link currently verified and observation confirmed by an organiser. Publishing this partner history requires its own opt-in. The UI labels this as partner/organiser evidence, not publisher verification.

## Provider contracts checked

Primary documentation checked on 4 October 2026:

- [Steam user authentication and ownership](https://partner.steamgames.com/doc/features/auth): the browser OpenID flow returns a Steam identity that can be linked to an existing account. Credentials remain at Steam. Both the documented HTTP claimed-identity URI and HTTPS equivalent are accepted only within the exact Steam identity namespace.
- [OpenID Authentication 2.0](https://openid.net/specs/openid-authentication-2_0.html): assertion verification, signed fields, return URL, nonce freshness and direct `check_authentication` validation. The implementation pins Steam's endpoint rather than following arbitrary discovery or callback URLs.
- [Steam IPlayerService](https://partner.steamgames.com/doc/webapi/IPlayerService) and [Steam Web API](https://steamcommunity.com/dev): owned-game data depends on game-detail visibility. `GetOwnedGames` uses `input_json`, including played free games and a supported-app filter; `GetPlayerSummaries` checks the exact requested identity and public visibility. Empty hidden game details are not recorded as zero playtime.
- [OpenDota API OpenAPI schema](https://api.opendota.com/api/) and [API documentation](https://docs.opendota.com/): public API access without a key; `/players/{account_id}`, `/wl` and `/recentMatches`. The schema defines Steam32 account IDs and the medal encoding: tens identify Herald through Divine, individual increments identify stars, and 80 identifies Immortal. The adapter keeps the original rank code and displays the documented medal. It does not use estimated MMR. OpenDota is an independent source and may contain incomplete or delayed history.
- [FACEIT Data API](https://docs.faceit.com/docs/data-api/data/): authenticated player lookup by `game` and `game_player_id`; Steam identity fields; game-specific `faceit_elo` and `skill_level`; lifetime statistics and bounded history. Match IDs are opaque strings, including prefixed IDs. History entries must contain the matching player and Steam ID in a returned team before being displayed.

The code is tested with isolated provider-response fixtures. No real player's account was connected, no paid provider account was provisioned and no successful live import is implied by these tests. Operator keys, provider permissions and player consent are needed for configured providers before a live import.

## State, ownership and privacy

Steam challenges expire after ten minutes, are bound to the initiating user and session, and can be used once. Required fields must be signed; duplicate callback parameters, foreign endpoints, wrong return URLs, malformed IDs and old nonces are rejected before a network request. Steam's direct validation must return a valid assertion. A durable nonce table prevents replay across challenges. A unique Steam identity can belong to only one portal account. Changing it requires explicit disconnection, which removes imports.

Each connected source keeps consent version/time, sharing choice, provider account ID, binding date, attempt/import dates, next scheduled time and normalized records. It never modifies XP events. Account ownership and the authority/completeness of a source's metrics are separate facts.

`available`, `pending`, `private`, `unavailable`, `error` and derived `stale` are visible states. Transient errors and 429 responses retain the last successful snapshot and its original date, explicitly marked stale. A successful snapshot older than 72 hours is also stale. A private profile, hidden game details, missing profile or mismatched identity clears previous metrics; access denial also hides them. Missing data does not produce a novice label. Steam visibility and API access do not guarantee Dota match-history visibility.

Disconnecting a source deletes its imported records and stops its refresh. Disconnecting Steam removes all imported connections, pending verification state, nonce associations and sharing settings. A refresh in progress cannot recreate removed data: its unique lease must still match a live connection. Identity verification and erasure share a user-row lock, preventing a late callback from restoring a withdrawn identity. Account export and erasure call the same helpers. Minimal action audit records and aggregate provider request counters contain no external IDs, metrics or credentials.

## Sync and capacity

Manual refresh is limited to one attempt per source every fifteen minutes. Successful checks become due after 24 hours; failed checks back off from one hour up to 24 hours. Leases prevent concurrent refreshes. A player can continue to disconnect or withdraw public sharing while provider imports are disabled.

The deployed schedule is a daily `/api/cron/experience` invocation at 04:47 UTC, protected by `CRON_SECRET`. One run selects at most five due source connections and stops starting work after a 45-second deadline. It is deliberately a small batch, not a promise that every player's data refreshes every day. Visiting the signed-in `/experience` page also schedules an after-response refresh of only that player's at-most-three due connections, with a 40-second deadline. The displayed snapshot is rendered immediately; reload after the background operation to see its result. Maintenance and the integrations feature switch pause both scheduled entry points.

Every outbound request, including a failed one, consumes durable source-wide fixed-window budgets: 20 requests/minute, 900/day and 15,000/month. These are this application's conservative caps, not assertions about provider quotas or purchased capacity. Steam needs at most two calls per source refresh; OpenDota and FACEIT at most three. Provider 429 responses stop the attempt and invoke backoff. Other users sharing an upstream IP or provider plan may cause earlier upstream limits. Scaling requires an explicit capacity review and a suitable scheduler; this change does not purchase a higher plan or silently add paid API keys.

Endpoints are constructed from fixed provider hosts and strict paths. Imported profile URLs are ignored. Redirects are rejected. Each request has a maximum five-second timeout and a 500 KB body cap; OpenID validation is capped at 4 KB. Error messages are normalized before persistence. POST actions use the site's existing session, origin check and feature gate; form bodies are limited to 4 KB. Exports are authenticated, attachment responses with `no-store`.

## Integration and verification

- Migration statements: `playerExperienceSchema` from `src/server/player-experience-schema.ts`, appended by the core lane as migration 41.
- Read model: `profileExperience(q, userId, viewerId?)`; `PlayerExperienceCard` accepts `lang`, `data`, optional `availability` and optional `manage`.
- Directory badges: `publicExperienceBadges(q, usernames)` returns a bounded `Map<string, string[]>`; it returns only source labels backed by shared, verified, non-empty experience on active public profiles.
- Lifecycle: `experienceExport(q, userId)`, `eraseExperience(q, userId)`, `syncExperience(db, limit = 5)` and `syncOwnExperience(db, user)`.
- Fixture verification: `node --experimental-strip-types --test --test-reporter=tap tests/player-experience.test.ts`. With `PG_TEST_URL` pointing to an isolated test PostgreSQL database, the same file also tests competing identity bindings, refresh leases and disconnect during an in-flight refresh using multiple database connections. No test runs against production.
