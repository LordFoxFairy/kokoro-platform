---
architectureIndex: 1
rootId: service.platform
owners:
  - "@LordFoxFairy"
---

# Kokoro Platform

## Current production architecture

The root Prisma 7/PostgreSQL implementation is the only Platform business authority. Site, identity, authorization, policy,
model control, credit/usage, commerce redemption, assets, Admission and privileged Admin all live in this source tree and share
one migration authority. API, worker, Admission, Authorization, Asset Data Plane, Artifact Data Plane, Model Gateway, Admin, Migrator, Hub HTTP and Hub Connect remain
independently selectable processes with exact database credential classes. PostgreSQL RLS, security-definer projections and
process-specific grants enforce the internal boundaries. Split workers additionally bind their configured role name to a
migrator-maintained PostgreSQL role OID and use only operation-fenced security-definer routines for authority row locks; no worker
receives broad authority-table UPDATE. This PostgreSQL implementation is the sole business authority.

## Responsibilities

Own shared Site, identity, Product Catalog publication, model-control, credit, commerce, capability, and privileged Admin business facts in a modular TypeScript service repository.

## Non-responsibilities

Platform does not execute Agent graphs, own Session messages/SSE, render Site Web applications, or absorb child repository lifecycles.

## Public boundary

Ordinary Site product traffic uses the bounded public HTTP/JSON BFF contract. Privileged control planes use Root-owned
Protobuf/Connect contracts: Admin Identity/Query/Commerce/Credit/Site Provisioning/Model Control and the declared-only Product Catalog publication provider, Session Admission and Asset Eligibility, Hub capability
publication/runtime, and Agent Model Gateway. Same-Platform bounded contexts never self-RPC; application ports and one scoped
transaction coordinate local owners. Root `src/index.ts` exposes only the Platform composition surface, and
`deploy/docker/Dockerfile` builds the closed runtime artifact. `platform-hub-connect` selects the private Hub
Connect entrypoint independently from the `@kokoro/hub` HTTP process. Root-generated contracts,
protobuf modules and JSON-schema validators live once under `src/generated`; Platform-root Hub Connect
adapters consume that tree while Hub retains its business owners and package-local lifecycle helpers.

Product Catalog publication owns global immutable Product/Surface and product-level LaunchProfile
revisions. Its provider code is mounted but remains contract-only and fail-closed because the current
Root wire supplies only immutable bindings, not authenticated canonical document bytes. It must not
receive runtime traffic until the Root-owned signed bundle resolver and compatibility evidence exist.
Its canonical Root JSON Schema and Proto outputs come from the same repository-level generated tree and
provenance as every other provider; no package-local vendor or generator is retained. Owner-scoped
append-only attestations, not the shared mutable command receipt alone, authorize replay. Publication
`uint64` values use exact `NUMERIC(20,0)` storage.

Artifact metadata, capability issuance and revocation stay on the generated JSON control plane. Capability redemption uses a
dedicated non-JSON streaming handler and independently selectable `platform-artifact-data-plane` process. That process pins the
built-in `postgres-s3-v1` owner, exact least-privilege database routines, private S3 reads and mTLS ProductWorkload admission.
Root currently registers only GET redemption; Platform does not invent HEAD or conditional request semantics.

## Callers and dependencies

Web Admin calls the generated Admin Identity, Query, Commerce, Credit, Site Provisioning, and Model Control services. Session consumes versioned internal APIs; Agent reaches model/capability backends only through approved runtime protocols.

## Data ownership and events

Each module owns its schema/migrations and domain events. Cross-module orchestration must use application ports and an explicit Platform transaction boundary.

Generic dangerous Admin effects and Site lifecycle effects keep separate approval authorities:
`platform.admin_approval` rejects Site lifecycle operations, while `platform.site_effect_approval` owns their
UUID identity plus trusted environment/region axes. UUID identity is owner-qualified, so the two authorities may
hold the same UUID. AdminQuery exposes one read-only pending projection by unioning both owners in exact
`(admitted_at, owner, approval_ref)` keyset order; its opaque cursor preserves PostgreSQL microseconds and the
owner discriminator. Exact `admin.approval.list` RLS applies environment, region and global/Site/breakglass scope
before either owner row is visible. BreakGlass resources use canonical `generic_admin:<uuid>` and
`site_lifecycle:<uuid>` references; no projection can write or bypass RLS.

## Runtime and security

Every request resolves trusted workload and Site context before business use. The public API serves
mandatory-client-certificate HTTPS on 4100 and a distinct pod-only HTTP health listener on 4101.
Its machine-readable runtime contract enumerates every mounted registry, TLS, Session, Commerce,
Asset and Identity file. Production readers support read-only Kubernetes AtomicWriter/fsGroup mounts
through a stable trust root and `O_NOFOLLOW` descriptor checks; group/world-writable, executable or
world-accessible private material is rejected. Secrets remain environment/secret-manager owned and
private tables are never cross-service APIs.

## Idempotency, failure, and recovery

Effect commands use durable receipts, stable idempotency keys, transactional writes, and reconciliation after ambiguous timeouts.
Commerce, Site, Asset, Admin and Identity workers consume only their owner-filtered effects with independent credentials,
health and drain lifecycles. Authorization retention is a one-shot scheduled maintenance process guarded by a PostgreSQL
advisory lock. Identity verification delivery uses signed, idempotent HTTPS and Identity namespace allocation commits as a
local projection; none of these paths self-call Platform RPC.

## Extension rules and forbidden dependencies

Keep domain/application independent of transport and persistence. Add deployable adapters inside the owning module; do not create a new Git repository solely for directory separation.

## Current gotchas

General Admission is the only constructor of sealed GA execution material and the owner of Site/model/capability/asset/credit
admission decisions. Model Gateway owns resumable chat provider effects, encrypted frame journals, Credit evidence and LiteLLM
adaptation; Agent consumes only the opaque authorization and verifies the frame digest chain. Image, music, video and audio execution
must use dedicated Media product routes instead of expanding the chat corpus. Payment provider connectors may remain disabled
per Site; card redemption reaches the same Commerce fulfillment and Credit grant path as a successful purchase.
The API health port is probe-only and must never be added to a Service or Ingress; ordinary HTTP
probes cannot authenticate to the mTLS public listener.

## Verification

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and dependency-backed `pnpm test:integration` before release.
