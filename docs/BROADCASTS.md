# Native broadcasts — operation

MIPA internal implementation record, C-29. Commercial operator: MAXIMUS VEGAS L.L.C-FZ. Technical integration choices do not establish a partnership or approval of service terms.

Customers open `/ru/studio` or `/en/studio`, preview their screen locally, select live, recording-only or live-with-recording, prepay a duration and their own storage interval, then start publishing. Live broadcasts appear in Media with an authenticated viewer page. The creator alone accesses the MP4 archive.

## Activation settings

Installing the code does not enable charges or broadcasting. All activation gates must be satisfied:

1. **LiveKit Cloud:** set `LIVEKIT_URL` to the project's `wss://…livekit.cloud` URL, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`. Enable room-composite MP4 egress and configure the signed webhook at `/api/broadcasts/webhook`. This adapter requires Cloud's explicit token revocation; a self-hosted deployment is not a drop-in replacement. Use a separate preview project for acceptance.
2. **Private S3:** set `BROADCAST_S3_BUCKET`, `BROADCAST_S3_REGION`, `BROADCAST_S3_ACCESS_KEY_ID` and `BROADCAST_S3_SECRET_ACCESS_KEY`. Use a dedicated never-versioned bucket with all four public-access-block settings enabled. Scoped credentials need `GetBucketVersioning`, `GetBucketPublicAccessBlock` and object `PutObject`, `GetObject`, `DeleteObject` in `broadcasts/*`, plus multipart permissions required by egress. Configure abandoned-multipart cleanup; do not set blanket object expiry ahead of paid retention. After checking, set `BROADCAST_PRIVATE_STORAGE_CONFIRMED=1`. The worker also verifies versioning/public-access blocking through AWS.
3. **Merchant:** the existing Stripe/payment gates remain effective, including recipient verification for MAXIMUS VEGAS L.L.C-FZ and live-mode confirmation. The existing `/api/payments/stripe/webhook` handles the new product without changing membership fulfillment. Subscribe to Checkout completion, asynchronous success/failure, expiry, charge refund and dispute-created events. Production refuses test-mode native-service sales.
4. **Minute scheduler:** invoke `GET /api/cron/broadcasts` once per minute with the existing `CRON_SECRET` Bearer authorization. Provision a hosting plan or external scheduler that supports this frequency. The existing daily cron is insufficient and is not silently changed to a plan-dependent schedule. A successful worker heartbeat under 150 seconds old is required for checkout/start. Monitor the `broadcasts` entry in `system_runs`, failed requests and outstanding `stopping`/`deleting` rows.
5. **Approved tariff:** set `MV_BROADCAST_TARIFF` to a JSON object with the fields below. There are deliberately no default prices or invented approval references. Set `MV_BROADCAST_ENABLED=1` only after operational acceptance and commercial approval.

| Tariff field | Required value |
| --- | --- |
| `version`, `approvalRef` | Immutable version and actual owner approval reference; new version when pricing or terms change |
| `currency` | A currency supported by the existing portal |
| `minuteMinor` | Positive integer minor units per prepaid minute, including the tariff's audience allowance |
| `storageMinuteDayMinor` | Positive integer minor units per prepaid minute per storage day |
| `maxViewers` | 1–100 concurrent viewer identities; recording-only admits no viewers |
| `maxDays` | Maximum selectable whole-day interval, 1–3650 |
| `terms`, `refunds`, `tax` | Each contains complete approved `ru` and `en` text, shown before purchase and preserved in the order |

Package price = `minutes × minuteMinor + minutes × retentionDays × storageMinuteDayMinor`. Live-only has zero storage days. The selectable duration is 5–480 minutes. This is a prepaid service package, not a representation of actual provider costs. There are no automatic renewals, overage charges, gaming stakes or cash balances. Commercial terms must cover unused time, technical failure and refunds.

There are initially at most ten active/provisioning/closing rooms across the service. This bounds the live expiry queue to one worker batch. Start checks capacity again; an already-paid customer can retry later without another charge. Before activation, verify an actual preview purchase, screen/audio publication, viewer connection, recording finalization, download, strict revocation, duration expiry and physical S3 deletion. Configure provider capacity/spend limits and monitoring. Browser, unit or CI tests alone do not establish provider acceptance.

## Payment and lifecycle behavior

The server calculates money and compares the amount displayed to the customer. A redirect never marks an order paid: the authoritative Checkout session must match order, user, broadcast, tariff, amount, currency and test/live mode. Persisted checkout parameters and idempotency keys survive lost responses. Refund/dispute revocation cannot be undone by a late success event. Refunds follow the approved merchant operating process; this release does not invent an automatic refund policy.

One owner can have one unfinished purchase or broadcast. Provisioning is claimed under a database lock. An ambiguous creation failure enters remote cleanup, not a second create. Closing while provisioning causes a compensating close of a late-created room. An unresolved checkout remains pending for provider/operator reconciliation; investigate the stored order/session reference if retries continue to fail after expiry, rather than collecting another payment for that order.

The owner can publish screen video, screen audio and microphone only. Viewers subscribe without publish, data or administrative grants. Viewer seats are allocated transactionally; reallocation revokes the old occupant's token. Ending explicitly revokes every issued identity, including departed clients with refreshed tokens, stops egress and deletes the room. Token TTL alone would not disconnect clients.

The browser sends liveness every 15 seconds and stops capture on share-end, page exit or paid-time expiry. The worker independently closes expired rooms and sessions without a heartbeat for 90 seconds, plus scheduler/provider latency. A stalled scheduler disables new purchases; only a working worker/provider can stop existing connections. Outages can delay physical shutdown, so operational monitoring and provider account limits remain necessary. Customer billing stays at the prepaid amount.

## Archive and account behavior

Authoritative provider polling recovers lost webhooks. Only the predetermined private object `broadcasts/<broadcast UUID>/pov.mp4` is accepted. The selected storage interval begins when the finalized object is verified. Owner-only signed download URLs last at most 60 seconds, shortened to remaining retention. New access is denied on expiry/deletion request; previously issued links can remain valid until their short expiry or object deletion.

Finalization and token invalidation precede actual object erasure, preventing a late writer from restoring deleted video. Failures retry; no `deleted` state is claimed before successful provider cleanup. Initial storage duration is customer-selected; paid archive extension is not implemented in this release. Customers may download a copy before expiry.

Account closure is serialized with purchases, refuses unresolved payments, hides owned media and queues remote erasure. Exports include order/retention history without provider credentials, tokens or object URLs. Accounting/audit retention is distinct from selected video retention.

## Browser and existing-feature boundaries

Desktop browsers with `getDisplayMedia` are supported. Each capture begins with an explicit user action and browser prompt. Source audio depends on browser/source; no webcam is requested. Recording uses a 720p/30 fps composite profile and the client requests matching capture/bitrate. Configure provider-side resource limits too. Capturing another application on iOS requires a separate native extension and is not implemented here.

External tournament stream links, existing players and OBS overlays remain available. This additional paid service does not alter tournaments, memberships, coins, legal pages or the official lion. Provider references: https://docs.livekit.io/frontends/reference/tokens-grants/ and https://docs.livekit.io/transport/media/ingress-egress/egress/.
