---
architectureIndex: 1
rootId: platform.payment
owners:
  - "@LordFoxFairy"
---

# Payment module

## Responsibilities
Own current payment records, pack configuration, provider/webhook adapters, and payment administration workflows.

## Non-responsibilities
Payment does not directly grant entitlements or credit; provider success must enter the shared Fulfillment boundary in Wave 2B.

## Public boundary
`PaymentService` and `PaymentWebhookService` (`src/application/`) are the application services. HTTP serves `/plans` (list, `upsert`, delete/restore by id), `/orders` (`checkout`, create, `sweep`, `:id/confirm`, `:id/refund`), `/payment-events/record`, the provider ingress `POST /payments/webhooks/:provider`, and the `/admin/payments/*` manifest surface; `POST /admin/payments/grant-plan` returns the effective request ID in both success and error envelopes. `src/interfaces/cli/seed-packs.ts` seeds packs. `src/index.ts` re-exports both services, `createPaymentServer`, `paymentAdminManifest`, `paymentPlatformModule`, the HTTP schemas, and the domain/provider/webhook/repository contracts.

## Callers and dependencies
Platform commerce orchestration calls Payment; provider webhooks enter through infrastructure adapters and private Prisma persistence.

## Data ownership and events
This package owns provider/payment/refund/dispute records, webhook inbox state, migrations, and payment-domain events.

## Runtime and security
`DATABASE_URL_PAYMENT` is this package's private Prisma datasource; `KOKORO_PAYMENT_PORT` (4241) binds the service and `KOKORO_CREDIT_BASE_URL` is the credit grant/reverse target. `KOKORO_PAYMENT_ENABLED_PROVIDERS` is the real-provider allowlist — unlisted kinds answer 501 instead of faking success — and `KOKORO_PAYMENT_CONFIRM_SWEEP_INTERVAL_SECONDS`/`KOKORO_PAYMENT_CONFIRM_STALE_SECONDS` bound the hanging-confirm sweeper. `KOKORO_SITE_ID` only seeds packs from the CLI. Webhook signatures, secret rotation, replay windows, amount/currency checks, and Site/billing-account context are mandatory trust boundaries.

## Idempotency, failure, and recovery
Provider event IDs and command receipts deduplicate delivery; ambiguous outcomes reconcile with the provider before fulfillment. Admin plan grants use `admin-grant:<siteId>:<requestId>` as the order idempotency key: an identical target replays the same order, while reusing the request ID for another team or plan fails with `payment.idempotency_conflict` before another grant.

## Extension rules and forbidden dependencies
Add providers behind ports. Never duplicate Subscription/Entitlement/Credit issuance inside a provider adapter.

## Current gotchas
Real checkout/refund/dispute/dunning certification is Wave 2B and does not block redeem-only launch.

## Verification
Run `pnpm --filter @kokoro/payment test`, typecheck/lint, migrations, webhook security tests, and integration tests.
