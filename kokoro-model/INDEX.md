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
Application services plus `src/interfaces/http`, `admin`, and `cli` are the supported entrypoints.

## Callers and dependencies
Platform Admission and Admin call this module. Persistence is private to its Prisma schema; runtime invocation is a later Model Gateway boundary.

## Data ownership and events
This package owns model/provider metadata, policy records, migrations, and model-control events.

## Runtime and security
Provider credentials are referenced indirectly and never returned through public model lists; Site/plan policy is resolved server-side.

## Idempotency, failure, and recovery
Catalog publication and policy changes require stable identities, revisions, audit history, and deterministic fallback selection.

## Extension rules and forbidden dependencies
Keep catalog/control in this module and provider execution in the future gateway. Do not place pricing or Site entitlements in GA.

## Current gotchas
Current model lists exist, but AuthorizedModelRoute/ExecutionGrant and production fallback accounting are not yet Wave 5A complete.

## Verification
Run `pnpm --filter @kokoro/model test`, typecheck/lint, migrations, and integration tests.
