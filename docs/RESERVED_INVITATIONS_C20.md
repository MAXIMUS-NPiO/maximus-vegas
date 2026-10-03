# Reserved player invitations C-20
Owner request, 3 October 2026.
R1: distinguish an invitation to a registered account from a future-player reservation.
R2: reserve the normalized unique username and preserve it through registration.
R3: a personal link can be shared by email, WhatsApp, Telegram, SMS and native share/copy. The sender chooses the recipient in their app; creation or opening a composer does not mean a message was delivered.
R4: retain owner attribution in IP_RECORD.md without claiming formal registration.
Implementation choices: seven-day reservation, up to twenty live reservations per inviter, cancellation by team leaders. The link is a bearer invitation; share privately. Existing usernames cannot be reserved. A claimed reservation creates a pending team invitation; acceptance remains the player's decision.
Database migration 26 is additive. Both instant and email-first registration honour reservations. Export includes reservation records without link tokens; account erasure removes personal reservation rows.
Verification: targeted database tests PASS; RU/EN browser scenario PASS (all game names, extra name, removal, reservation, registration and voluntary team acceptance). Publication pending required CI.
