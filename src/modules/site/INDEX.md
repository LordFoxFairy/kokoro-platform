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
`site.activation.begin.v1` and `site.traffic-stop.request.v1` cross that transaction through
`SiteEffectQueuePort`, because they trigger real provider effects. Registration, release publication,
observations, commits, drain completion and resume are already authoritative local facts and never become
generic outbox events. The Site worker claims the exact two-type allowlist and dead-letters any unknown type.

Fresh Site creation and immutable SiteRelease publication are exposed only by the typed
`SiteProvisioningService` on the Admin mTLS listener. Registration requires a Platform-global grant because
the Site scope does not exist yet; every later release command requires the exact Site scope. Both are
phishing-resistant step-up mutations. Release certification is a detached Ed25519 attestation from the
configured `PLATFORM_SITE_RELEASE_CERTIFICATION_KEYS_FILE`; Platform persists only the bound digest and never
accepts an operator assertion as certification.
