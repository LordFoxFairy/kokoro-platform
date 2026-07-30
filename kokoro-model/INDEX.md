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
`ModelService` (`src/application/model-service.ts`) is the only application service. HTTP is a read-only product/runtime projection: `GET /model-bindings`, `GET /model-bindings/resolve`, and `GET /model-labels`. `src/interfaces/cli/seed-builtin.ts` is an explicit offline bootstrap authority and writes directly through the application/repository boundary, never through Session-reachable HTTP. All production Model mutations are owned exclusively by the Platform ModelControl Connect boundary; this package deliberately registers no mutation HTTP routes, `/admin/models/*` routes, actions, or Admin manifest. `src/index.ts` re-exports `ModelService`, `createModelServer`, `modelPlatformModule`, the HTTP schemas, and the domain/repository contracts.

## Callers and dependencies
Session's model catalog client calls this product/runtime module. The Admin gateway calls Platform ModelControl instead and must never call this package directly. Persistence is private to its Prisma schema; runtime invocation belongs to Model Gateway.

## Data ownership and events
This package owns model/provider metadata, policy records, migrations, and immutable model-control facts.

## Runtime and security
`DATABASE_URL_MODEL` is this package's private Prisma datasource; `KOKORO_MODEL_PORT` (4221) binds the service. Inbound runtime calls are authenticated by the per-caller registry (`KOKORO_INTERNAL_SECRET_<CALLER>`). Provider credentials are referenced indirectly and never returned through product model lists. `/model-bindings/resolve` and `/model-labels` each take `siteId` as a **required query parameter** and apply the same Site visibility projection. The `x-kokoro-site-id` header is only cross-checked; a contradiction is rejected with `400 model.site_mismatch`. Calls to former provider-account/binding/label ensure, delete, restore routes and `/admin/models/*` receive `404`; possessing a Session or Admin credential does not restore that retired authority.

## Idempotency, failure, and recovery
Catalog publication and policy changes require stable identities, revisions, audit history, and deterministic fallback selection.

## Extension rules and forbidden dependencies
Keep catalog/control in this module and provider execution in the future gateway. Do not place pricing or Site entitlements in GA.

## Current gotchas
Current model lists exist, but AuthorizedModelRoute/ExecutionGrant and production fallback accounting are not yet Wave 5A complete.

## Verification
Run `pnpm --filter @kokoro/model test`, typecheck/lint, migrations, and integration tests.
