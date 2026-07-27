---
architectureIndex: 1
rootId: platform.kit
owners:
  - "@LordFoxFairy"
---

# Platform Kit

## Responsibilities
Provide narrow shared Platform primitives for configuration, request context, domain values, HTTP, Admin helpers, and RPC interceptors.

## Non-responsibilities
Kit does not own business entities, orchestration, persistence schemas, provider policy, or service startup.

## Public boundary
Only `src/index.ts` re-exports are supported. It spans six subtrees:

- `admin/` — Admin module manifest schemas (`adminModuleManifestSchema` and friends) and `registerAdminManifestRoute`.
- `config/` — `defineEnv` and `EnvValidationError`.
- `contract/` — Platform runtime request/response schemas and their inferred types: usage hold/settle, credit release, model binding and label queries.
- `domain/` — `AppError`, `appError`, `ERROR_STATUS`, `ErrorCode`, `parsePositiveBigIntString`.
- `http/` — `callService` (see below), request context (`readRequestContext`, `requireSite`, `contextHeaders`), `registerErrorHandler`, route access (`registerRouteAccess`, `declareRouteAccess`, `loadCallerSecrets`, `SERVICE_CALLER_HEADER`, `INTERNAL_SECRET_HEADER`), `registerHealthRoute`, `registerMetricsRoute`, `registerOpenApi`, `startHttpServer`, and the `sendData`/`sendError` response helpers.
- `rpc/` — Connect interceptors and workload auth; specifics in [`src/rpc/INDEX.md`](src/rpc/INDEX.md).

`callService` is the only supported outbound cross-service entry point. Its `caller` argument is required, so every request carries `x-kokoro-service`; `registerRouteAccess` answers 401 when that header is missing. No shared-secret fallback exists: the caller-less `internal-secret-guard` module was removed once it had zero consumers, and `INTERNAL_SECRET_HEADER` now belongs to `http/route-access.ts`.

## Callers and dependencies
Platform business modules may depend on Kit; Kit must not depend back on those modules.

## Data ownership and events
Kit owns no durable business data or domain event stream.

## Runtime and security
Boundary helpers validate untrusted inputs, fail closed for principals, avoid secret-bearing telemetry, and remain transport-focused.

## Idempotency, failure, and recovery
Shared helpers are deterministic; receipt and transaction semantics remain in owning application modules.

## Extension rules and forbidden dependencies
Add a helper only when reused and policy-neutral. Do not move module-specific logic here to avoid a proper dependency direction.

## Current gotchas
RPC helpers currently support the Admin Auth pilot and are intended for reuse by later generated internal services.

## Verification
Run `pnpm --filter @kokoro/platform-kit test`, typecheck, and lint.
