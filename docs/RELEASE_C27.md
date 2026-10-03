# C-27 — optional nearby discovery

3 October 2026. PR #30. Based on C-26 production `0e1b35494bed6d182835670afa769ef8b2849cff`. Source requirements and implementation decisions: `docs/C27_IMPLEMENTATION_STATE.md`.

## Delivered

Separate nearby consent, off by default, with browser location requested only after an explicit click. The browser converts coordinates to integer 0.1-degree cells before transport. The API accepts only this bounded protocol; precise coordinates, arbitrary fields and foreign-origin/unauthenticated requests are refused. No location or distance is returned with another person's profile, rendered into page props or written to the audit payload.

Fixed approximate radii of 25, 50, 100 and 250 km are evaluated in PostgreSQL before the 40-result limit. Both members need unexpired nearby consent and eligible profiles; intent, city, age, game, blocking and existing gaming ranking still apply. Spherical distance handles the antimeridian and poles. A coarse cell is not an exact position, and boundary matches are explicitly approximate.

One current cell per member is valid for seven days; updates are limited to one an hour, including across disable/re-enable cycles. Opt-out, hiding the profile, moderation suspension and erasure delete it. A revision under the user row lock rejects delayed uploads after revocation, including from a second tab. Restoring a profile does not restore a location. Safety deletion remains available in maintenance or when new connections are disabled. Only the owning account's export includes its coarse cell. No movement history is created.

RU/EN controls cover permission denial, unsupported devices, pending permission cancellation, stale-tab settings and connection errors. Radius search remains separate from ordinary city/game/age discovery. Reset now remounts the filter fields so their displayed values match the cleared results. The public status description reflects the new capability. Official branding, account/payment and legal meaning remain unchanged.

## Verification

All mutations used isolated local PostgreSQL 16.15 or in-memory test databases; no production test accounts or data.

- `npm run check`: typecheck, all 300 tests passed, zero failures or skips, production build. The final filter-reset/public-copy change was also rebuilt and typechecked; the required pull-request check verifies the complete final head.
- Nine new tests: migration from pre-C27 profile data, malformed/coarse location protocol, spherical boundaries and response privacy, bilateral eligibility and ranking, expiry before cleanup, filtering before limits, revocation/moderation/erasure, maintenance/restriction boundaries, and PostgreSQL enable/revoke/withdraw races.
- `scripts/social-nearby-browser.mjs`: ten full scenarios with actual browser geolocation using synthetic local positions, PostgreSQL persistence, real form submissions, delayed cross-tab upload, denial/unavailable/cancellation, scope/origin headers, and responsive layouts. No page errors or HTTP 5xx.
- Twelve populated RU/EN screens at 390/1440 px, no horizontal overflow. Representative mobile/desktop screenshots visually inspected.
- Existing HTTP e2e passed, including staff MFA and control-centre behavior. Existing real-browser smoke passed.
- Source review checked client-only location capture, bounded serialized props, late callback cleanup, minimal shared-file changes, and unchanged official lion.

Local acceptance artifacts remain ignored. Required CI, merge SHA, deployment and read-only public verification are recorded in PR #30 after publication.

## Operation and remaining scope

No new provider, key or paid infrastructure is required for nearby discovery. Browser location needs HTTPS and user permission; the device may refuse or return an inaccurate position. It is not a verified address or live tracker. Updating location is an explicit action, not background collection.

The existing authenticated daily maintenance job deletes expired rows. Until its next successful run, expired cells can remain stored but cannot participate in discovery; opt-out and account/profile deletion remove them transactionally. Keep the existing scheduler and cron secret operating. The only retained rate-limit metadata after nearby opt-out is the last successful update time and revision, without location. Account erasure removes the profile metadata as well.

This closes the portal's approximate proximity workflow, not the separate legacy native-app implementation or an exact PostGIS map. Native apps/push, selfie verification with operating moderation, publisher playtime, public TURN acceptance, actual streaming/server machines, licensed games, confirmed venues/inventory and chain deployment retain their recorded external or unfinished boundaries. Five-direction commercial operation is not established by this release.
