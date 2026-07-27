---
architectureIndex: 1
rootId: platform.site
owners:
  - "@LordFoxFairy"
---

# Site module

## Responsibilities
Own Site identity, host/config resolution, lifecycle state, branding/configuration, and current Site administration APIs.

## Non-responsibilities
Site does not render a Site Web project, share user accounts across Sites, or own subscription/credit facts.

## Public boundary
Application services plus `src/interfaces/http`, `admin`, and `cli` are the supported entrypoints.

## Callers and dependencies
Web/Platform resolve Site context through server-side APIs; private Prisma data is never read directly by other services.

## Data ownership and events
This package owns Site records, host mappings, lifecycle/config revisions, migrations, and Site-domain events.

## Runtime and security
Unknown production hosts fail closed. Site context is server-resolved and cannot be selected by an untrusted browser field.

## Idempotency, failure, and recovery
Site creation/config publication use stable identities and revisions; release activation/rollback require auditable attempts in Wave 1.

## Extension rules and forbidden dependencies
Add Site business rules to domain/application and adapters to interfaces/infrastructure. Do not couple one Site to another Site's account state.

## Current gotchas
Independent Site Web artifact/fleet release authority is not fully implemented by this module yet.

## Verification
Run `pnpm --filter @kokoro/site test`, typecheck/lint, migrations, and multi-host isolation tests.
