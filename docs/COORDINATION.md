# MAXIMUS VEGAS — shared execution record

Status: IN PROGRESS | Version: 1.0 | Date: 2026-10-01

Canonical source: https://github.com/MAXIMUS-NPiO/maximus-vegas
Production: https://www.maximus.vegas
Production branch: main; existing Vercel project: maximus-vegas-landing.

## Current task

Owner requested a consistent MAXIMUS-led logo, a visual interactive gaming entrance, welcome feedback, contextual sounds, and safe cooperation between Claude and Codex.

Implementer: Codex. Branch: codex/vegas-immersive-sync-20261001.
Starting main: 823c45be1c9aaf501fa914155619e8edb9a65722.
Scope: home page, shared brand styling, local audio preferences, optional local reaction warm-up, game imagery. Server, database, payments and tournament engines are outside this change.
Expected shared files: AGENTS.md, src/app/[lang]/page.tsx, src/app/[lang]/styles.css, src/app/[lang]/layout.tsx, src/components/header.tsx. New files: isolated experience components, audio code and public/experience assets.

## Coordination boundary

CLAUDE.md imports AGENTS.md. This provides common on-disk instructions; it does not send a message into an already-running Claude session. The current Claude session, its uncommitted changes and any acknowledgement are NOT PROVIDED. Remote commits and pull requests are the verifiable handoff mechanism. All editors must fetch and read this record before continuing.

The selected Sites project appgprj_6ab8009a10848191a9be92fc40996593 contains a separate older CS2 platform at f9b61ea202671cca7362ff2c02c879ee19ceda18. Do not copy it over this repository or migrate its D1 data into production without a separately reviewed migration. Preserve its existing accounts/data; make its relationship to the main portal explicit.

## Requirement coverage

| ID | Requirement | Implementation / verification |
|---|---|---|
| R1 | Do not overwrite concurrent work | Isolated branch; latest-main comparison; PR with expected-head merge; no force push |
| R2 | Find GitHub/Claude connections | GitHub and existing Vercel deployment identified; CLAUDE.md imports AGENTS.md; live Claude session unavailable |
| R3 | MAXIMUS-led, consistent logo; no oversized purple VEGAS | Shared brand CSS, unchanged official lion |
| R4 | Visual gaming platform | Original arena background, actual game art, direct gameplay/tournament links |
| R5 | Interactive, living experience | Game selection and optional local reaction warm-up |
| R6 | Contextual sound for buttons | Global audio layer; distinct launch/select/menu/confirm/cancel cues; mute preference |
| R7 | Welcome on arrival | Visible welcome immediately, welcome chime after first gesture; no forced autoplay |
| R8 | Preserve existing platform | Backend untouched; existing functionality and catalog routes retained |
| R9 | MIPA internal record | Append actual files, provenance and verification to docs/IP_RECORD.md; no invented registration number |

## Open limitations

Browser audio requires a user gesture. Sound availability depends on device/browser settings. Warm-up scores are device-local and never become ranked results or XP. Existing payment activation conditions remain unchanged.
