---
architectureIndex: 1
rootId: platform.user
owners:
  - "@LordFoxFairy"
---

# User and identity module

## Responsibilities
Own current user identity, authentication-related application workflows, email adapter, and user administration records.

## Non-responsibilities
User does not own Admin operators, Session messages, Site Web cookies, or cross-Site account federation by implicit shared rows.

## Public boundary
Application services and `src/interfaces/http`/`admin` expose supported operations; persistence/auth/email adapters remain private.

## Callers and dependencies
Platform identity orchestration and trusted Web backends call this module through declared APIs.

## Data ownership and events
This package owns user/auth records, subject generation, migrations, and user-domain events within its current schema.

## Runtime and security
Authentication inputs are untrusted, tokens require expiry/audience policy, and Site/account association is resolved server-side.

## Idempotency, failure, and recovery
Identity effects require stable command identity, unique constraints, token one-time semantics, and auditable recovery.

## Extension rules and forbidden dependencies
Add identity behavior through application ports. Cross-Site federation must use explicit OAuth/federation, never direct account-table sharing.

## Current gotchas
Wave 1 still must freeze final Site-scoped Identity/Workspace/Project and RequestSecurityContext contracts.

## Verification
Run `pnpm --filter @kokoro/user test`, typecheck/lint, migrations, and identity security integration tests.
