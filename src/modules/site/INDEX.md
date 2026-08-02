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

Fresh Site creation is exposed by the typed `SiteProvisioningService` on the Admin mTLS listener and requires
a Platform-global grant because the Site scope does not exist yet. The release command accepts only the Root-owned
candidate reference, expected candidate version and operator reason. Until the Platform Candidate Authority can
lock and revalidate the complete candidate/certification chain, `PublishSiteRelease` returns a stable typed
`Unimplemented` result before authorization resolution, receipt lookup or any owner/repository call. Never restore
caller-supplied artifact, manifest, profile, catalog, surface or certification facts, and never remount the legacy
`SitePublicationService.publishRelease` path. The eventual candidate-backed mutation requires the exact Site scope
and phishing-resistant step-up authorization.
