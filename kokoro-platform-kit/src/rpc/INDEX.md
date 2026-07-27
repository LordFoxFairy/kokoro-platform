---
architectureIndex: 1
rootId: platform.kit.rpc
owners:
  - "@LordFoxFairy"
---

# RPC boundary helpers

## Responsibilities

`workload-auth.ts` is the single temporary compatibility boundary for Admin Web workload metadata and rotating static secrets. RPC handlers consume the typed `WorkloadContext`; they must not read credential headers.

`errors.ts` maps owner failures to canonical Connect codes without exposing raw causes. Providers inject their generated error-detail descriptor through `createDetails`, keeping generated service contracts in the owning module.

`telemetry.ts` records fail-open Connect request metrics and fixed-field security audit events. Caller identity values are emitted only when they match the configured workload boundary; request bodies, credentials, identifiers, digests, and error text never enter its records or labels.

The contract package name carries the major version. Do not add a custom contract-version header.

## Non-responsibilities
RPC helpers do not own service methods, business policy, receipts, persistence, or client retry decisions.

## Public boundary
Exports promoted through Platform Kit's `src/index.ts` are the only supported helper API.

## Callers and dependencies
Generated Connect providers compose workload auth, canonical error mapping, validation, telemetry, and security audit from this component.

## Data ownership and events
This component owns no durable state; metrics and audit sinks receive bounded low-cardinality records.

## Runtime and security
Credentials and request payloads never enter labels or audit records; telemetry failure must not replace the original RPC result.

## Idempotency, failure, and recovery
Interceptors are deterministic and fail closed for authentication while metrics/audit remain fail-open and off the critical path.

## Extension rules and forbidden dependencies
Keep helpers policy-neutral and generated-detail aware. Do not parse hand-written version headers or import service-private modules.

## Current gotchas
Caller identity is recorded only after the configured workload boundary has authenticated it.

## Verification
Run `pnpm --filter @kokoro/platform-kit test`, typecheck, and lint.
