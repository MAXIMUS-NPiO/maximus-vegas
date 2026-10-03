# C-22 — Public skins catalogue, simulated transactions and arbitration
Version 2.0 — 3 October 2026. PR #25. Publication requires protected-branch checks.

## Owner requirements
Public skins marketplace, mandatory transaction disputes and general platform arbitration. Owner explicitly authorised simulated payment and transfer on 3 October 2026 while real integrations are prepared. Private-only drafts were rejected. The invitation flow must immediately offer recipient and channel after reserving a username. Preserve unlimited distinct game nicknames and earlier automatic image handling.
Sources: current owner instructions supersede Banger_Games_MVP_Developer_Requirements.docx section 11 (marketplace previously deferred); relaunch plan Phase 4. Prior investment arbitration project identity remains unconfirmed.

## Implemented scope
Public catalogue and per-game filter, seller handle, price, publish/unpublish. Existing private drafts remain private unless their owner explicitly publishes them.
Buyer requests a TEST transaction; seller accepts; buyer simulates payment; seller simulates delivery; buyer confirms test receipt. Immutable order price/item snapshot survives listing deletion. Different actor checks on each transition; retries cannot repeat payment; one active request per buyer/item.
Simulation is prominently labelled. No real money, seller payouts, card data, inventory authentication or item transfers. No conversion of demo records into live payments.
A dispute links both parties and the simulated order in one transaction. It blocks subsequent order actions. The case supports statements, evidence links, staff MFA, reasons and appeal to a different reviewer. Decisions currently record the resolution; they do not transfer money or skins or automatically release a disputed simulated order.
General cases also cover teams, tournaments, accounts and other disputes; existing match disputes and conduct appeals remain separate.
Staff response-period rule: 72 hours, earlier decision allowed after the other party responds. Appeals receive a fresh response period. One appeal round. Not a legal service-level promise or a claim to be a licensed arbitral institution.
Evidence digests record stored submission integrity, not authenticity of external links. Links are not archived.
Export includes cases, listing drafts and demo orders. Erasure removes drafts, cancels unstarted demo orders, redacts the author's statements and links, and uses existing account anonymisation for retained operational records.
Additive migrations 27 and 28.

## Invitation correction
After a free username is reserved the page scrolls to its recipient step. It explicitly says the invitation has not been sent. Channel selector: email, WhatsApp, Telegram, SMS, copy. Email/phone must be valid before the compose link appears. The user confirms sending in the selected app; opening an app is never reported as delivery. Existing registered users still receive an internal invitation. No external message was sent during implementation or tests.

## Verification
Initial private-draft/arbitration implementation passed npm run check and real browser forms.
Current targeted tests cover public publication, duplicate concurrent requests, actor permissions, simulated transitions, dispute hold and preserved snapshots.
scripts/verify-c22.mjs covers public listing to simulated receipt and arbitration through real forms; reservation to email/phone/channel; RU/EN at 390 and 1440px; browser errors and guest privacy. No tests use production data.
Final full check and production read-only confirmation must complete before release is reported.

## Remaining delivery
Real authenticated inventory, ownership/tradability checks, listing moderation, one-asset live reservation across buyers, approved marketplace merchant and payment provider, signed idempotent events, ledger/reconciliation, provider-confirmed transfers, refunds, payouts and dispute-driven settlement.
Existing Stripe Checkout code serves membership billing; it has not been connected to skin commerce. It must not be treated as a live marketplace payment service.
The six-frame fantasy-fashion storyboard is a visual concept, not implemented website styling. Real marketplace screens currently use the portal design system.
Comprehensive whole-platform player audit remains outstanding. Source review shows profiles, teams, finder/scouting, parties, tournaments and conduct already exist; new flows verified here do not certify every existing button.
Reference examined: FACEIT Party Finder supports party discovery and skill/language/country criteria with a queue handoff: https://support.faceit.com/hc/en-us/articles/14996733545884-Intro-and-overview-of-Party-Finder
