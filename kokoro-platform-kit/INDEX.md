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
Only exports from `src/index.ts` are supported; RPC specifics are documented in [`src/rpc/INDEX.md`](src/rpc/INDEX.md).

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
