---
architectureIndex: 1
rootId: platform.model
owners:
  - "@LordFoxFairy"
---

# Model control module

## Responsibilities
Own model/provider catalog records, logical model options, policy selection, availability, and current runtime resolution APIs.

## Non-responsibilities
Model does not execute Agent graphs, own provider proxy attempts, settle credit, or choose browser UI state.

## Public boundary
`ModelService` (`src/application/model-service.ts`) is the only application service. HTTP serves `/provider-accounts/ensure|:providerAccountId|:providerAccountId/restore`, `/model-bindings` (list, `ensure`, `resolve`, delete/restore by id), and `/model-labels` (list, `ensure`), plus the `/admin/models/*` manifest surface (lists for provider-accounts/bindings/labels/site-policies, and provider-account and binding delete/restore); `src/interfaces/cli/seed-builtin.ts` seeds the builtin catalog. `src/index.ts` re-exports `ModelService`, `createModelServer`, `modelAdminManifest`, `modelPlatformModule`, the HTTP schemas, and the domain/repository contracts.

## Callers and dependencies
Session's model catalog client and the Admin gateway call this module; a general Platform Admission boundary is a later wave and has no implementation today. Persistence is private to its Prisma schema; runtime invocation is a later Model Gateway boundary.

## Data ownership and events
This package owns model/provider metadata, policy records, migrations, and model-control events.

## Runtime and security
`DATABASE_URL_MODEL` is this package's private Prisma datasource; `KOKORO_MODEL_PORT` (4221) binds the service, and `KOKORO_USER_BASE_URL`/`KOKORO_CREDIT_BASE_URL`/`KOKORO_PAYMENT_BASE_URL` name peer services. Inbound calls are authenticated by the per-caller registry (`KOKORO_INTERNAL_SECRET_<CALLER>`); the single legacy `KOKORO_INTERNAL_SECRET` is template compatibility only. Provider credentials are referenced indirectly and never returned through public model lists; Site/plan policy is resolved server-side.

## Idempotency, failure, and recovery
Catalog publication and policy changes require stable identities, revisions, audit history, and deterministic fallback selection.

## Extension rules and forbidden dependencies
Keep catalog/control in this module and provider execution in the future gateway. Do not place pricing or Site entitlements in GA.

## Current gotchas
Current model lists exist, but AuthorizedModelRoute/ExecutionGrant and production fallback accounting are not yet Wave 5A complete.

## Verification
Run `pnpm --filter @kokoro/model test`, typecheck/lint, migrations, and integration tests.
