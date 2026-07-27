---
architectureIndex: 1
rootId: platform.deploy.docker
owners:
  - "@LordFoxFairy"
---

# Platform deployment image

## Responsibilities
Build the independently deployable Platform artifact from this repository's lock, source, migrations, and generated contracts.

## Non-responsibilities
The image does not embed sibling repositories, Root contract source, production secrets, or Root Infra orchestration.

## Public boundary
`Dockerfile` is the repository-owned image build entrypoint exercised by Platform CI.

## Callers and dependencies
Platform CI and release automation build the image after local gates and integration tests pass.

## Data ownership and events
The image owns no data; runtime modules own schemas/migrations and external stores own durable bytes.

## Runtime and security
Build context excludes development artifacts while explicitly retaining the generated Admin RPC contract mirror.

## Idempotency, failure, and recovery
The same commit/lock inputs must produce a traceable artifact; release rollback selects a previous verified digest.

## Extension rules and forbidden dependencies
Keep service build logic here and dependency installation lock-driven. Do not copy sibling worktrees or `.env` files.

## Current gotchas
CI currently builds but does not yet publish, sign, or attach SBOM/provenance to the image.

## Verification
Run the repository CI artifact job or `docker build --file deploy/docker/Dockerfile --tag kokoro-platform:test .` after all gates.
