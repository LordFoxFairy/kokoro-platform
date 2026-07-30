# Kokoro Platform deployment topology

## Authority and artifact

Platform has one PostgreSQL authority and one repository-owned production image. The same digest is
promoted across environments; `KOKORO_SERVICE_PACKAGE` selects a fixed compiled entrypoint and never
accepts a module path.

| Process | Store/role | Purpose |
|---|---|---|
| `platform-migrator` | PostgreSQL migrator | one-shot schema/ACL migration |
| `platform-api` | PostgreSQL API role | public Platform HTTP owner |
| `platform-admission` | PostgreSQL Admission role | Admission Connect owner |
| `platform-authorization` | PostgreSQL authorization role | session authorization feed |
| `platform-asset-data-plane` | PostgreSQL asset-data-plane role | capability-scoped multipart provider effects |
| `platform-model-gateway` | PostgreSQL model-gateway role | authorized provider invocation |
| `platform-worker` | PostgreSQL worker role | durable reconciliation/outbox work |
| `platform-admin` | PostgreSQL Admin role | typed privileged control plane |
| `@kokoro/hub` | Mongo/S3 | skill/MCP management and runtime resolution |

The retired per-domain MySQL services are not deployables and must not appear in image selectors,
Compose, Kubernetes, CI services, service discovery, or release manifests.

## Startup order

1. Provision PostgreSQL 18 and the distinct roles named by `deployables.yaml`.
2. Run `platform-migrator` to completion.
3. Start root runtime processes with their own database credentials.
4. Start Hub with Mongo, package storage, and caller-secret configuration.
5. Enable traffic only after each process-specific readiness check succeeds.

No runtime identity may use the migrator credential. No process falls back to an in-memory store or
another database.

## Docker Compose

`deploy/docker-compose.services.yml` contains only root Platform processes and Hub. It expects
role-specific `DATABASE_URL_PLATFORM_*` variables plus Hub Mongo configuration from the caller's
environment. It does not start infrastructure implicitly and never supplies development credentials.

```bash
docker compose -f deploy/docker-compose.services.yml config
docker compose -f deploy/docker-compose.services.yml up platform-migrator
docker compose -f deploy/docker-compose.services.yml up -d
```

## Kubernetes

`deploy/k8s/platform-services.example.yaml` is a secret-free shape example. Replace
`RELEASE_DIGEST`, create the referenced ConfigMap/Secrets, run the migration Job first, and expose
only the Service objects required by the environment. TLS files, peer registries, OIDC clients,
keyrings, provider credentials, and database URLs belong in managed Secrets.

## Multi-Pod rules

- durable state, idempotency, leases, receipts, and outbox work live in PostgreSQL or Hub-owned stores;
- migrations are a singleton release step, never an application startup side effect;
- shutdown stops admission/claims before returning leases and closing database pools;
- mTLS/Connect services use distinct workload identities and bounded request sizes;
- production credentials are least-privilege and process-specific;
- rollbacks select a prior verified image digest and compatible PostgreSQL schema, never a retired
  MySQL service.

## Verification

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm lint
pnpm typecheck
pnpm test
pnpm build:runtime
node --test test/repository/production-image.test.mjs
```

The repository task does not start Docker. CI owns the actual image build after static, unit, and Hub
integration gates pass.
