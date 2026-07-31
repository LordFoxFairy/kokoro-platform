---
architectureIndex: 1
rootId: platform.admin.src
owners:
  - "@LordFoxFairy"
---

# Platform Admin source map

## Responsibilities

Admin Auth is exposed only through the generated `kokoro.platform.admin.v1.AdminAuthService` Connect provider:

- `admin-auth-connect.ts` composes Fastify Connect, Protovalidate, workload authentication and typed safe errors.
- `admin-auth-service.ts` owns command/query behavior and consumes the Root-generated canonical Effect digest helper.
- `admin-auth-receipt.ts` owns idempotency, digest conflicts and receipt reconciliation.
- `admin-auth-store.ts` keeps operator, token, auth-event and receipt persistence inside one Prisma owner boundary.
- `generated/contracts/**` is the Root Proto/Buf-generated mirror, including the Node-only canonical Effect digest helper. Never edit it by hand.

Command receipts persist both `digestAlgorithm=sha256_protobuf_v1` and the 64-character digest. Proto request bounds match the MySQL `VARCHAR(191)` owner schema, so contract-valid input cannot fail later only because an indexed auth field is too wide.

The package version (`.v1`) is the contract version. There is no custom version header or hand-written Admin Auth HTTP route.

## Non-responsibilities
This source tree does not render Admin Web, expose Platform tables, or define Root protobuf sources.

## Public boundary
The generated `kokoro.platform.admin.v1.AdminAuthService` Connect provider is retained as a legacy service boundary; it has no current official Web consumer.

## Callers and dependencies
No current official Web consumer calls the provider. Handlers depend on generated contracts, Platform Kit interceptors, and the package-owned store.

## Data ownership and events
The package owns operator, token-effect, auth-event, and command-receipt persistence.

## Runtime and security
Protovalidate, workload identity, safe typed errors, bounded inputs, metrics, and fixed-field security audit protect the boundary.

## Idempotency, failure, and recovery
Canonical protobuf digest plus transactional receipts detect duplicates/conflicts and recover timeout-after-commit outcomes.

## Extension rules and forbidden dependencies
Modify Root protobuf first and regenerate mirrors. Never hand-edit generated code or restore Web database access.

## Current gotchas
Admin Auth is generated and implemented, but it is not part of the active Admin Web compatibility matrix.

## Verification
Run Admin unit/integration tests, typecheck/lint, fresh migrations, and the Root generated-contract byte check for the provider mirror.
