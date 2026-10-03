# C-28 — reviewed venue discovery and map

3 October 2026. PR #31. Based on C-27 `3aac827028969cfeedd314e5e414bbe7099c285d`. Requirement trace: `docs/C28_IMPLEMENTATION_STATE.md`; supplied technical overview §15.2, WOS 004174.

## Delivered

Organizers can supply public entrance coordinates and games from the existing catalogue. Coordinates must be a pair of finite decimal values with at most six decimal places; the map's Web Mercator latitude range is explicit. Integer millionths avoid database floating-point ambiguity; longitude +180 is canonicalized to −180. Old venues default to no coordinates and no game claim. Older update payloads preserve the new values; explicit empty fields clear them.

Changing a confirmed venue's name, type, address, city, country, coordinates or games returns it to review and removes it from public discovery. Staff see the current coordinates and game list. Browser review decisions carry the displayed version, checked while the venue is locked; an intervening edit cannot be silently approved from a stale page. Existing role and staff second-factor controls apply. Direct internal fixture callers retain the existing review function compatibility.

The public directory intersects literal name search, city, country, game and type before a deterministic 200-result window. A limit notice asks the visitor to refine their search. List and map use the same results. Venues without coordinates remain in the list. Empty results and reset are explicit on both languages.

The map library loads after a deliberate button click. No device geolocation, geocoding, browser location storage or private social location is involved. Only confirmed venue names, slugs, public addresses and coordinates reach the map. Popup text is written as text nodes; only internally formed venue links are navigable. Numbered keyboard-focusable markers, a labelled venue selector, zoom controls and the ordinary venue cards provide access. Failure to load code or tiles retains the list; closing the map tears down its listeners and instances.

Migration 37 is additive. Existing QR admission, Clubhouse events and station booking, all other works, membership billing, legal meaning and the official lion remain unchanged.

## Verification

All mutating checks use disposable local PostgreSQL 16.15 or in-memory databases. Browser map requests are intercepted with synthetic image responses: no automated tile requests reach OpenStreetMap.

- Local `npm run check`: all 307 tests passed, zero failures or skips, typecheck and production build. Final accessible-label and distinct-component-key fixes were rebuilt; required CI validates the exact released head.
- Seven new domain tests cover migration/defaults, strict data validation, authorization and review, stale decisions, legacy-update preservation, literal intersected search, bounded discovery and real PostgreSQL edit/review concurrency.
- `scripts/venue-discovery-fixture.ts` and `scripts/venue-discovery-browser.mjs`: ten complete scenarios passed, including organizer creation, staff version checks, publication, search/reset, map selection and navigation, inert popup text, failed library/tiles, suspension and foreign-edit refusal. All 166 tile requests in this run were fulfilled locally; zero reached the external tile service.
- Twelve populated RU/EN directory, organizer and review screens at 390/1440 px, no horizontal overflow. Representative mobile and desktop captures were visually inspected.
- The browser check exposed duplicate filter forms caused by two sibling components sharing a key; distinct keys fix it, and reset plus unique controls are verified on the final build. Explicit accessible selector names are also verified.
- Existing HTTP e2e including staff MFA and existing browser smoke passed on the final local build. All 14 server-agent Python tests passed.
- Source review checked bounded public props, safe text nodes, map cleanup, database locks, minimal shared changes and the unchanged official lion.

Ignored local acceptance artifacts contain only disposable test data. Required CI, merge SHA, deployment and read-only public verification are recorded in PR #31 after publication.

## Operation and remaining requirements

The default map uses the public OpenStreetMap tile service over HTTPS, with visible attribution and ordinary browser caching and referrer behavior. There is no key or new paid service. The service is an external best-effort dependency; a failed map does not prevent venue discovery. No bulk/offline tile download or background prefetch is implemented. Increased real usage requires reviewing the tile service's policy/capacity and choosing an appropriate provider if necessary. Public coordinates are supplied and checked by people, not automatically geocoded or independently address-certified by software.

Only real reviewed venue data should be published. Actual venues, operating hours, games and inventory need operator evidence. Join-policy membership enforcement, native apps, rotating native passes and live attendance transport remain source requirements. The five-direction product still has external host, relay, publisher, chain and operating dependencies; a completed portal map does not establish a complete commercial launch.
