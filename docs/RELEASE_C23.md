# C-23 — Navigation and gaming invitations

The growing navigation no longer fits reliably into a single desktop row. Keep the brand and account actions together and put the section groups in a second row above 960 px. Below that breakpoint, anchor the scrollable navigation below the actual header. Narrow-screen spacing preserves the official logo and wordmark hierarchy. Opening the account menu dismisses the mobile navigation, and opening navigation dismisses the account menu. Escape closes the menus and restores focus; an outside click dismisses them.

Reserved-name invitations now offer Discord and Steam. The captain copies the complete invitation, opens the selected app, chooses a recipient and confirms sending there. The outgoing app links contain no invitation token. Clipboard failure selects the complete text for manual copying. Email, WhatsApp, Telegram and SMS remain available. No automatic message or delivery claim is introduced.

## Verification

- `scripts/navigation-invites-smoke.mjs` passed in a real local browser on an isolated local PGlite database. It checks guests and signed-in users in RU/EN at widths 360, 390, 768, 960, 961, 1024, 1280 and 1440; visible menu bounds, dropdown exclusivity, Escape, outside-click dismissal and desktop anchor offset.
- The same script creates a local team and reserved username, verifies the full Discord/Steam clipboard text and safe app links, exercises clipboard refusal and manual selection, and checks the existing email/WhatsApp/Telegram links. No external message was sent.
- Desktop appearance inspected at 1440 px. The official lion file is unchanged.
- `npm run check` passed: type checking, 244 passing tests, 9 PostgreSQL-only tests skipped, zero failures, and the production build. The PostgreSQL-only suite was not rerun for these client-side changes. No production database was used for testing.

The wider five-work implementation review is preserved in `docs/FIVE_WORKS_IMPLEMENTATION.md`. This release does not claim to deliver the outstanding Dating, streaming, blockchain or recurring-mission modules.
