# C-31 — invitations and existing player experience

Date: 4 October 2026. Canonical implementation: this repository. PR #34.

The owner's latest amendment adds contextual invitation entry points and requires the recipient to be collected before sending. It preserves the earlier community, streaming, retention and verified-support scope. MAXIMUS remains an ecosystem; selected import sources are an implementation starting set, not a narrowed long-term strategy.

## Source inventory

| Source | Role | Read / limitation |
|---|---|---|
| Owner message, 4 October 2026 | Multiple invitation menus; accurate send; external experience and synchronization | Complete current message |
| Attached six-page workflow PDF | Install the referenced workflow, task decomposition, gates and independent parallel work | Full extracted text; relevant layout inspected; upstream README and workflow references read |
| `AGENTS.md`, coordination board, C29/C30 state | Canonical code, brand, protected release and preserved scope | Read before claim; fresh main `861933e0142025a00f6950e9a5b1b0f3f5309812` |
| Provider documentation | Exact supported source fields and identity contracts | Current primary references in `PLAYER_EXPERIENCE_PROVIDERS.md` |

## Contract coverage

| ID | Required outcome | Implementation / observation | State |
|---|---|---|---|
| R1 | Invitation stays at hand in several relevant menus | Account menu, hub, community, team directory, team roster and player profile; team/player defaults preserved | Implemented; browser verification pending |
| R2 | Recipient before explicit send; no hidden second email step | Shared composer on team desk and roster; optional nickname in the same email flow; existing-player delivery mode | Implemented; browser verification pending |
| R3 | Exact delivery and response; reliable duplicate/cancel/expiry behavior | Durable private delivery record and outbox; request identity; recipient matching; provider acknowledgement separate from acceptance; atomic response guard | Implemented; regression verification pending |
| R4 | Experienced players bring their existing status | Steam identity; supported source adapters; sourced rank/playtime/match passport; directory badges; local zero-XP label is New member | Implemented; verification pending |
| R5 | Synchronization preserves consent and privacy | Source-specific consent and sharing, bounded refresh/leases/budgets, stale/private/error states, export and disconnect/erasure | Implemented; verification pending |
| R6a | Install the supplied optional workflow package | Automatic safety scan rejected persistent installation; no detailed reason or bypass | Blocked; package not installed |
| R6b | Use a task tree, independent work and observable acceptance | Two disjoint implementation leaves; root integrates and independently verifies; `GATES.md` contains reproducible commands | Implemented; evidence pending |
| R7 | Preserve prior features and prove release behavior | Required full check, PostgreSQL tests, studio/community/player browser suites, official lion guard, deployment verification | Pending |
| R8 | Owner follow-up: audit mistakes and finish previously started work | Additional review of C29/C30/C31; existing full HTTP journeys and browser smoke added to the required job | In progress |

## Operating boundaries

Production environment metadata was read without revealing values. Email credentials, Steam Web API and FACEIT API credentials were absent. Emails therefore stay visibly queued; on-site invitations work independently. A saved reservation, opened email app or service acknowledgement is never described as human receipt. Future email activation must use a verified sending domain. No test message is sent to a real recipient.

Steam ownership verification does not require the Steam Web API key. The OpenDota adapter uses available public Dota 2 data after that verification and explicit consent. This is source-attributed third-party history, not a publisher certification or a universal cross-game rank. Steam playtime and FACEIT imports remain unavailable until their operator credentials are configured. Other games/providers remain extension work; unsupported sites are not scraped or advertised as connected.

Synchronization uses a daily bounded background batch and a bounded due-source refresh when the owner visits the experience page. It targets one-day freshness subject to source availability, request budgets and queue size; it does not promise every inactive account is refreshed daily. Manual refresh is available with a cooldown. Production scheduled-job authentication was configured as a sensitive server-only setting; no value is recorded here.

The attached package's installation is a separate blocked outcome. Implementation and standard verification continue directly; this record does not represent the package as installed or as an enforcement guarantee.

## Acceptance evidence

Pending the final integrated check, CI browser screenshots and published deployment. Evidence and remaining limitations must be updated before marking the coordination row done.

## Audit of previously started functions

The 4 October follow-up expands review to the existing platform journeys. The release preserves and checks registrations, onboarding, tournaments, teams, clans, account operations and staff MFA through the existing HTTP and Chromium scenarios on a fresh loopback database. All three database URL aliases are cleared; SMTP, API mail and paid-media credentials are disabled in that environment. No acceptance script may target a remote server.

| Function | Implemented work | Remaining operational dependency |
|---|---|---|
| Team invitations | One recipient-first send, on-site receipt, exact delivery/response, expiry and cancellation | Real email requires a verified sending domain and SMTP or API mail credentials |
| Player history | Verified Steam ownership and source-specific imports, consent, visibility and refresh | Player authorizes their own account; Steam playtime and FACEIT require operator API keys |
| Text community | Public/team/clan text rooms, friendship, private messages, avatars and moderation | Existing account and membership permissions apply |
| Group voice and native paid broadcasts | Scoped media lifecycle, paid entitlement, user-selected retention, cleanup and privacy | Media provider, suitable minute scheduler; broadcasts also need private storage, merchant configuration and approved tariff |
| Community hosts and professional support | Transparent application/review and approved-provider directory | Real qualified providers and reviewed operating arrangements; no invented availability |
| Optional attachment package | Inspected; ordinary project acceptance remains active | Installation safety scan rejected persistence; package is not installed |

Production metadata confirms only scheduled-job authentication is currently configured among the new mail/media/import service settings. Software acceptance does not activate missing services.
