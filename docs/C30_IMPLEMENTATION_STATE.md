# C-30 — Community home and invitations

MIPA internal implementation record. Owner request: 4 October 2026, Asia/Dubai. Canonical source: MAXIMUS-NPiO/maximus-vegas; commercial operator: MAXIMUS VEGAS L.L.C-FZ. This task remains part of the wider MAXIMUS ecosystem and does not appoint a partner, approve a tariff or launch a clinical service.

## Sources

- Current owner message: gamer feedback, community-as-home goal and urgent inability to find invited players, reserved names and recipient email.
- `EC-01-004170_Dating_App.pdf`, Library `libfile_26669b895cd48191b677d64dd88827dd`: all four scanned pages visually read. The certificate states “Dating Application of Gamers”, EC-01-004170, 14 November 2023; Maximus Kiriyakulov as author and MAXIMUS VEGAS L.L.C-FZ as nominal holder. The attachment cover says page 1 of 81; the full 81-page work is not in this four-page upload. No new registration or wider exclusivity is inferred. The original scan and signatures are not copied into the public repository.
- Existing implementations C-15, C-19–C-21, C-23–C-29 and their release records; fresh source `300c632a032f1010f1b362b8eacbc290b4a1475c`.

## Requirement coverage

| ID | Source requirement | Delivery / state |
| --- | --- | --- |
| R1 | Find invited players and reserved names from the account | Implemented `/my-teams`, direct account/hub/profile links, search and expanded delivery after reservation |
| R2 | Add a player; enter recipient email; distinguish codes | Guided username invitation/reservation and explicit manual delivery step; game IDs and membership referral codes remain separate |
| R3 | Home, belonging and a comprehensible, safe community | A community home around shared games, friends, teams and support; no assumption that all gamers are lonely or depressed |
| R4 | Global and team/alliance text chat | Implemented authenticated global/team/clan rooms, membership checks, avatars, report/block and independent moderation |
| R5 | Voice communication | Existing mutual private calls now support friends without dating profiles. Group audio code, scoped grants and cleanup worker are implemented; real Cloud audio and operational activation remain unverified |
| R6 | Friends and private messages | Implemented explicit friendship requests, on-site notifications and accepted conversations independent of dating discovery |
| R7 | Alliance as a unit; friendly alliances and rivalries | Preserve clans and consent-based clan wars; add bilateral clan relationships |
| R8 | Always-visible avatars, including personal photos | Extended the normalized media pipeline with privacy-scoped photo uploads; account, profile, directory, rosters, friends and chat display them |
| R9 | Voluntary flirting and natural relationships | Preserve separate opt-in dating; entry to the gaming community does not opt a person into dating |
| R10 | Women as community hosts | Transparently identified real hosts; recruitment/identity checks remain external. Hidden fabricated participants and orchestrated personal harassment are not implemented because they conflict with the owner's safe-home objective |
| R11 | ПСИХОЛОГИНЯ: conversations, stress/depression support and socialization | Distinct community-host and qualified-professional paths; no claimed depression treatment, invented practitioners or clinical availability. Provider qualifications, licensed service scope and operating readiness must be verified before bookings |
| R12 | Feel like a hero, social events and in-game competition | Clan identity, consensual matches and relationships; no targeting of distress, manufactured abuse or addiction-based retention |
| R13 | Existing copyright | Record the supplied certificate accurately alongside the prior MIPA source trace; preserve the original privately |
| R14 | Preserve existing portal | Additive data changes only; streaming/payment gates, games, memberships, private data, legal pages and official lion preserved |

## Current findings

Invitations and active reservations are only visible inside individual team pages. The account dropdown has no personal-teams/invitations link. The hub puts teams far below other sections, and the player directory has no invite action. The existing manual sharing component already has an email field, but it is only reachable after locating a reservation. This is a navigation/discoverability defect, not evidence that the owner's historical records were deleted. Acceptance uses disposable accounts, never production data.

The shared account worker reports a cost lock on autonomous external review. No paid review is submitted or bypassed; local and required CI verification remain the release gates. Full operational voice and professional-support activation must not be inferred from a software release.

## Verification and release gate

PR #33 implementation head `380590bfc47fbfec876bb1a66fa105a52ece70f4` passed CI run [37164932132](https://github.com/MAXIMUS-NPiO/maximus-vegas/actions/runs/37164932132): 328 tests with real PostgreSQL, zero skipped/failed, production build, 14 server-agent tests, six existing studio browser scenarios and nine new community browser/API scenarios. All browser accounts/data were disposable; no emails or provider calls were made. RU/EN desktop/mobile screenshots were retrieved and inspected. That inspection prompted a compact horizontal section navigation and removal of excess space in the reservation-search form. Final notification deduplication, bounded host applications and the PostgreSQL test's race setup were also tightened; the final head must pass the same required gate before merge.

The nine community scenarios cover unauthenticated denial, account-menu entry, old reservations, expanded email delivery/reload, responsive RU/EN layouts, existing-player invitation acceptance, friendship/private messages without dating consent, text chat/report/block, photo upload/block-aware media, empty professional directory and permission-policy boundaries. Group voice was checked at the domain/provider-adapter boundary only; real Cloud audio and a working minute scheduler remain activation requirements. No clinical provider is claimed active.

The supplied certificate is evidence of the recorded deposit; it is not a basis to claim ownership of all gamer dating concepts.
