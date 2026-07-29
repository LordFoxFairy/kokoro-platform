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
adapters must preserve these transitions in one owner transaction with receipt, audit and outbox.
