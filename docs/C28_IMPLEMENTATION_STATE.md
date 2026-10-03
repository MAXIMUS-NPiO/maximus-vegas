# C-28 — Clubhouse and venue discovery

Owner-authorized continuation from C-27, main `3aac827028969cfeedd314e5e414bbe7099c285d`.

Source: owner-supplied `project_sources/01-technical-en.pdf`, §15.2, printed page 9: Clubhouse discovery by name, game and location, with a list or OpenStreetMap map. The five-work register identifies Clubhouse as WOS 004174. No separate native application source has been supplied or reused.

| ID | Requirement / implementation decision | Acceptance |
|---|---|---|
| C28-01 | Optional public venue coordinates and supported game tags entered by its organizer; existing venues default to no coordinates and no game claims | Strict paired coordinates, known games, authorization, additive migration and legacy-update compatibility |
| C28-02 | Coordinates, games, identity and venue-kind changes to a confirmed venue require review before it returns to the directory | Staff review exposes the supplied data; draft, resubmitted, rejected and suspended venues never enter public discovery |
| C28-03 | Server-filtered name, game, kind, country and city search with shared list/map results | Literal search, intersected filters, eligibility before pagination, deterministic ordering and truthful empty/limited states |
| C28-04 | Interactive OpenStreetMap map loads only after an explicit action; only reviewed public venue coordinates are serialized | No user geolocation; accessible venue links remain available; map errors preserve the list; safe text markers and attribution |
| C28-05 | Complete RU/EN organizer → staff review → public discovery flow | Local database and browser acceptance, 390/1440 px layouts, required quality gate and public read-only release verification |

Implementation uses a lazily loaded browser map in the current portal; no paid provider or automatic geocoding is introduced. Browser automation intercepts map tiles with local synthetic responses, avoiding automated requests to the public tile service.

Remaining source requirements are preserved: Clubhouse join-policy membership enforcement, native applications, rotating native passes and live presence transport; actual operating venues, hours and inventory require operator evidence. Existing QR/offline controls, all other four works, brand, non-cash gaming, accounts and billing remain intact. Map software acceptance does not establish that any physical venue operates.

State: claimed; implementation and acceptance pending.
