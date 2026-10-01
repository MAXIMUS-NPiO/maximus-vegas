<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Brand requirements

- Use only the official MAXIMUS VEGAS logo supplied or identified by the owner. Do not generate, redraw, substitute, or invent a lion or another brand symbol.
- The existing lion is `public/brand/maximus-lion.jpg`, copied unchanged from the owner's `LION ROUND LOGO.jpg` and visually matched to `LeoLogo2.pdf`. Preserve its geometry and circular frame. The same source is used for the favicon.
- Owner correction, 1 October 2026: MAXIMUS is the primary word. VEGAS is subordinate, with the same type family and a neutral colour. Do not enlarge VEGAS to match MAXIMUS's width, make it heavier, or colour it purple. This replaces the earlier equal-width instruction. Never stretch or squash letters.
- Preserve the approved slogan: "MAXIMUS VEGAS — Vegas для своих". Keep its original wording on both locales until the owner provides an approved translation.

## Shared work: Claude and Codex

- Canonical production source: this GitHub repository. `main` deploys to www.maximus.vegas through the existing Vercel connection. The older ChatGPT Sites project is a separate implementation and database, not a mirror of production.
- Read `docs/COORDINATION.md` and inspect current remote branches and open pull requests before editing. Work on a separate task branch; never force-push, replace the repository, reset another worker's changes, or push directly to main.
- Publish work through a pull request. Fetch main immediately before integration, merge any new commits, inspect overlapping files, and rerun affected checks. Merge only the expected PR head after checks pass. A local checkout or coordination document is not an exclusive lock on other running sessions.
- Preserve existing account, tournament, payment, database and legal behaviour during presentation work. Keep the official lion byte-for-byte unchanged.
- Update the coordination record, requirement coverage, verification and MIPA internal IP record with the actual result. Never claim another agent has acknowledged work without evidence.
