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

`FixedSiteHttpDeploymentProvider` is the bounded core single-Site adapter. It reads one configured metadata/readiness
URL and maps the exact Site/Release/artifact binding into the existing provider observation; it has no create, delete
or list operation. Registry entries tagged `kind: "fixed_http"` select it, while untagged entries retain the existing
RPC provider shape.

Fresh Site creation remains on the typed `SiteProvisioningService`; publication is a separate owner boundary.
The operator publication owner is mounted on Admin and implements the one-way Root chain through immutable Candidate
and publication revisions. Product Catalog/Profile are locked from their owner tables,
`SiteEffectiveAccessSnapshotPort` composes Commerce, Model, Hub, Auth and Memory owner revisions in the same Platform
transaction, and Platform, not the operator, builds the canonical Candidate and signed WebBuildIntent. Operators
approve references only. Content-addressed documents are opened by digest with no ref-derived path, no symlink
following and bounded stable reads, then revalidated against Root JSON Schemas and canonical SHA-256.
The Commerce closure contains only offer, entitlement-template and credit-program revision sets plus its closure
digest; Site publication does not maintain a separate price-revision binding.

Machine Evidence admission is a separate trust boundary. Its mTLS peer registry binds the certificate fingerprint and
SPIFFE URI to one Site/project binding, environment, region, producer registration and workload attestation. Admission
then rereads the exact `site_project_binding` under PostgreSQL RLS and accepts only the matching active workload,
binding epoch and bounded freshness window. Admission has only the relation and column privileges required for this
live read, command receipt and immutable evidence publication path. Candidate, trust, attestation and decision reads,
and the release-evidence publication write, remain fenced by the live Site/environment/region/workload/epoch tuple.
The private listener mount, secret declaration and generated provenance move together in the subsequent deployment
composition commit; the ports in this module do not make that runtime active by themselves.

`site_active_release_pointer`, begin/pre-CAS snapshots and eligibility evidence define the target generation/CAS
authority, but production Activation is dormant. There is no production `SiteActivationAuthorityReaderPort`, no
runtime grants for those three relations, no typed lifecycle adapter wiring and no Site-worker
`site.activation.commit` transaction. The legacy lifecycle path is not an implementation of this authority and must
be hard-cut after the Root lifecycle generated contract lands. The old caller-authored `site_release` record is not a
source or fallback for immutable SiteRelease and must not receive a bridge, compatibility adapter or dual-write.

The operator and machine Connect adapters remain separate: operators cannot author workload evidence and the evidence
workload cannot authorize, certify, publish or activate. Ed25519 DSSE admission verifies provenance and certification
against transaction-local producer/key/trust authority ports before immutable persistence. Production composition
requires concrete EffectiveAccess, issuer, evidence-trust and certification-trust owners; no unavailable default or
self-RPC is accepted.
