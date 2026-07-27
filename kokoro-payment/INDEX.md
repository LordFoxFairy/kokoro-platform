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
Application services and `src/interfaces/http`, `admin`, and `cli` expose supported commands and queries.

## Callers and dependencies
Platform commerce orchestration calls Payment; provider webhooks enter through infrastructure adapters and private Prisma persistence.

## Data ownership and events
This package owns provider/payment/refund/dispute records, webhook inbox state, migrations, and payment-domain events.

## Runtime and security
Webhook signatures, secret rotation, replay windows, amount/currency checks, and Site/billing-account context are mandatory trust boundaries.

## Idempotency, failure, and recovery
Provider event IDs and command receipts deduplicate delivery; ambiguous outcomes reconcile with the provider before fulfillment.

## Extension rules and forbidden dependencies
Add providers behind ports. Never duplicate Subscription/Entitlement/Credit issuance inside a provider adapter.

## Current gotchas
Real checkout/refund/dispute/dunning certification is Wave 2B and does not block redeem-only launch.

## Verification
Run `pnpm --filter @kokoro/payment test`, typecheck/lint, migrations, webhook security tests, and integration tests.
