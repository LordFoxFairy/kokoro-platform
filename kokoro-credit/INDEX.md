---
architectureIndex: 1
rootId: platform.credit
owners:
  - "@LordFoxFairy"
---

# Credit module

## Responsibilities
Own credit accounts, holds, settlement/release, journals, balances, pricing snapshots, and usage-facing credit invariants.

## Non-responsibilities
Credit does not own payment provider objects, subscription catalogs, Agent usage measurement, or Session transport.

## Public boundary
`CreditService` (`src/application/credit-service.ts`) is the only application service. HTTP serves the `/credit/*` internal surface — `accounts/ensure`, `grant`, `spend`, `hold`, `capture`, `release`, `usage/hold`, `usage/settle`, `usage/summary`, `usage/by-model`, `usage/ledger`, `quote`, `pricing-rules`, `holds/sweep` — plus the `/admin/credits/*` manifest surface; `src/interfaces/cli/seed-pricing.ts` seeds pricing. `src/index.ts` re-exports `CreditService`, `createCreditServer`, `creditAdminManifest`, `creditPlatformModule`, the HTTP schemas, and the domain/repository contracts. A second entry point `@kokoro/credit/contract` exposes `src/interfaces/http/schemas.ts` alone, so a peer service can bind to this service's wire contract without pulling in the rest of the package.

## Callers and dependencies
Session's billing client and Payment call Credit over HTTP; a general Platform Admission boundary is a later wave and has no implementation today. persistence uses this package's Prisma schema and Platform Kit primitives.

## Data ownership and events
This package exclusively owns its credit schema, migrations, journal rows, holds, and credit-domain events.

## Runtime and security
`DATABASE_URL_CREDIT` is this package's private Prisma datasource; `KOKORO_CREDIT_PORT` (4231) binds the service. Owner/Site enforcement calls `KOKORO_USER_BASE_URL` and `KOKORO_SITE_BASE_URL`, authenticated by the per-caller registry (`KOKORO_INTERNAL_SECRET_<CALLER>`, legacy `KOKORO_INTERNAL_SECRET` is outbound fallback only). Billing tuning lives in `KOKORO_CREDIT_USAGE_*`, `KOKORO_CREDIT_HOLD_*`, `KOKORO_CREDIT_ACTIVE_CACHE_*`, and `KOKORO_CREDIT_WELCOME_MICROS`. All mutations require trusted Site/billing-account context; amounts use explicit integer units and never client-provided prices.

## Idempotency, failure, and recovery
Journal effects and hold transitions must be idempotent, balanced, transactionally guarded, and reconcilable after timeout.

## Extension rules and forbidden dependencies
Add policy-free value objects to domain and workflows to application. Do not call payment providers or write another module's tables.

## Current gotchas
The current module predates the final three-bucket/redeem fulfillment wave; target behavior must not be claimed until Wave 2A cutover.

## Verification
Run `pnpm --filter @kokoro/credit test`, typecheck/lint, migrations, and its integration suite.
