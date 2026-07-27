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
Application use cases and `src/interfaces/http`/`admin`/`cli` adapters are the supported entrypoints.

## Callers and dependencies
Platform orchestration and Admission call Credit; persistence uses this package's Prisma schema and Platform Kit primitives.

## Data ownership and events
This package exclusively owns its credit schema, migrations, journal rows, holds, and credit-domain events.

## Runtime and security
All mutations require trusted Site/billing-account context; amounts use explicit integer units and never client-provided prices.

## Idempotency, failure, and recovery
Journal effects and hold transitions must be idempotent, balanced, transactionally guarded, and reconcilable after timeout.

## Extension rules and forbidden dependencies
Add policy-free value objects to domain and workflows to application. Do not call payment providers or write another module's tables.

## Current gotchas
The current module predates the final three-bucket/redeem fulfillment wave; target behavior must not be claimed until Wave 2A cutover.

## Verification
Run `pnpm --filter @kokoro/credit test`, typecheck/lint, migrations, and its integration suite.
