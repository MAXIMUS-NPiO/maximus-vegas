# C-27 — Optional nearby discovery

Internal implementation record, 3 October 2026. Continues the owner-authorized five-work implementation from `0e1b35494bed6d182835670afa769ef8b2849cff` (C-26, PR #29).

Source: owner-supplied `project_sources/01-technical-en.pdf`, §15.3, printed page 9: proximity and bidirectional block exclusion in discovery. WOS 004170 remains the source work. The described separate application source has not been supplied or inspected. This implements the requirement in the current portal.

| ID | Requirement / implementation decision | Acceptance |
|---|---|---|
| C27-01 | Separate optional nearby consent, default off; browser geolocation only after a deliberate action | No permission request or location upload on page load; denial and unsupported-device states |
| C27-02 | Round latitude/longitude to 0.1-degree grid cells in the browser before transport; store one current cell with seven-day validity, no raw coordinates or history | Reject malformed cells; own export only; no coordinates, cell IDs, distance or direction in candidate results or audit payloads |
| C27-03 | Filter by fixed 25/50/100/250 km approximate radii; both people need active nearby consent and visible, unrestricted adult profiles | Spherical distance handles dateline and poles; eligibility and block filters apply before the 40-result limit; gaming ranking retained |
| C27-04 | Immediate deletion on nearby opt-out, profile withdrawal, moderation suspension or account erasure; expired cells never participate and are purged by maintenance | Revocation, expiry, concurrency and deletion checks; disabling remains available during maintenance |
| C27-05 | RU/EN control and clear expiry/approximation text; city/game/age filters continue to work without location | Full browser enable/filter/reset/disable flow, mobile/desktop checks, authentication/origin protection |

Implementation difference from the supplied architecture: PostgreSQL spherical-distance SQL over deliberately coarse cells is used instead of installing PostGIS or storing precise geography points. The portal does not expose a map or claim live tracking. This approximation may include or omit people near a radius boundary; the product must explain that. No new paid service is required.

Unchanged remaining requirements: native apps and push, selfie verification with operated moderation, publisher-specific playtime, public TURN, actual streaming/server hosts, licensed game acceptance, confirmed physical venues and inventory, and chain deployment. Existing brand, free-entry/non-cash gaming boundaries and account/payment/legal behavior remain in force. No external source reuse or commercial readiness is inferred.

State: claimed; implementation and acceptance pending.
