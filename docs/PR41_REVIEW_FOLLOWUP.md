# Local PR41 review follow-up

Baseline: `91afe7bb38e8c5ea15a0548daed60655f0d14d4a`. Prepared in a separate local worktree on `local/pr41-review-races-20261006`; existing PR ownership and the earlier checkpoints are preserved. No push, PR creation, merge, deployment, production data read/migration, PostgreSQL installation, provider activation or system/security configuration changes are authorized here.

| Requirement | Local change | Acceptance |
|---|---|---|
| Reviewer must decide the score they actually saw | Every organizer review form carries expectedRevision; API forwards it; service requires a positive revision and compares after tournament/entry locks before any side effect | v1 rejected, v2 corrected: stale approve and reject fail; pending and zero XP remain; current v2 succeeds; separate real PostgreSQL interleaving case |
| Legacy blank references must remain reviewable | Append-only migration47 replaces the NOT VALID check with an insert/reference-change trigger. Unchanged historical blanks survive updates. No references invented | upgrade from43 with pending/accepted blanks; refuse new blanks/approval of a blank; reasoned audited rejection; correction supplies a genuine reference, history and deduplicated claims; finish succeeds |
| Provider ownership must end with account closure | Account deletion revokes bindings. Start requires active user; receipt persistence takes account NO KEY UPDATE lock shared with closure before entry lock, checks active user and ownership | deletion while mocked fetch waits prevents receipt; binding revoked; future requests make no network call |
| Concurrent429 must not shorten a shared cooldown | Atomic greatest(existing, new retry_at) | in-flight120-second response followed by1-second response preserves long cooldown and blocks a new request |
| Preserve old proof without automatic mass quarantine | Optional explicit operator conversion, never called by GET/migration/scheduler. Strict decode, normalized derivative, exact original/hash, audited reason; refusal keeps bytes unchanged | valid legacy conversion/idempotent retry; unauthorized refusal; malformed refusal audited; private access preserved |

Previously applied migrations44–46 are unchanged. Migration47 must be reviewed and tested on the final integration candidate before any separately authorized release. This patch does not execute a production migration.

## Legacy evidence: operational decision remains open

Production inventory was not read. The count/existence/validity of legacy evidence is **unknown**. No blanket hiding or quarantine is implemented; media GET remains unchanged. This optional conversion is preparation, not proof that old files need conversion and not a claim that all historical images are normalized.

On an explicitly authorized isolated snapshot, first read aggregate counts, without exporting private image bytes:

```sql
select count(*) as legacy_evidence
from media where kind='evidence' and original_data is null;
```

For individually reviewed rows, an authorized operator can invoke `convertLegacyEvidence` with the actual media ID and a meaningful reason. No public endpoint is added. It preserves original bytes/digest/content type privately, replaces only the served derivative, and keeps the existing evidence access policy. Invalid input yields `invalid_legacy` with an audit record; it neither deletes nor hides the source. Investigate that confirmed row and obtain an explicit disposition before restricting access. Do not claim a passing conversion if any requested row refused. No batch conversion, actual production inventory or invalid-file disposition has been authorized or executed.

## Preserved policies and release boundary

Accepted historical scores are not silently re-ranked/rejected. An authorized reviewer may explicitly reject them with a reason; audit records identify missing legacy reference and revision. Refusal to newly approve an unidentified blank-reference pending score is the safe validation boundary. A rejected legacy score can be corrected in place using a genuine match reference, expected revision and reason; unique member/game/match claims still apply. Product owners must decide any broader historical revalidation policy.

Self-approval/owner/referee role independence remains the existing policy; no powers are revoked by this patch. Whether to require independent review is a product decision. Manual/provider receipt data still never constitutes live publisher verification or automatic score approval. No game-limit/scoring formula, payment, wallets, skins, TLS/MFA settings or external credentials changed.

The existing PR's verified417/417 real-PostgreSQL CI belongs to the baseline head above. Local full-suite numbers and skipped real PostgreSQL cases must be reported separately. The new true-concurrency case and all migrations must pass the existing protected check job on the exact final integration head before any separately authorized merge/deployment. No safe unpublished CI trigger is assumed; independent deployment effects still require review before publication.
