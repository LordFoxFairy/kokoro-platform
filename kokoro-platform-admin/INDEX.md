---
architectureIndex: 1
rootId: platform.admin
owners:
  - "@LordFoxFairy"
---

# Platform Admin service

## Responsibilities
Expose privileged Platform administration APIs, own Admin Auth persistence/effects, and compose module administration workflows.

## Non-responsibilities
Admin Web does not share this service's database, and this service does not render UI or own public Site sessions.

## Public boundary
Generated Connect services and explicitly registered administrative HTTP endpoints are the only remote boundary; see [`src/INDEX.md`](src/INDEX.md).

## Callers and dependencies
Admin Web calls through workload-authenticated generated clients. The service invokes Platform application/module ports.

## Data ownership and events
This package owns operator, verification-token effect, auth event, command receipt, and its Prisma migrations.

## Runtime and security
Workload identity, audience/environment checks, bounded requests, typed safe errors, security audit, and secret rotation fail closed.

## Idempotency, failure, and recovery
Effect commands persist canonical protobuf digests and receipts transactionally; clients reconcile timeout-after-commit by receipt query.

## Extension rules and forbidden dependencies
Add privileged workflows through application services and generated contracts. Never restore Web Prisma access or hand-written transport schemas.

## Current gotchas
Admin Auth is the Connect pilot; other Platform modules remain local or legacy protocol until their approved wave.

## Verification
Run package unit/integration tests, typecheck/lint, fresh migrations, and Root Admin Auth compatibility.
