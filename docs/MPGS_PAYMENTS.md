# Mastercard MPGS payments — C-32

MIPA internal implementation record · 5 October 2026 · PR #35

The owner explicitly authorized temporary reuse of the existing Maximus Sports acquiring under an internal agreement for MAXIMUS VEGAS. Separate VEGAS acquiring is a later task. This authorization supersedes the earlier assumption that a separate merchant account must precede all integration work. It does not change the invoice beneficiary or claim independent bank approval.

## Implemented

- Separate MPGS adapter, REST JSON v75, Hosted Checkout `PURCHASE`, AED. Stripe remains available when selected.
- Merchant credentials are server-only production secrets. No card data passes through portal routes. Gateway origins are allow-listed; authenticated requests refuse redirects.
- One durable order per checkout idempotency key; concurrent starts cannot create two sessions. An ambiguous create response cannot silently create another payable session.
- A return URL or result indicator never grants access. Authenticated Retrieve Order must match merchant, order, currency and the exact captured amount. Authorization alone does not count as payment.
- Membership/broadcast reconciliation applies refunds and disputes conservatively. Replayed successful payment cannot restore revoked access. A local timeout alone stays processing, because MPGS timeouts do not interrupt every 3-D Secure interaction. Operations must reconcile an unresolved expired interaction before allowing another attempt.
- Private RU/EN handoff explains that Maximus Sports collects payment under the internal agreement for MAXIMUS VEGAS L.L.C-FZ. The invoice issuer and beneficiary remain unchanged.
- Protected `/api/cron/payments` rotates up to 20 known orders per run, with an execution deadline, every ten minutes. It reads the gateway; it cannot create a purchase. No CS-Cart notification setting is repointed. Existing Stripe webhooks stay separate.
- Migration 40 creates only portal-owned session records. No change is made to CS-Cart or its backup/migration work.

## Configuration

`PAYMENT_PROVIDER=mpgs`, `MPGS_GATEWAY_URL`, `MPGS_MERCHANT_ID`, `MPGS_API_PASSWORD`, `MPGS_MERCHANT_NAME`, `MPGS_CURRENCY=AED`, canonical HTTPS `NEXT_PUBLIC_SITE_URL`.

The owner-authorized collection model is represented by `MPGS_INTERCOMPANY_AUTHORIZED=1`, a nonempty `MPGS_AGREEMENT_REF` and `MPGS_BENEFICIARY_LEGAL_NAME=MAXIMUS VEGAS L.L.C-FZ`. These are owner attestations, not independent bank verification. Direct merchant mode retains the original merchant verification gate.

`PAYMENTS_ENABLED`, `PAYMENTS_MODE` and `PAYMENTS_LIVE_CONFIRMED` remain separate. Offers still require actual approved prices, tax/refund terms and approval references; the adapter invents none. Broadcasts also retain their media-service and tariff gates. No payable demo records are seeded in production.

## Evidence and current limit

CS-Cart payment 18 was inspected over authenticated HTTPS: Mastercard MPGS, gateway `https://ap-gateway.mastercard.com`, display name Maximus Sports, AED. Its stored API fields were transferred to protected production settings without recording their values in this repository.

Two read-only Retrieve Order probes, versions 75 and 61, returned HTTP 401. Version 61 explicitly returned `Invalid credentials.` No checkout, charge, refund or production test account was created. This establishes that these stored credentials did not authenticate from the verification client; it does not prove all CS-Cart card transactions are broken.

Collection remains disabled. Automatic approval review rejected setting the live authorization flag after that failure. No alternative route was used to bypass the rejection. The owner-confirmed internal agreement is preserved in this document and the project state; it is not the remaining blocker.

Next concrete dependency: correct or enable the merchant API credentials through the provider's secure merchant administration, then repeat a read-only authentication check. Passwords must not be pasted in chat. Gateway sandbox and live purchase acceptance are not claimed by the isolated fixtures.

## Verification

`tests/mpgs.test.ts` exercises fixed-point AED values, safe origins, exact request mapping, stable retries, ambiguous responses, concurrency, local timeout fencing, foreign merchant/order/currency/amount rejection, explicit collector disclosure and a complete membership capture/refund/replay cycle on embedded PostgreSQL with a fake HTTP transport. Existing billing, Stripe and broadcast suites remain regression gates. Full CI runs the repository's required `check` workflow; production publishing must follow a green check on the actual PR head.

Primary API references: [Initiate Checkout](https://ap-gateway.mastercard.com/api/documentation/apiDocumentation/rest-json/version/75/operation/Hosted%20Checkout%3A%20Initiate%20Checkout.html?locale=en_US), [Retrieve Order](https://ap-gateway.mastercard.com/api/documentation/apiDocumentation/rest-json/version/75/operation/Transaction%3A%20%20Retrieve%20Order.html?locale=en_US), [Checkout JavaScript](https://ap-gateway.mastercard.com/api/documentation/apiDocumentation/checkout/version/latest/checkout.html?locale=en_US).
