---
architectureIndex: 1
rootId: platform.hub
owners:
  - "@LordFoxFairy"
---

# Capability Hub module

## Responsibilities
Own Skill/MCP catalog administration, revisions, enablement, package metadata, uploads, and operator-facing capability workflows.

## Non-responsibilities
Hub does not execute Agent tools or own GA graph nodes. Admission serves the frozen non-secret catalog; Hub resolves the exact frozen execution assembly and streams skill artifacts to Agent over its private mTLS ConnectRPC boundary.

## Public boundary
`src/interfaces/http` and `src/interfaces/admin` expose Hub-owned product surfaces; package/storage contracts live under `src/contract` and application ports. `src/interfaces/connect` exports only owner-neutral process lifecycle, health and secure-file helpers. Root-generated Connect providers, projection client adapters and the production main live once under Platform `src/modules/hub` and `src/process/hub-connect.ts`; the Hub package has no generated-contract mirror or second runtime entrypoint.

Admin MCP registration is an admission boundary, not a raw repository proxy: `env:VAR` references are accepted only when `VAR` is in `KOKORO_HUB_ENV_REF_ALLOWLIST`, and URL transports are resolved before persistence. The default policy requires HTTPS and admits only public-unicast IP literals/DNS answers; all special or non-unicast ranges, including IPv4-mapped forms, are rejected. `KOKORO_HUB_ALLOW_INSECURE_URL=1` is honored only outside production and only relaxes the HTTP scheme—the same address classifier remains mandatory.

## Callers and dependencies
Admin and Platform orchestration write through Hub. Platform freezes a SiteRelease-bound catalog through private ConnectRPC. Agent alone consumes `ResolveExecutionAssembly` and `FetchSkillArtifact`; it must present the exact `agent_catalog_ref` and ordered grants issued by Session.

Hub has no separate identity-package dependency. Self-service remains fail-closed until the PostgreSQL Platform membership owner adapter is injected; do not add a second identity authority.

## Data ownership and events
Hub owns capability catalog/revision metadata and package references in Mongo/S3-compatible storage. A frozen catalog is immutable, Ed25519-signed with an explicit key revision, and carries its durable Platform projection state in the same Mongo document.
Agent never reads Hub Mongo or package storage directly.

## Runtime and security
Uploads require validation, content addressing, bounded size/path rules, trusted operator context, and secret-free metadata.
`createHubServer` receives the parsed env-ref allowlist and URL resolver policy explicitly; the real HTTP assembly derives them from validated env. Missing admission configuration fails closed rather than letting fake/test assembly bypass the same contract.
The HTTP server exposes only self-service and admin routes. `KOKORO_SERVICE_PACKAGE=platform-hub-connect`
starts a separate production process for the private ConnectRPC listener; it is never co-hosted with
the HTTP server. Exact Platform and Agent SPIFFE identities are pinned independently, and Agent can
invoke only the existing `HubRuntimeService`. Connect traffic uses 4252; a separate dependency-aware
probe listener uses 4253 and is not service-discovered. A single skill artifact is capped at 32 MiB;
one assembly is capped at 64 MiB compressed and 128 MiB unpacked. The Agent/Hub Connect contract has
a fixed 30-second maximum request deadline that is not runtime-configurable; missing, zero, or larger
advertised timeouts fail before service dispatch. The listener has fixed global and per-peer request
caps, and cancellation reaches package reads and artifact chunking rather than leaving detached I/O.

All official Hub Admin namespace resources (skill catalog, skill revision uploads, skill curation, and MCP servers) are explicitly platform-global (`siteScopeField: null`). The Platform Admin control plane therefore exposes them only to operators with wildcard Site scope; no finite Site scope is treated as an implicit namespace filter.

## Idempotency, failure, and recovery
Revision/CAS and content hashes handle duplicate publication; package-first metadata-second writes prevent dangling live references. Freeze command identity, request digest, publication, and projection intent are inserted atomically. Ambiguous projection delivery reconciles the exact Platform receipt before retrying the same command identity.

## Extension rules and forbidden dependencies
Add new capability kinds only through the approved closed registry. Do not model DeepAgents internal graph nodes as catalog capabilities.

## Current gotchas
V1 capability kind is limited to Skill and MCP; later runtime grants must preserve GA's opaque namespace boundary.

## Verification
Run `pnpm --filter @kokoro/hub test`, typecheck/lint, and Mongo/MinIO-backed integration tests.
