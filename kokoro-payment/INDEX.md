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
`DATABASE_URL_PAYMENT_READ` is the HTTP runtime's mandatory, SELECT-only Prisma datasource and `KOKORO_PAYMENT_PORT` (4241) binds the service. It never falls back to the migration/write `DATABASE_URL_PAYMENT`. The production composition opens a read store whose raw client is held behind JavaScript `#private` state and recursively frozen catalogue/admin capabilities (including each function); the HTTP server receives only the exact `{catalog, admin}` object while lifecycle `close` stays outside that boundary. A non-empty known provider, webhook-secret, or confirmation-worker environment variable fails startup with `payment.acquisition_env_forbidden`; unrelated system keys remain safely stripped. The process bootstrap has no provider SDK, webhook secret resolver, Credit client, or acquisition worker. `KOKORO_SITE_ID` only scopes the catalogue seed.

Admin plans/orders/subscriptions/refunds require a non-empty `siteId`, return `payment.site_required` before any repository read when absent, and filter before `take: 100`; subscriptions and refunds traverse plan/order respectively and return an explicit projected `siteId`. Admin stats use the same required scope for both status and revenue groupings. Provider configuration and raw payment events are platform-global sensitive resources: they reject Site query parameters and are reachable only through the Admin plane, whose gateway requires wildcard Site authority.

## Idempotency, failure, and recovery
Acquisition commands do not reach persistence: existing runtime callers receive one stable 503 code and Admin mutations are structurally unregistered. Fastify's `onRoute` hook records authoritative route cardinality and rejects constrained or alternate-routing registrations; `onReady` verifies the final router through Fastify's structured `hasRoute`/`findRoute` APIs, and a closure-scoped admission token fails requests closed if later hooks replace registration metadata. Plugin, hidden-route, shorthand, alias, and post-observation mutation paths therefore use the same policy; OpenAPI remains contract evidence rather than the security boundary. A closed runtime import graph, exact direct-import allowlists, mature ESLint restrictions, a narrow AST invariant for every raw Prisma reference, deployment-template/seed checks, and runtime no-effect tests keep the shutdown from being widened by wiring or environment changes. Release integration must additionally prove the database role can read and that `INSERT`, `UPDATE`, and `DELETE` are denied; static checks do not substitute for that leased-database proof.

## Extension rules and forbidden dependencies
Do not re-export or assemble legacy acquisition services. Reopening providers requires the Wave 2B fulfillment boundary and removal of the repository shutdown gate in one reviewed change.

## Current gotchas
Real checkout/refund/dispute/dunning certification is Wave 2B and does not block redeem-only launch.

## Verification
Run `pnpm --filter @kokoro/payment test`, typecheck/lint, migrations, webhook security tests, and integration tests.
