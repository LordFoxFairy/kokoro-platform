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
- `platform-core-single-site-bootstrap` (one-shot owner composition; no listener)
- `platform-core-single-site-prepare` (verified-image preflight selector; not a release deployable)

`kokoro-platform-kit` is the only shared runtime library workspace. Hub reuses the same artifact but
has two independent processes: `@kokoro/hub` is the package-owned HTTP management surface and
`platform-hub-connect` is the Platform-root private mTLS catalog/runtime composition. The latter
consumes the repository's one canonical Root-generated tree under `src/generated`; Hub keeps the
business owners but has no generated mirror or second Connect main. The processes share Mongo/S3
ownership but never a process or listener. LiteLLM is an external provider gateway, not a package or
process shipped in this image.

The bootstrap selector is invoked as:

```bash
node --conditions=kokoro-runtime dist/src/process/core-single-site-bootstrap.js \
  --file ABS --result ABS --redemption-code ABS \
  --maker-attestation ABS --maker-public-key ABS \
  --checker-attestation ABS --checker-public-key ABS
```

It uses distinct `DATABASE_URL_PLATFORM_{ADMIN,API,SITE_WORKER,IDENTITY_WORKER}` bindings. A matching
completed receipt is recovered by strict readback before attestation files are opened; new effects
require fresh maker/checker signatures and the public Site release certification key ring. The result
path also owns a mode-`0600` `.pair` descriptor that binds the result and redemption-code digests;
claimed or void codes are verified in place and are never exported again.

Before a fresh core install, Root runs the same verified Platform image with the preflight selector:

```bash
node --conditions=kokoro-runtime dist/src/process/core-single-site-prepare.js \
  --operator-config ABS --web-report ABS --deployment-facts ABS --state-directory ABS
```

The strict operator file contains only the initial owner email and Direct endpoint/model key. The
selector cross-checks the verified Web OCI report against Root deployment facts, creates one
non-rotating Platform-owned installation beneath the mode-`0700` state directory, and publishes a
release-specific safe receipt plus `runtime-paths.env`. All generated documents, authorization,
certification, passwords, entropy and Platform key-ring files remain mode `0600`; stdout contains
only the receipt path and digest. This preflight selector is invoked directly from the verified image
before provisioning and is intentionally absent from `deployables.yaml` and release job inventory.
The installation also carries a public-only Authorization event verification set whose revision,
window and public key are checked against the private Platform API signing ring on every prepare.

Root contracts, protobuf modules and JSON-schema validators are checked in exactly once under
`src/generated/{contracts,proto,schema}` with `src/generated/provenance.json`. Prisma output alone is
build-local under `src/generated/platform-prisma`. Package-local vendors and per-service generated
mirrors are not supported.

## Database authority

`DATABASE_URL_PLATFORM` must be PostgreSQL and must use the exact credential class for the selected
process. Runtime roles are distinct from the migrator and are verified against the expected database,
role, PostgreSQL major version, schema ownership, grants, and RLS policy before serving traffic.
There is no authority-mode switch: PostgreSQL is the Platform authority.

Admission is the one rotating runtime identity: `PLATFORM_DATABASE_ADMISSION_ROLE` must name a
run-scoped `kt_pg_*` login matching `DATABASE_URL_PLATFORM`. PostgreSQL bootstrap creates that login
without business grants; `platform-migrator` grants the current lease, pins its role OID, and strips
all authority from the superseded lease. A fixed `platform_admission` database role is not part of
the production topology; the same text used by `app.workload_kind` is an application fence only.

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
verifier rejects source trees, dev tooling, unexpected workspaces, incomplete
migrations, and missing compiled entrypoints.

See [deployment topology](docs/platform/deployment-topology.md) and
[Docker image boundary](deploy/docker/INDEX.md).
