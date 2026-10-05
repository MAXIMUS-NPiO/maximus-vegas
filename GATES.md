# C-31 acceptance gates

These commands are reviewed project checks. A checked item records the observed result, not a guarantee about an external service. Run against isolated test databases only. Existing release checks remain mandatory.

- [x] G1: Recipient, sending, duplication, expiry, revocation and account privacy behave correctly
  CHECK: node --experimental-strip-types --test --test-reporter=tap tests/team-invitation-delivery.test.ts
  EXPECT: # fail 0
  EVIDENCE: CI 37167622943: all 17 invitation tests passed with PostgreSQL; recipient-first acceptance, wrong-account denial, cancellation and status refresh also passed in Chromium.

- [x] G2: External ownership, import, refresh, consent and erasure behave correctly
  CHECK: node --experimental-strip-types --test --test-reporter=tap tests/player-experience.test.ts
  EXPECT: # fail 0
  EVIDENCE: CI 37167622943: all 13 experience tests passed with PostgreSQL; sharing withdrawal and disconnection passed in Chromium. Live provider sign-in is not claimed.

- [x] G3: The complete application passes types, regression tests and production build
  CHECK: npm run check
  EXPECT: Generating static pages
  EVIDENCE: CI 37167622943 on 5b463f23993ff21a0231269fc7d4255814255da4: 358/358 tests, zero skips/failures, typecheck and production build.

- [x] G4: Real PostgreSQL concurrency and the three feature suites and complete platform journeys pass on the proposed release
  EVIDENCE: CI 37167622943: six studio, nine community and seven invitation/experience scenarios; full existing HTTP e2e and browser smoke including staff MFA; 14 server-agent tests.

- [x] G5: RU/EN invitation and experience screenshots are inspected at 390 and 1440 pixels
  EVIDENCE: Twelve player screens from player-acceptance artifact 11289841655 inspected; RU/EN invitations, experience and public profile at 390/1440 px. Studio and community screens also inspected. No horizontal overflow or browser/server errors.

G6: Published commit, deployment and public route behavior must match the verified release.
  EVIDENCE: This post-merge gate is recorded in the Deployment verification section of [PR #34](https://github.com/MAXIMUS-NPiO/maximus-vegas/pull/34), after checking the published commit and public routes. Pre-merge CI does not assert deployment success.

## Separate installation outcome

The optional workflow package requested in the attachment was inspected and validation was attempted. Persistent installation was rejected by the automatic safety scan without a detailed reason. It was not installed and no bypass was attempted. The project checks above run directly; they do not depend on that package.

## Example for a contained task

For an invitation change, G1 is the smallest concrete example: the command exercises stored outcomes, recipient mismatch, idempotency, cancellation and verified acceptance; both zero exit and the success-only zero-failure summary are required. PostgreSQL cases run only when the isolated `PG_TEST_URL` is set. A skipped case must not be reported as passed.

The protected check job must pass again on the exact final PR head after this evidence update. Provider operation and the blocked attachment-package installation remain separate outcomes.
