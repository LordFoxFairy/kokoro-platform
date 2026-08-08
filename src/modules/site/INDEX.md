---
architectureIndex: 1
rootId: service.platform.site
owners:
  - "@LordFoxFairy"
---

# Site authority

This module owns the stable Site identity, immutable SiteRelease facts, trusted project/deployment
bindings, and durable activation lifecycle inside the Platform bounded context. Authorization tables
are downstream security projections; they are never the Site source of truth.

An activation freezes the candidate artifact, manifest and certification digests plus the expected
active pointer. Provider promotion is observed under the same operation key before the pointer can
advance. A concurrent pointer change fails closed. Rollback is another activation of an older
immutable release, and resuming a suspended Site returns to `preview_ready` so a fresh activation is
mandatory. Decommissioned identities are tombstones and can never resume or be reused.

Suspension and decommission are traffic-stop sagas, never direct Site state changes. Their request
transaction immediately fences authorization and moves the active deployment to draining. Only an
immutable observation from the exact configured provider namespace, environment and region may
finalize the Site as suspended or decommissioned. Ambiguous effects remain reconcilable; only a
provider observation of stopped traffic is success. Resume is the sole direct lifecycle command.

The domain layer is transport- and database-independent. Application, PostgreSQL and Admin/worker
adapters preserve authority transitions and command receipts in one owner transaction. Only
the Site runtime worker locks project bindings through its role-, workload- and operation-fenced PostgreSQL routine; the worker
does not receive direct UPDATE authority on `site_project_binding`. Only
`site.activation.begin.v1` and `site.traffic-stop.request.v1` cross that transaction through
`SiteEffectQueuePort`, because they trigger real provider effects. Registration, release publication,
observations, commits, drain completion and resume are already authoritative local facts and never become
generic outbox events. The Site worker claims the exact two-type allowlist and dead-letters any unknown type.
It starts an immediate ownership-confirming renewal and a one-third-window heartbeat for every lease in the
claimed batch before dispatching the first provider effect. Queued effects therefore keep their leases while
earlier effects run; a lost lease is rejected before provider dispatch, and renewal loss aborts any in-flight
provider call. Abort and lease loss never consume retry budget or acknowledge the effect. Shutdown stops new
claims before releasing leases through the exact worker, `site-worker` consumer and two-event-type allowlist.
Promotion responses echo the exact operation, Site/project, Release, artifact/manifest/certification digests,
environment and region plus a canonical command digest. The RPC adapter verifies that provider-authored binding
before the state store may persist an observation; state-store code never manufactures Release evidence from the
local attempt.

Fresh Site creation remains on the typed `SiteProvisioningService`; publication is a separate owner boundary.
The new authority core implements the one-way Root chain through immutable Candidate and publication revisions:
Product Catalog/Profile are locked from their owner tables, `SiteEffectiveAccessSnapshotPort` composes Commerce,
Model, Hub, Auth and Memory owner revisions in the same Platform transaction, and Platform—not the operator—builds
the canonical Candidate. Inventory, Material, Intent, attestor Evidence, Certification and final SiteRelease are
stored as exact candidate-bound immutable nodes. Operators approve references only; workload evidence has a
separate producer kind and RLS path. Content-addressed documents are opened by digest with no ref-derived path,
no symlink following and bounded stable reads, then revalidated against Root JSON Schemas and canonical SHA-256.

`site_active_release_pointer` is a generation aggregate separate from immutable SiteRelease. Rollback CASes this
pointer to an older immutable release; begin/pre-CAS snapshots freeze certification revocation, producer registry,
trust policy and signing-key heads. A changed head or generation fails closed, while eligibility evidence and the
pointer mutation commit atomically in the lifecycle owner's transaction. The old caller-authored `site_release`
record is not a source or fallback and receives no bridge or dual-write.

The operator and machine Connect adapters are separate: operators cannot author workload evidence and the evidence
workload cannot authorize, certify, publish or activate. Ed25519 DSSE admission verifies provenance and certification
against transaction-local producer/key/trust authority ports before immutable persistence. Production composition
requires concrete EffectiveAccess, issuer, evidence-trust and certification-trust owners; no unavailable default or
self-RPC is accepted. Root `platform-site-publication@v1` still incorrectly asks the caller for the digest of the
Platform-issued WebBuildIntent, so that one RPC remains deliberately fail closed pending the hard-cut contract.
