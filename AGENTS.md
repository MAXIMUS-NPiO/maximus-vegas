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

## Shared work protocol

Several independent workers change this repository, and none of them can see another's session. The repository is the only channel: this file, `docs/COORDINATION.md` (task board, lanes, requests between lanes) and pull requests. Every worker follows the same steps.

`main` is protected for everyone, administrators included: a change reaches it only through a pull request whose head passed the `check` job and is up to date with `main`; force-push and deletion of `main` are blocked. Every merge deploys www.maximus.vegas, so a merge is a production release.

1. **Start.** `git fetch origin`, read `docs/COORDINATION.md`, list open pull requests and remote branches. Answer requests addressed to your lane first. Then take the task the owner gave you, or the first `open` task of your lane on the board.
2. **Claim.** Branch from fresh `origin/main` as `<lane>/<task-id>-<slug>` (lanes: `core`, `exp`, `owner`). The first commit sets the board row to `in progress` with the branch name; push it and open a draft pull request at once. A pushed branch or an open pull request carrying a task ID is a claim: never work on a claimed task, add a request instead.
3. **Build** inside your lane's paths (board, "Lanes"). In a shared file change only the lines your task needs: no reformatting, renaming or reordering. Only the `core` lane appends database migrations; other lanes ask for them in the Requests table.
4. **Integrate.** Merge fresh `origin/main` into your branch (never rebase or force-push a pushed branch), keep both sides' intent when resolving conflicts, run `npm run check`. Mark the pull request ready. Once `check` is green, squash-merge it with the expected head SHA, or turn on auto-merge with squash; the squash title is the pull request title. A worker that cannot merge leaves it ready: the `core` lane integrates ready pull requests whose `check` is green and whose files stay in their lane, and records in the Requests table why it did not.
5. **Behind or red.** If the pull request falls behind `main`, merge `main` into it again and wait for `check`. Never bypass or weaken a failing check: fix it, or leave the pull request open with the reason in its description.
6. **Close.** Set the board row to `done` with the pull request number and the verification actually run, in the same pull request or a small board-only one. Record new original material in `docs/IP_RECORD.md`.

Content rules for every file, commit, branch name, pull request title and description:

- No names of the tools, models or vendors that produced the work, and no co-author or "generated with" lines. The commit author is the owner (for example `MAXIMUS-NPiO <info@maximus.ltd>`). `tests/guards.test.ts` fails on co-author lines.
- No secrets, tokens, `.env` values, identity documents, bank details or signatures.
- No gambling, betting or real-money game mechanics.
- Tests and end-to-end scripts never run against the production database; preview deployments use their own database.
- Preserve behaviour outside the task: accounts, tournaments, payments, database and legal texts. Keep the official lion byte-for-byte unchanged (checked by `tests/guards.test.ts`).
- Never claim that another worker received, read or accepted anything without a link to the evidence.

Canonical production source: this repository; `main` deploys to www.maximus.vegas through the existing Vercel project. The older Sites project is a separate implementation with its own database, not a mirror of production: never copy it over this repository or move its data without a separately reviewed migration.
