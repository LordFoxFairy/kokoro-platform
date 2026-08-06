# kokoro-platform

Kokoro Platform is the PostgreSQL-backed platform authority. Site, identity, model control,
credit/usage, commerce redemption, authorization, assets, Admission, and Admin are bounded
contexts in the root `src/` tree and share one migration authority under `prisma/`.

## Production boundary

The production artifact has one closed runtime set:

- `platform-api`
- `platform-admission`
- `platform-authorization`
- `platform-asset-data-plane`
- `platform-artifact-data-plane` (certified PostgreSQL authorization/audit owner plus private S3 reader)
- `platform-model-gateway`
- `platform-commerce-worker`
- `platform-site-worker`
- `platform-asset-worker`
- `platform-admin-worker`
- `platform-identity-worker`
- `platform-admin`
- `platform-authorization-maintenance`
- `platform-migrator`
- `@kokoro/hub`
- `platform-hub-connect`

`kokoro-platform-kit` is the only shared runtime library workspace. Hub reuses the same artifact but
has two independent processes: `@kokoro/hub` is the package-owned HTTP management surface and
`platform-hub-connect` is the Platform-root private mTLS catalog/runtime composition. The latter
consumes the repository's one canonical Root-generated tree under `src/generated`; Hub keeps the
business owners but has no generated mirror or second Connect main. The processes share Mongo/S3
ownership but never a process or listener. LiteLLM is an external provider gateway, not a package or
process shipped in this image.

Root contracts, protobuf modules and JSON-schema validators are checked in exactly once under
`src/generated/{contracts,proto,schema}` with `src/generated/provenance.json`. Prisma output alone is
build-local under `src/generated/platform-prisma`. Package-local vendors and per-service generated
mirrors are not supported.

The directories `kokoro-site`, `kokoro-user`, `kokoro-model`, `kokoro-credit`, `kokoro-payment`,
and `kokoro-platform-admin` are retired source archives. They are deliberately absent from the
pnpm workspace, root dependencies, lock importers, TypeScript build, lint, tests, Docker build
context, final image, runtime selector, Compose/Kubernetes templates, CI, and release artifact.
They are not a rollback path and receive no data migration compatibility.

## Database authority

`DATABASE_URL_PLATFORM` must be PostgreSQL and must use the exact credential class for the selected
process. Runtime roles are distinct from the migrator and are verified against the expected database,
role, PostgreSQL major version, schema ownership, grants, and RLS policy before serving traffic.
There is no authority-mode switch: PostgreSQL is the Platform authority.

Migrations run only through `platform-migrator`; runtime processes have no DDL capability.

## Development and verification

Use Node 24 and pnpm 11.2.2:

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm lint
pnpm typecheck
pnpm test
pnpm build:runtime
```

Hub integration uses Mongo and its configured package store:

```bash
pnpm test:integration
```

PostgreSQL component tests require a PostgreSQL 18 database and distinct least-privilege
roles. They never start an implicit local database.

## Deployment

`deployables.yaml` is the process-role inventory. `deploy/docker/Dockerfile` creates one production
image, and `deploy/docker/runtime-entrypoint.mjs` selects only the closed runtime set above. The image
verifier rejects source trees, dev tooling, unexpected workspaces, retired packages, incomplete
migrations, and missing compiled entrypoints.

See [deployment topology](docs/platform/deployment-topology.md) and
[Docker image boundary](deploy/docker/INDEX.md).
