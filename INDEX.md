---
architectureIndex: 1
rootId: service.platform
owners:
  - "@LordFoxFairy"
---

# Kokoro Platform

## Responsibilities
Own shared Site, identity, model-control, credit, commerce, capability, and privileged Admin business facts in a modular TypeScript service repository.

## Non-responsibilities
Platform does not execute Agent graphs, own Session messages/SSE, render Site Web applications, or absorb child repository lifecycles.

## Public boundary
Workspace packages expose HTTP/Connect adapters from `interfaces/`; the deployment image is built by `deploy/docker/Dockerfile`.

## Callers and dependencies
Web Admin calls generated Connect services; Session consumes versioned internal APIs; Agent reaches model/capability backends only through approved runtime protocols.

## Data ownership and events
Each module owns its schema/migrations and domain events. Cross-module orchestration must use application ports and an explicit Platform transaction boundary.

## Runtime and security
Every request resolves trusted workload and Site context before business use. Secrets remain environment/secret-manager owned and private tables are never cross-service APIs.

## Idempotency, failure, and recovery
Effect commands use durable receipts, stable idempotency keys, transactional writes, and reconciliation after ambiguous timeouts.

## Extension rules and forbidden dependencies
Keep domain/application independent of transport and persistence. Add deployable adapters inside the owning module; do not create a new Git repository solely for directory separation.

## Current gotchas
Admin Auth Connect is implemented; general Admission, redeem fulfillment, and Model Gateway production contracts remain later waves.

## Verification
Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and dependency-backed `pnpm test:integration` before release.
