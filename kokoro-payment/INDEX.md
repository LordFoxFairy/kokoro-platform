---
architectureIndex: 1
rootId: platform.payment
owners:
  - "@LordFoxFairy"
---

# Payment module

## Responsibilities
Preserve payment records and expose the Site-scoped read-only pack catalogue during redeem-only launch.

## Non-responsibilities
Payment does not directly grant entitlements or credit; provider success must enter the shared Fulfillment boundary in Wave 2B.

## Public boundary
HTTP exposes Site-scoped `GET /plans`, read-only `/admin/payments/*` resources, and stable `ACQUISITION_CHANNEL_DISABLED` denials for existing order/payment-event/webhook callers. Admin mutation actions are absent. `src/interfaces/cli/seed-packs.ts` seeds only plan rows. Legacy payment application/provider code remains private migration input and is not exported or assembled by the runtime.

## Callers and dependencies
Web BFF reads the Site catalogue and Admin reads historical records. No provider or commerce orchestrator enters the runtime while acquisition is disabled.

## Data ownership and events
This package owns provider/payment/refund/dispute records, webhook inbox state, migrations, and payment-domain events.

## Runtime and security
`DATABASE_URL_PAYMENT` is this package's private Prisma datasource and `KOKORO_PAYMENT_PORT` (4241) binds the service. Former provider and confirmation-worker environment switches are stripped. The process bootstrap has no provider SDK, webhook secret resolver, Credit client, or acquisition worker. `KOKORO_SITE_ID` only scopes the catalogue seed.

Admin plans/orders/subscriptions/refunds strictly accept an optional `siteId` and filter before `take: 100`; subscriptions and refunds traverse plan/order respectively and return an explicit projected `siteId`. Admin stats require `siteId` for both status and revenue groupings. Provider configuration and raw payment events are platform-global sensitive resources and reject Site query parameters.

## Idempotency, failure, and recovery
Acquisition commands do not reach persistence: existing runtime callers receive one stable 503 code and Admin mutations are structurally unregistered. Seven repository detectors plus runtime no-effect tests keep the shutdown from being widened by wiring or environment changes.

## Extension rules and forbidden dependencies
Do not re-export or assemble legacy acquisition services. Reopening providers requires the Wave 2B fulfillment boundary and removal of the repository shutdown gate in one reviewed change.

## Current gotchas
Real checkout/refund/dispute/dunning certification is Wave 2B and does not block redeem-only launch.

## Verification
Run `pnpm --filter @kokoro/payment test`, typecheck/lint, migrations, webhook security tests, and integration tests.
