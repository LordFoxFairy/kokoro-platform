# Kokoro Platform deployment topology

## Authority and artifact

Platform has one PostgreSQL authority and one repository-owned production image. The same digest is
promoted across environments; `KOKORO_SERVICE_PACKAGE` selects a fixed compiled entrypoint and never
accepts a module path.

| Process | Store/role | Purpose |
|---|---|---|
| `platform-migrator` | PostgreSQL migrator | one-shot schema/ACL migration |
| `platform-api` | PostgreSQL API role | public mTLS HTTPS owner on 4100; pod-only HTTP probes on 4101 |
| `platform-admission` | PostgreSQL Admission role | Admission Connect owner |
| `platform-authorization` | PostgreSQL authorization role | session authorization feed |
| `platform-asset-data-plane` | PostgreSQL asset-data-plane role | capability-scoped multipart provider effects |
| `platform-model-gateway` | PostgreSQL model-gateway role | authorized provider invocation |
| `platform-commerce-worker` | PostgreSQL Commerce worker role | Commerce/Credit fulfillment outbox delivery |
| `platform-site-worker` | PostgreSQL Site worker role | Site provider promotion, observation and traffic drain |
| `platform-asset-worker` | PostgreSQL Asset worker role | upload completion, scanning, promotion and exact cleanup |
| `platform-admin-worker` | PostgreSQL Admin worker role | privileged command execution and terminalization |
| `platform-identity-worker` | PostgreSQL Identity worker role | Identity-only outbox delivery and local namespace allocation |
| `platform-authorization-maintenance` | PostgreSQL Authorization maintenance role | scheduled retention with advisory-lock exclusion |
| `platform-admin` | PostgreSQL Admin role | typed privileged control plane |
| `@kokoro/hub` | Mongo/S3 | skill/MCP HTTP management surface |
| `platform-hub-connect` | Mongo/S3 | private catalog publication and Agent runtime resolution |

The retired per-domain MySQL services are not deployables and must not appear in image selectors,
Compose, Kubernetes, CI services, service discovery, or release manifests.

## Startup order

1. Provision PostgreSQL 18 and the distinct roles named by `deployables.yaml`.
2. Run `platform-migrator` to completion.
3. Start root runtime processes with their own database credentials.
4. Start Hub HTTP and Hub Connect as separate processes with Mongo/package storage. Hub Connect also
   requires signing material, exact inbound Platform/Agent peers, and outbound Platform projection mTLS.
5. Enable traffic only after each process-specific readiness check succeeds.

No runtime identity may use the migrator credential. No process falls back to an in-memory store or
another database.

## Docker Compose

`deploy/docker-compose.services.yml` contains only root Platform processes and Hub. It expects
role-specific `DATABASE_URL_PLATFORM_*` variables plus Hub Mongo configuration from the caller's
environment. It does not start infrastructure implicitly and never supplies development credentials.

`platform-api` has no network outbound contract beyond its PostgreSQL authority. Its public listener
uses mandatory client certificates on 4100, while its unpublished HTTP listener on 4101 serves only
`/health/live` and `/health/ready`; Compose health checks therefore need no client private key. The
17 `PLATFORM_*_FILE` values in `.env.example` are explicit host paths. Compose binds each file
read-only to its canonical name under `/run/secrets/platform-api` and supplies that directory as
`PLATFORM_API_FILE_TRUST_ROOT`. The set covers the product workload registry; Session access and
authorization-event signing rings; public key/certificate/client CA; Commerce redemption ring;
Asset policy/capability rings; and all eight Identity password, verification, session, refresh,
reauthentication, audit, delivery and TOTP materials.

Private API files must be 0400/0600 for the configured runtime UID or 0440/0640 for its dedicated
runtime GID. The reader rejects group/world write, execute, and world access. It accepts bounded
Kubernetes AtomicWriter symlinks only when every hop stays inside a stable non-symlink trust root,
then correlates the final path with one `O_NOFOLLOW` descriptor before and after bounded I/O.

`platform-hub-connect` uses Connect 4252 and an unpublished probe-only port 4253. The Compose bind
directory named by `KOKORO_HUB_CONNECT_SECRETS_DIRECTORY` must contain `server.key`, `server.crt`,
`client-ca.crt`, `inbound-peers.json`, `catalog-signing.key`, `platform-client.key`,
`platform-client.crt`, and `platform-ca.crt`; private key files must be mode 0400/0600 or mode 0440
for a dedicated workload group. `KOKORO_HUB_CONNECT_TRUST_ROOT` must name that exact mounted
directory; startup permits only a bounded Kubernetes AtomicWriter symlink chain whose final regular
file remains inside the resolved trust root, and opens the target with `O_NOFOLLOW` plus inode and
post-read snapshot checks. The storage
YAML named by `KOKORO_WORKSPACE_CONFIG_FILE` must have a production `hub` object-store entry.

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

For `platform-hub-connect`, create these referenced objects before rollout:

- ConfigMap `platform-hub-connect-runtime`: `KOKORO_HUB_MONGO_DB`, both caller SAN URIs,
  capability signing key ref, Platform projection base URL and server name.
- Secret `platform-hub-connect-secrets`: Mongo URL, S3 access/secret keys, and Hub secret master key.
- Secret `platform-hub-connect-files`: the eight files listed for Compose; the volume declares
  `defaultMode: 0400`. Kubernetes AtomicWriter links are accepted only inside the mount trust root;
  a dedicated non-root fsGroup may add group-read but never group-write/execute or world access.
- ConfigMap `platform-hub-connect-storage`: `storage.yaml` with the Hub package-store declaration.

The Kubernetes Service publishes only 4252. Port 4253 remains pod-local to probes, so health checks
never require or gain a caller mTLS private key.

For `platform-api`, `platform-api-secrets` contains only environment credentials such as
`DATABASE_URL_PLATFORM`. Secret `platform-api-files` contains the 17 canonical filenames declared by
the machine-readable runtime contract and the manifest projects them at mode 0440. The pod runs as
UID/GID 1000 with `fsGroup: 1000`, a read-only root filesystem, no service-account token, no Linux
capabilities and no privilege escalation. Service `platform-api` publishes only the mTLS public port
4100; health port 4101 is declared on the container solely for kubelet startup/liveness/readiness
probes and is absent from the Service.

All polling worker Deployments expose only an internal health port. Startup/liveness read `/health/live`;
readiness reads `/health/ready`, which turns unavailable before claims are drained. Their 30-second
Pod grace period exceeds the bounded 10-second worker shutdown budget.
Authorization maintenance is a run-to-completion CronJob with `concurrencyPolicy: Forbid`, a bounded
active deadline and a PostgreSQL advisory lock; it never runs inside a polling worker.

## Multi-Pod rules

- durable state, idempotency, leases, receipts, and outbox work live in PostgreSQL or Hub-owned stores;
- migrations are a singleton release step, never an application startup side effect;
- shutdown stops admission/claims before returning leases and closing database pools;
- mTLS/Connect services use distinct workload identities and bounded request sizes;
- production credentials are process-specific; Commerce, Site, Asset, Admin, Identity and Authorization
  maintenance never share a runtime database role, secret mount or worker lifecycle;
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
