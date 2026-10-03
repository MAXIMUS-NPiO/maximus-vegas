# Five Works of Science — implementation record

Reviewed 3 October 2026 against portal main `a15cc7fa507b9bec0799f5d2e330c26d15d48e07` and the owner-supplied documents. C-23 changes navigation and invitation sharing; it does not change the server modules assessed below. All five works are available. Their presence, registration identifiers and described architecture do not establish that every described product is deployed.

## Requirements and current implementation

| Work and source | Preserved requirement | Existing portal basis | Remaining implementation |
|---|---|---|---|
| Dating Application of Gamers — `WOS-EC-01-004170.pdf`, pp. 66–68 | Separate gaming and relationship preferences; discovery; mutual likes; messaging after a match; reporting and blocking | Accounts, public player profiles, team finder, scouting and invitations (`src/server/finder.ts`, `scouting.ts`, `conduct.ts`) | Opt-in dating profiles and consent, preference filters, likes and mutual matches, restricted conversations and dating-specific safety flow. Team invitations are not a dating match. |
| Maximus Pass — `WOS-EC-01-004171.pdf`, pp. 64–72 | Free/premium progression, personalized daily/weekly/seasonal missions and rewards | XP, ranks, cosmetic/non-cash rewards, one-time objectives, protected reward claims (`src/server/progression.ts`, `src/app/[lang]/progress/page.tsx`) | Recurring time windows, mission history and idempotent completion, season rollover, personalization and physical-reward fulfilment. Venue QR check-in alone is not the Pass. |
| Method of Statistics and Funds Transferring into Web 3.0 Environment — `WOS-EC-01-004172.pdf`, pp. 67–69 | Statistics and transparent transfer history; described coin packages, event tickets and smart contracts | Confirmed results, rankings, internal ledger, audit chain, partner API and signed webhooks (`src/server/scoring.ts`, `leaderboard.ts`, `audit.ts`, `partner-api.ts`) | Wallets, chain adapter, oracle and contracts are not implemented. A hash-linked audit log is not a blockchain. Source provisions for paid coins/entries are retained as requirements requiring reconciliation with the approved no-real-money game boundary; they are not enabled. |
| Peer To Peer (P2P) Cloud Gaming and Servers — `WOS-EC-01-004173.pdf`, pp. 61–65 | Shared CPU/GPU resources, allocation, host rewards, sessions and security | Direction description and partner application intake (`src/lib/directions.ts`, `src/server/partner.ts`) | Host enrolment, fleet controller, resource allocator, signalling, streaming lifecycle and operational security. Intake does not provide playable streaming. |
| Method of Integration of Offline and Online Gaming Activities — `WOS-EC-01-004174.pdf`, pp. 53–58 | Clubhouses, physical events, talent development, mentorship and connection to online activity | Verified venues, expiring single-use QR check-in, tournament calendar, coaches, booking requests and training records (`src/server/venues.ts`, `academy.ts`) | Clubhouse client, station reservations, general event RSVP and offline scan synchronisation; confirmed operating partners and fulfilment for physical experiences. |

## Source reuse and dependencies

The supplied `technical-en.pdf` (local indexed filename `01-technical-en.pdf`) describes P2P services in section 7, a game-side anti-cheat agent in section 8, Clubhouse in section 15.2 and a separate Dating service/client in section 15.3. These descriptions are preserved as integration evidence, not treated as inspected source code. The portal's statistical flags, reports, sanctions and appeals do not implement the described game-side anti-cheat agent.

No Gitea URL or accessible archive of those separate implementations was found in the reviewed documents, repository or relevant local project folders. Reuse of them needs a concrete repository URL with read access, or an exported source archive. This does not block work within the present portal. Existing runtime email, payment and publisher credentials were not established by this source review; absence from code must not be presented as proof that deployed credentials are missing.

## Next independent increment

Implement recurring Pass missions from confirmed matches and venue attendance using explicit daily/weekly time windows, exactly-once reward records and visible mission history. Keep the existing non-cash reward model. Preserve season and personalization requirements for subsequent increments. Physical rewards require confirmed partners and fulfilment rules. This is a proposed next increment, not a delivered feature.

The official brand, approved slogan and project-wide requirements in `AGENTS.md` continue to apply. The scientific-work identifiers above identify supplied source documents; this record makes no new claim of registration, novelty or exclusivity.
