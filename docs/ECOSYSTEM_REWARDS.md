# MAXIMUS Rewards — ecosystem programme requirements

Status: programme design; no live collection, accrual or redemption is enabled.
Owner instruction: 11 October 2026. Work item C-40 / PR #48.
Canonical platform: MAXIMUS-NPiO/maximus-vegas. This extends the ecosystem; it does not replace existing product requirements.

## Owner requirements and coverage

| ID | Requirement | Implementation / acceptance |
|---|---|---|
| RWD-01 | Add an option to support the platform and receive bonuses usable on MAXIMUS Vegas; improve the English wording. | Proposed copy below; a real programme page must explain availability before any contribution action. |
| RWD-02 | Apply the existing 20% annual bonus scheme to players too. | Preserve 20%; recover and version the eligible base, annual credit date, term and cancellation rules before enabling accrual. |
| RWD-03 | Tennis customers and investors can use their eligible bonuses on Vegas. | Connect qualifying programmes separately; a racquet purchase is not automatically an investment or a 20% qualifying contribution. |
| RWD-04 | Include Baby Tennis and its participants. | Eligible family benefits can connect through an authorised adult account. This does not open Vegas accounts to children; current 18+ rules remain. |
| RWD-05 | Bonuses earned through eligible Vegas participation can be used for racquets and other ecosystem products. | Define eligible activity and its reward funding; provide a transaction ledger and a real merchant redemption integration. Ordinary XP and game coins remain distinct. |
| RWD-06 | Include SHALENI clothing. | Add verified products, eligible merchants, redemption limits and settlement responsibilities when connected. |
| RWD-07 | Include future children's clothing. | Preserve as a planned category; do not present an unconnected catalogue or supplier as available. |
| RWD-08 | Make rewards reciprocal across the ecosystem. | A common programme balance with visible source, policy version, accrual, reservation, redemption and reversal history; explicit linking of accounts. |

## Recovered prior model

The saved model of 23 September 2026 describes the annual option as 20% of the initial qualifying amount, credited at the end of each year, without compounding. Rewards are intended for goods and services inside the ecosystem. Its alternative advance-bonus option must not be added to the annual option.

The saved model explicitly leaves the annual programme term, early exit, eligible assortment, redemption conditions and fulfilment costs unresolved. Its capital-return example is not an approved Vegas offer. The later SHALENI working material also treats bonus terms as a proposal, and the revised partner catalogue distinguishes purchases, junior support, contractual royalties, Membership and loyalty programmes. Do not collapse them into one product.

These sources establish continuity of the intended calculation; they do not establish a live payment service or approved contractual terms. The exact source references are retained in the owner's shared task record, without copying private financial examples into this public repository.

## Proposed customer-facing wording

Working programme name: **MAXIMUS Rewards**.

Headline: **Support MAXIMUS. Enjoy more across the ecosystem.**

Description for the launch version, once connected:
“Support the platform through eligible contributions and earn rewards you can use across MAXIMUS — for gaming experiences, tennis equipment, training and fashion.”

Primary navigation label: **Explore MAXIMUS Rewards**.
An actual payment button may say **Contribute and earn rewards** only when the contribution offer and checkout are active.

Russian:
“Поддерживайте MAXIMUS. Открывайте больше возможностей.”
“Участвуйте в развитии платформы и получайте бонусы для игровых сервисов, теннисного оборудования, тренировок и одежды в экосистеме MAXIMUS.”

For an informational preview, state prominently:
“Programme in development. Contributions and cross-platform rewards are not available yet.”
Describe 20% as the planned annual bonus rule. Do not use “guaranteed return”, imply cash interest, or imply that a bonus balance is withdrawable money.

The name is a proposal, not a confirmed registered trademark. No new brand symbol is needed.

## Current platform constraints

- Published game coins are non-monetary progression points. Section 6 of the existing terms limits their use to cosmetics and the premium season-pass track and prohibits exchange for goods. New ecosystem rewards therefore require a distinct ledger and their own accepted policy version; do not silently convert old balances.
- Games, tournament entry and competitive access remain free. Contributions must not improve seeding, rank or results. Rewards must not become stakes, paid random prizes or player-funded prize pools.
- The production health check on 11 October reported email not connected and payments off. A contribution checkout must not be represented as operational.
- A product page or model is not proof of a connected merchant, available inventory, reward funding or settlement.

## Implementation proposal

1. Create a programme and policy registry with eligible event types, rate, calculation base, currency/unit, annual timing, term, rounding, expiry, caps and refund treatment. Unspecified policies cannot be activated.
2. Keep contribution contracts, purchase loyalty, activity rewards, contractual royalties and institutional Membership separate. Each credit records its actual source and the policy that authorised it.
3. Use an append-only rewards ledger with integer minor units, unique source-event keys, explicit pending/available/reserved/redeemed/reversed states and atomic balance reservations. No balance or accrual calculation supplied by the browser is trusted.
4. Credit a contribution only after a verified provider event and the relevant eligibility checks. An anniversary scheduler must be idempotent; retries cannot credit a year twice.
5. Integrate merchant quote, reservation, confirmation, cancellation and refund operations with authenticated server calls. A failed order releases its reservation. Returned goods create a traced reversal under the accepted rules.
6. Link ecosystem accounts through verified ownership and explicit consent. Matching email strings alone must not merge accounts or expose balances. Family activity and children's data remain under the appropriate adult controls.
7. Expose the real programme state, balance history and available redemption catalogue. Keep game XP/coins and ecosystem rewards visually and technically distinct.
8. Record merchant settlement and fulfilment cost separately from the nominal value of bonuses. Keep financial commitments and launch approval with the designated operator; no assumed banking or investment authorisation.

## Decisions still needed before live activation

- Legal nature and responsible operator of each qualifying contribution, purchase reward and investment-related benefit.
- Programme term; whether and when the principal is returnable; early exit, refunds and chargebacks.
- Exact anniversary/time-zone rule, partial periods, rounding, expiry/carry-forward and any total cap.
- Conversion unit, eligible products/services, maximum bonus share of a purchase, prices, taxes and cross-merchant settlement.
- Qualifying Vegas activities and their funded reward schedule. The 20% contribution rule is not automatically a reward for every game played.
- Actual payment provider, transactional email, funded fulfilment and recovery procedures.

The recovered annual model supplies the initial-amount basis and simple annual timing as the working proposal. Do not ask the owner to restate these from memory; present any remaining policy choice against this record.

## Required acceptance before activation

- One qualifying settled contribution produces one source record; repeated or out-of-order provider events cannot duplicate rewards.
- The first annual credit uses the eligible initial base, not the growing rewards balance. No advance-bonus option is stacked on top.
- A concurrent double spend cannot reserve more than the available balance.
- Cancellation, partial return, chargeback and failed fulfilment reconcile with a visible history.
- Cross-project credits and redemptions reconcile to the same ledger without exposing another user's records.
- The selected goods/services really exist and can be fulfilled. Reward values are not added to a user's available cash.
- The owner-approved terms and programme version appear before acceptance; the exact accepted version is retained.
- Free competition, current age restrictions, independent result review and the existing release gates continue to pass.

## Review handoff

Ante: review the proposed ledger and merchant integration against the existing server architecture; identify the smallest testable slice and any policy dependency before enabling transactions.
Storm: review the customer journey, clarity of programme status, cross-project coverage and the list of things users can actually redeem.
No acceptance by either reviewer is asserted.

## Informational preview implementation

A bilingual /rewards page presents the programme, the planned 20% model and reciprocal ecosystem destinations. Footer discovery and sitemap entries are added. The page explicitly states that contributions, accrual, merchants and redemption are not active; it creates no money flow, ledger, account or contract. The activation requirements above remain open.
