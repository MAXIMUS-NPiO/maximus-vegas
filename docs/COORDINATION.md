# MAXIMUS VEGAS — task board and coordination record

Version 2.0 · 1 October 2026 · Protocol: `AGENTS.md`, section "Shared work protocol"

Canonical source: https://github.com/MAXIMUS-NPiO/maximus-vegas · Production: https://www.maximus.vegas, deployed from `main` by the existing Vercel project.

## State of `main`

Protected since 1 October 2026 for everyone, administrators included: pull request required, required check `check` (GitHub Actions, workflow "Quality checks"), branch must be up to date with `main`, force-push and deletion blocked. Auto-merge is enabled for the repository. Verified the same day by reading the branch protection through the GitHub API.

## Lanes

| Lane | Owns | Rule |
|---|---|---|
| `core` — platform and integrator | everything in `src/`, `tests/`, `scripts/`, `.github/` not listed below; database migrations in `src/server/schema.ts` (sole owner of migration numbers); `package.json` and the lockfile; release documents `docs/RELEASE_*.md`, `docs/ARCHITECTURE.md`, `docs/RUNBOOK.md`, `docs/MODULES.md` | merges ready pull requests of other lanes when `check` is green and their files stay in their lane |
| `exp` — experience and brand | home `src/app/[lang]/page.tsx`; `src/app/[lang]/arena.css`; pages `games`, `innovations`, `partners`, `help`, `contact` under `src/app/[lang]/` (presentation; data and forms stay `core`); `src/components/{arena-lobby,arena-sound,reaction-arena,icons}.tsx`; `src/lib/{arena-audio,game-artwork}.ts`; `public/**` (the lion is read-only); `src/app/icon.*`, web manifest; `docs/EXPERIENCE_ASSETS.json` | no server, database, payment or legal behaviour; new dependencies by request to `core` |
| `owner` — the owner's own signed commits | `COPYRIGHT.md`; any change of meaning in legal texts; brand source files | other lanes do not edit these |
| shared — minimal diffs, merge `main` first | `src/app/[lang]/styles.css`, `src/app/[lang]/layout.tsx`, `src/components/{header,footer}.tsx`, `src/lib/i18n.ts`, `src/lib/i18n-ext.ts`, `AGENTS.md`, this file, `docs/IP_RECORD.md`, `docs/RISK_LOG.md` | change only the lines the task needs |

## Board

Status: `open` → `in progress` (branch) → `done` (PR, verification). Take the first `open` row of your lane; a row marked `blocked` waits for what it names. Section numbers refer to the owner's specification of 27 September 2026.

| ID | § | Lane | Task | Done when | Status | Branch / PR |
|---|---|---|---|---|---|---|
| C-01 | 9 | core | Game Day screen for the participant: opponent, local time, readiness, roster, lobby or server details, referee contact, result, evidence, next match; the current state and the one available action explained | every match state (scheduled → completed, dispute, no-show, cancelled) renders on RU and EN at 390 and 1440 px; tests and e2e on a local database | done | #3 |
| C-02 | 25 | core | Bracket on phones: round-by-round match list instead of the scaled scheme below 640 px | no horizontal overflow at 390 px for single and double elimination, groups, Swiss, gauntlet | done | #4 |
| C-03 | 9 | core | Live operations: incident queue with assignee, priority and escalation; pause and resume of a match or event; documented override with reason; bracket repair after a result correction with a preview of affected matches | an incident goes from report to closure; a correction lists affected matches before it applies; audit chain valid; tests | done | #5, #6 |
| C-04 | 8 | core | Chains of three or more stages, e.g. Swiss → groups → playoff | a three-stage event finishes on saved data; places and history survive reload; upgrade test from release 6 | open | |
| C-05 | 10 | core | Party, ready check, LFG and LFT posts, roster vacancies with applications, scrims, rating history | a party enters the queue atomically; an expired ready check returns everyone to the queue; tests | open | |
| C-06 | 17 | core | Sanctions and appeals: rule, evidence, confidence, decision, appeal; public trust page with rules and anonymised counts | a sanction is issued and appealed end-to-end; the public page shows no personal data | open | |
| C-07 | 21 | core | Partner API keys, signed webhooks with retry and replay protection, embeddable widgets: bracket, registration, calendar, standings | a widget renders on a third-party page; a replayed webhook is rejected; tests | open | |
| C-08 | 14 | core | Venues and QR check-in with expiry and single use | a reused or expired QR is rejected; only confirmed venues are public | open | |
| C-09 | 22 | core | Staff roles (support, moderation, referee, finance, compliance, analytics, marketing, infrastructure); messages with segments, consent and frequency caps; feature flags and maintenance mode | each role sees only its sections; a marketing message respects consent and cap | open | |
| C-10 | 13 | core | Media data: streams per event and match, VOD links, organiser broadcast assignment, overlay data from real results | the organiser assigns a stream and the match page shows it | open | |
| C-11 | 11 | core | Academy data: programmes, verified coaches, booking requests, sessions, progress records | a booking request reaches the coach's queue | open | |
| C-12 | 12 | core | Assistant framework: switchable provider, explicit "unavailable" state, action log, spend limit, injection boundary; first use: organiser drafts a tournament from a request and confirms it | without a provider key the module says it is unavailable | blocked: O-06 | |
| C-13 | 9 | core | Map veto by the event's rules (pick and ban order per series length, map pool per game) on the match and Game Day screens | a Bo1 and a Bo3 veto complete in order on saved data; out-of-turn and repeated picks are refused; tests | open | |
| E-01 | 14, 25 | exp | Installable web app: manifest, icons from the unchanged lion, offline page | installs on Android Chrome; added to the iPhone home screen it opens full-screen | open | |
| E-02 | 25 | exp | SEO audit: canonical, hreflang and noindex on every route (helpers exist in `src/lib/meta.ts`, `src/app/robots.ts`, `src/app/sitemap.ts`); structured data only where true | list of routes checked in the PR; no private page indexable | open | |
| E-03 | 25 | exp | Accessibility of public pages and the shared layout: keyboard focus, contrast, reduced motion, labels; loading, empty and error states | zero serious or critical axe findings on home, games, tournament list and a tournament page; reduced motion stops arena animation | open | |
| E-04 | 25 | exp | Performance: image sizes and formats, lazy loading of heavy experience modules | LCP and CLS before and after in the PR, measured on the same pages | open | |
| E-05 | 21, 23 | exp | Partners and Innovations pages: clear scenarios, working / integration / research split from `src/lib/directions.ts`, no new claims | RU and EN; every statement traceable to the module registry or the owner | open | |
| E-06 | 6 | exp | Visual consistency of feature pages (profile, team, tournament list) through shared styles only | screenshots at 390 and 1440 px before and after; no markup or data change in `core` files | open | |
| E-07 | 13 | exp | Live centre and media pages over the C-10 data | as C-10, plus RU and EN screens | blocked: C-10 | |
| E-08 | 11 | exp | Academy pages over the C-11 data, confirmed coaches and venues only | as C-11 | blocked: C-11 | |

## Needs the owner

Workers do not wait on these: they finish everything that does not depend on them and state the exact remainder.

| ID | What | Unblocks |
|---|---|---|
| O-01 | Email delivery: `MAIL_FROM` and `RESEND_API_KEY` (sending domain verified with the provider) or `SMTP_URL`, set in the Vercel project for Production | email confirmation, password recovery |
| O-02 | Confirmation of the disqualification, cross-group and FFA ordering rules | final wording of those rules |
| O-03 | Publisher API access and sign-in applications (Steam, Riot, PUBG, Google, Epic) | automatic result checks, social sign-in |
| O-04 | Approved offer terms and payment provider account | online membership payments |
| O-05 | Confirmed venues, academies, coaches and partners: names, addresses, photos, statuses | public venue, academy and partner listings |
| O-06 | Assistant provider key and monthly spend limit | C-12 |

## Requests between lanes

Add a row; the addressed lane answers before starting new work and sets the status.

| # | From → to | Request | Files | Status |
|---|---|---|---|---|
| 1 | core → exp | Signed-in header overflowed 12 px at 390 px after the sound button joined the header: `arena.css` sets `.header-actions { gap: 8px }` up to 1150 px. Core added a ≤420 px rule in `styles.css` (`.site-header .header-actions` gap 2 px, `.site-header .header-inner` gap 10 px); no horizontal scroll at 390 px for guests and signed-in users. Exp may move or refine it in `arena.css`. | `src/app/[lang]/styles.css`, `src/app/[lang]/arena.css` | done by core; open for exp |

## Done

| Date | Lane | Pull request | Result and verification |
|---|---|---|---|
| 2026-10-01 | exp | #1 | Visual arena, MAXIMUS-led brand, contextual sound, local reflex warm-up. Typecheck and build passed; 127 tests passed, five PostgreSQL-only tests skipped; browser check on the preview: RU and EN home, images, game selection, mute kept after reload, warm-up rounds; official lion blob `d7527973c9a7fc26bc4ed40f37b48638a8978a2d` unchanged; server code, tests and lockfile unchanged. |
| 2026-10-01 | core | #6 | C-03 part 2, bracket repair: correcting a decided elimination match after later matches were played — the consequences (replace, replay, emptied places, removed reset, reopened event) are previewed on the match page and applied in one transaction only if the bracket is unchanged since the preview; superseded versions kept, entrants notified, plan logged. `npm run check` (163 tests), e2e with a replayed final. |
| 2026-10-01 | core | #5 | C-03 part 1, live operations: incident queue on the organiser page (staff kinds, priority, assignee from the event's staff, escalation to the space's owners and administrators, resolution with a reply), an unanswered participant call escalates on repeat after 5 minutes, match pause and resume that hold results, confirmations, check-ins and no-shows, a documented reason for referee decisions against a reported score or on a dispute (migration 11). `npm run check` (153 tests), PostgreSQL 16 tests, e2e with pause and queue steps, rollback on a database at migration 11. Part 2 (bracket repair with a preview of affected matches) follows. |
| 2026-10-01 | core | #4 | C-02 Bracket on phones: below 720 px each bracket is a list of rounds with chips (played / total, the round being played, the viewer's rounds), finished rounds folded, the viewer's matches highlighted and linked, match time on open matches; desktop columns unchanged. Bracket height at 390 px: 32-entrant single elimination 3 913 → 1 856 px, 16-entrant double elimination 4 353 → 2 673 px, 16-entrant groups with playoff 4 627 → 2 499 px; no horizontal overflow for single and double elimination, groups, Swiss and gauntlet. `npm run check` (149 tests), e2e on a local build with the new phone-list checks. |
| 2026-10-01 | core | #3 | C-01 Game Day: `/gameday` screen of the player's current events with the state explained and the one action available, referee calls with replies (migration 10, `incidents`), personal step on the match page, hub and account-menu links. `npm run check`; 10 new tests plus 1 PostgreSQL test of parallel calls, all PostgreSQL-only tests run on PostgreSQL 16; e2e on a local build (Game Day block plus the full scenario); screenshots at 390 and 1440 px with no horizontal overflow; previous code verified on a database at migration 10. |
| 2026-10-01 | core | this record | `main` protection and repository auto-merge on, lane protocol, board, pull request template, repository guards in `tests/guards.test.ts`. |
| to 2026-10-01 | core | releases 1–6 | `docs/RELEASE_*.md`, module registry `docs/MODULES.md`. |
