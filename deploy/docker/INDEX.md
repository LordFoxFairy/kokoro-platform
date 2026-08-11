---
architectureIndex: 1
rootId: platform.deploy.docker
owners:
  - "@LordFoxFairy"
---

# Platform deployment image

## Responsibilities
Build the independently deployable, production-only Platform artifact from this repository's lock, source, migrations, and generated contracts.

## Non-responsibilities
The image does not embed sibling repositories, Root contract source, production secrets, or Root Infra orchestration.

## Public boundary
`Dockerfile` is the repository-owned image build entrypoint exercised by Platform CI.

## Callers and dependencies
Platform CI and release automation build the image after local gates and integration tests pass.

## Data ownership and events
The image owns no data; runtime modules own schemas/migrations and external stores own durable bytes.

## Runtime and security
The multi-stage build installs full dependencies only in the build stage, compiles each runnable package, installs production dependencies in an isolated stage, and assembles a non-root runtime image without source or test trees. A build-time verifier rejects development toolchains such as TypeScript, tsx, Vitest, Vite, and ESLint from the final image. The fixed runtime entrypoint maps `KOKORO_SERVICE_PACKAGE` only to known compiled service entries; it does not evaluate arbitrary module paths. `@kokoro/hub` selects the Hub package HTTP main, while `platform-hub-connect` selects the Platform-root Connect main that consumes the one canonical generated contract tree; both are distinct processes in the same artifact.
Production dependency installation retains platform-selected optional packages because
`@node-rs/argon2` ships its Linux native runtime through `optionalDependencies`. The image verifier
loads the package from the assembled `/app` dependency tree, so a missing or incompatible native
binding fails the build rather than the Identity path at startup. Prisma's optional peer may resolve
the repository's TypeScript version during installation; that development package and executable are
removed before the production tree is copied, including every nested `.bin/tsc` and dangling peer
link. The verifier recursively rejects any remaining nested TypeScript executable while the
target-platform Argon2 binding remains.
The closed selector set also includes the one-shot `platform-core-single-site-bootstrap` entry. It
has no listener and is invoked with seven absolute file paths; Root supplies distinct Admin/API/Site
worker/Identity worker database credentials and read-only secret mounts for its bounded run.
The image also exposes `platform-core-single-site-prepare` for Root's verified-image provisioning
preflight. It accepts exactly four absolute paths and atomically creates a mode-`0700` state tree;
it has no listener and is deliberately not declared in `deployables.yaml` or the release one-shot
job inventory.
Compose never defaults Admission to a fixed PostgreSQL principal: both the migrator and Admission
process require the same externally leased `PLATFORM_DATABASE_ADMISSION_ROLE`, and Admission's URL
must authenticate as that exact `kt_pg_*` login.
The verifier also requires both compiled core single-Site selectors, the Platform API runtime contract, production composition and
stable secret-file reader, so the API cannot be released with only its process entrypoint present. Before TypeScript emission,
the compiler-graph gate proves that every module `infrastructure/dev` source is excluded and fails if production code imports one.

## Idempotency, failure, and recovery
The same commit/lock inputs must produce a traceable artifact; release rollback selects a previous verified digest.
Core bootstrap first reserves an adjacent private output-pair descriptor, then writes its private
redemption code before the safe result completion marker; every file is atomic at mode `0600`.
Re-entry recovers a matching completed receipt through strict database readback before loading fresh
maker/checker authorization files. Claimed or void codes are verify-only and are never re-exported.

## Extension rules and forbidden dependencies
Keep service build logic here and dependency installation lock-driven. Do not copy sibling worktrees or `.env` files.

## Current gotchas
The final image contains only root PostgreSQL Platform processes, independently selected Commerce,
Site, Asset, Admin and Identity workers, the one-shot Authorization maintenance process, the
independent Hub HTTP/Connect entries, and Platform Kit. Retired
per-domain packages are excluded from the workspace and Docker context. Hub self-service membership
is intentionally fail-closed until its PostgreSQL Platform owner adapter is mounted. CI currently
builds but does not yet publish, sign, or attach SBOM/provenance to the image.

## Verification
Run `node --test test/repository/production-image.test.mjs` for the closed-layout verifier. The
repository CI artifact job performs the actual Docker build after all static/runtime gates.
