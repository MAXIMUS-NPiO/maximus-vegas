# Operational administration (C-33)

Owner: MAXIMUS. Implementation: PR #37, migration 41. The existing `/ru/admin` and `/en/admin` are the entry points. Every section requires a staff session and enrolled, recently verified MFA. Sensitive decisions require verification within 15 minutes. Personal player activities do not become staff actions merely because the player also holds a staff role.

## Assessment delivered before implementation

| Owner capability | Real backend before C-33 | Backend work added in C-33 |
| --- | --- | --- |
| Tournaments | Organizer creation/editing, state machine, registrations, seeding, bracket regeneration, result correction and repair preview | Search across all games/formats/states; reasoned administrator transition wrapping the existing state machine atomically; shared organizer and match tools inside the admin shell; MFA on staff use of their shared privileged endpoints |
| Users | User search, private profile access with audit, global staff roles, suspension, linked game names, tournament and match history | Integrated profile/history/accounts; audited administration of space-scoped organizer/referee access; ownership cannot be replaced by this form |
| Trust and safety | Reports, evidence and digest, versioned rules, confidence policy, sanctions, appeals with issuer exclusion | Explicit independent appeal assignment and reassignment; only assigned, active eligible staff can decide; issuer and appellant excluded; submitted rule version must still be current |
| Decision log | Hash-chained audit records and actual SHA-256 recomputation | Search, cursor pagination, full stored JSON and hashes, explicit full-chain verification with checked record count, timestamp and head hash |
| Games catalog | Static built-in game array; earlier battle-royale labels already partly corrected | Persisted add/edit/retire, optimistic version check, independent roster size/mode/formats, public catalog and dynamic game routes, tournament validation and forms, teams/rankings filters and linked game names |
| Applications | Coach and venue review were real; generic inquiries had only new/in-review/closed | Approved/rejected dispositions with staff, reason, time and version; separate coach/venue review links; approval never provisions a service |
| Sponsors | Create, toggle active and attach/detach domain operations | Versioned record editing, logo replacement/removal, active status, tournament search and explicit detach controls |
| Dashboard | Real public `trustStats` / `trustReport` and operational `adminOverview` | Same-source public/exact comparison, queue counts, unassigned appeals, oldest report, section-scoped internal visibility |

This assessment replaced stale assumptions that the portal was only a landing page or that every service described by the portal was fully connected. The supplied control-centre overview, MVP requirements, product brief and historical-system report informed scope; source code determined what could actually be operated.

## Day-to-day workflows

Tournament search includes inactive and retired games, all eight implemented formats and every event status. Select an organizer space to create an event. Open an event for its existing editor, entrant approval/waitlist/check-in, seeding, structure and results. Match drilldowns retain the admin shell, including repair previews. Existing transactional repair rules and changed-bracket checks remain authoritative. A status override is a documented administrator transition, not arbitrary SQL; incomplete brackets cannot be declared complete. Existing operator-awarded, non-cash coins remain accessible.

Player is the base account capability. Organizer means owner/admin in a specific organization; it is not a global staff role. Platform referee and organization referee have different scope. Existing global staff role controls and account suspension are available from Users. Conduct restrictions use the separate rule/evidence/confidence workflow. Linked names clearly distinguish player-supplied handles from verified accounts.

An appeal is automatically assigned to an active eligible conduct reviewer other than the issuer or appellant, ordered by open workload. If none exists it remains visibly unassigned. Another eligible colleague can reassign it with a reason. Only the assigned reviewer may decide; a legacy unassigned appeal is claimed atomically when an eligible independent reviewer decides it. A suspended or conduct-restricted reviewer is ineligible. Concurrent assignments and decisions lock the appeal row. Assignment does not confer a staff role or bypass MFA.

Catalog changes carry a reason and expected version. The slug is immutable. Retiring a game hides it from new-game choices and prevents new tournaments, team creation and tournament copies, while preserving historical URLs, rankings and the operation of existing events. Changing allowed formats does not silently rewrite existing tournament formats. New tournaments use only the current allowed formats. Catalog mode does not imply roster size, match format or publisher integration.

Generic application approval is a recorded disposition only. It never activates academy, cloud, venue, school or other external services. The existing coach and venue publication queues remain separate real workflows. Concurrent reviews cannot overwrite a colleague's decision without reloading the current version.

## Integrity and permission boundaries

The log verification button recomputes every stored audit record, including canonical JSON, actor, entity, time and predecessor hash. It verifies the whole stored chain regardless of the current search filters. An append lock keeps the reported head and count consistent during verification. A valid result demonstrates consistency of the stored chain; without an externally trusted checkpoint it cannot rule out tail truncation or wholesale recomputation by a database administrator. Verification is a read-only request and does not append a new record.

All new write handlers reuse same-origin POST validation, server-side staff/section checks and MFA. Catalog, organizer grants and status overrides require platform admin. Application review and sponsor management retain their existing support/marketing section rights. Exact small conduct counts and internal queues are shown only to conduct/audit staff; the public view continues suppressing counts below three.

Forms for catalog, generic applications and sponsor records submit expected versions. Audits record before/after values and reasons. Publisher keys, payment credentials and MFA secrets never appear in these forms or audit data. Existing payment readiness remains authoritative; this release does not enable MPGS collection or change acquiring settings.

## Acceptance evidence and remaining limits

`tests/admin-operations.test.ts` covers persisted catalog metadata, forbidden and stale writes, actual new-game registration, retirement/history, safe status transitions, scoped organizer access, private profiles, application decisions, independent appeals, explicit rule versions, sponsor editing/attachments and deliberate audit tampering. The existing conduct test now checks assignment before review.

`scripts/admin-fixture.ts` and `scripts/admin-http.mjs` create disposable `/tmp/c33-*` databases, run the actual production build locally, and exercise protected RU/EN pages and real POST handlers. They refuse external database settings and never use production records. CI runs this acceptance after `npm run check`; only the sanitized check report and server log are uploaded, never session fixtures. Existing CI also runs PostgreSQL-only domain tests, server-agent tests and the established community/studio browser suites.

Local validation: 343 Node tests (324 passed; 19 PostgreSQL-only cases deferred to the required CI database), 14 server-agent tests, production build and 16 HTTP acceptance scenarios including 20 RU/EN protected-page renders. The final protected PR must also pass its exact-head CI.

Local control-centre visual inspection is explicitly unverified: the available cloud browser rejected the localhost URL. Successful server rendering and HTTP acceptance are not represented as a click-by-click browser check. Production verification must remain read-only; no users, tournament fixtures, sanctions, applications or payments are created to test the live portal.

Adding a game does not automatically integrate it with publisher APIs, game servers, automated statistics, matchmaking modes or game-specific facilities elsewhere. Those existing modules retain their own supported-game rules. No unimplemented external service is represented by an operational admin control. A separate future implementation would be required for an external trusted audit anchor.
