---
architectureIndex: 1
rootId: service.platform
owners:
  - "@LordFoxFairy"
---

# Kokoro Platform

## Current transition state

Legacy Site/User/Model/Credit/Payment/Admin packages remain the current MySQL-backed runtime and rollback baseline.
The root Prisma 7/PostgreSQL 18 implementation is a `transition-candidate` only: its release artifact contains independently
selectable API, Worker, and Migrator roles, but `activationAuthorized=false` and `runtimeTraffic=false`. Task 3 owns only
the foundation marker, database/role/ACL preflight, health/readiness, migration locking, and graceful drain. No business
owner table has moved yet. API and Worker use distinct least-privilege roles and can only read the foundation marker.
Root-managed PG18 component and cutover evidence must pass before the legacy MySQL write surfaces are removed.

## Responsibilities

Own shared Site, identity, model-control, credit, commerce, capability, and privileged Admin business facts in a modular TypeScript service repository.

## Non-responsibilities

Platform does not execute Agent graphs, own Session messages/SSE, render Site Web applications, or absorb child repository lifecycles.

## Public boundary

Business packages expose Fastify HTTP adapters from `src/interfaces/http` (plus `admin`/`cli`); Connect/protobuf covers `kokoro.platform.admin.v1.AdminAuthService` only. The remaining cross-service traffic splits two ways: business modules call each other through `callService` plus a hand-written Zod schema, while the Admin gateway issues raw `fetch` with caller headers (`gateway.ts`). Root `src/index.ts` re-exports the module registry (`platformModules`, `listPlatformModules`, `getPlatformModule`, `listActivePlatformModules`, `assertPlatformRegistryIntegrity`, `PlatformModuleDescriptor`); the deployment image is built by `deploy/docker/Dockerfile`.

## Callers and dependencies

Web Admin calls the Admin gateway's `/api/*` endpoints and the generated Admin Auth Connect service; Session consumes versioned internal APIs; Agent reaches model/capability backends only through approved runtime protocols.

## Data ownership and events

Each module owns its schema/migrations and domain events. Cross-module orchestration must use application ports and an explicit Platform transaction boundary.

## Runtime and security

Every request resolves trusted workload and Site context before business use. Secrets remain environment/secret-manager owned and private tables are never cross-service APIs.

## Idempotency, failure, and recovery

Effect commands use durable receipts, stable idempotency keys, transactional writes, and reconciliation after ambiguous timeouts.

## Extension rules and forbidden dependencies

Keep domain/application independent of transport and persistence. Add deployable adapters inside the owning module; do not create a new Git repository solely for directory separation.

## Current gotchas

General Admission now has a transition-candidate boundary for strict opaque execution-context mapping and sealed GA request-draft construction. It is not an active provider: Prepare/Finalize/Release/Reconcile, the production sealer adapter, command receipts, and runtime traffic remain later work. Redeem fulfillment and Model Gateway production contracts also remain later waves.

## Verification

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and dependency-backed `pnpm test:integration` before release.
