# C-31 acceptance gates

These commands are reviewed project checks. A checked item records the observed result, not a guarantee about an external service. Run against isolated test databases only. Existing release checks remain mandatory.

- [ ] G1: Recipient, sending, duplication, expiry, revocation and account privacy behave correctly
  CHECK: node --experimental-strip-types --test --test-reporter=tap tests/team-invitation-delivery.test.ts
  EXPECT: # fail 0
  EVIDENCE: pending

- [ ] G2: External ownership, import, refresh, consent and erasure behave correctly
  CHECK: node --experimental-strip-types --test --test-reporter=tap tests/player-experience.test.ts
  EXPECT: # fail 0
  EVIDENCE: pending

- [ ] G3: The complete application passes types, regression tests and production build
  CHECK: npm run check
  EXPECT: Generating static pages
  EVIDENCE: pending

- [ ] G4: Real PostgreSQL concurrency and all three browser suites pass on the proposed release
  EVIDENCE: pending

- [ ] G5: RU/EN invitation and experience screenshots are inspected at 390 and 1440 pixels
  EVIDENCE: pending

- [ ] G6: Published commit, deployment and public route behavior match the verified release
  EVIDENCE: pending

## Separate installation outcome

The optional workflow package requested in the attachment was inspected and validation was attempted. Persistent installation was rejected by the automatic safety scan without a detailed reason. It was not installed and no bypass was attempted. The project checks above run directly; they do not depend on that package.

## Example for a contained task

For an invitation change, G1 is the smallest concrete example: the command exercises stored outcomes, recipient mismatch, idempotency, cancellation and verified acceptance; both zero exit and the success-only zero-failure summary are required. PostgreSQL cases run only when the isolated `PG_TEST_URL` is set. A skipped case must not be reported as passed.
