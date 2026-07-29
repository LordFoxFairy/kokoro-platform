---
architectureIndex: 1
owners: ["Platform Model Control"]
---

# ModelControl

Canonical owner for one global multi-modal logical-model catalog, its many provider bindings, Chat/Music/Image/Video default routes,
independently revised Site product policies, availability projections, and immutable selection decisions. A logical model is defined
once; provider account, upstream identifier and gateway alias live only on bindings.

Callers import `ModelControlApplication` from this module's public `index.ts`. Same-process consumers inject the local application
port and an opaque UoW; they never call the legacy `kokoro-model` URL. The PostgreSQL repository is private composition material.
Provider execution and secrets remain behind the remote Model Gateway: selection returns only a safe gateway route. `direct` and
`litellm` describe adapters internal to Model Gateway and never authorize Platform or a product to execute against a provider.

Catalog releases contain only definitions/providers/bindings/default product routes. Materialization is content-addressed and
immutable: importing an already known digest returns the original materialization receipt and never changes runtime traffic.
All external catalog, availability, bundle, Site-policy, catalog-reference and assignment objects use recursively closed schemas;
canonical JSON is rebuilt only from allowed fields in both TypeScript and the SQL import boundary. Unknown fields never enter an
immutable payload or its digest. A product is published by having routes in the catalog. Completeness rules apply only to those
published products; an absent Music/Image/Video route set is legal and restores that Site product as disabled.
Canonical identifiers, bounded control-free text, indirect secret references, integer positions, sorted unique identifier lists,
and provider account uniqueness are enforced by the same PostgreSQL predicates at both the JSON import boundary and snapshot table
constraints. This keeps privileged direct migrator writes from bypassing the materializer's field semantics; TypeScript uses the
same bytewise ASCII ordering rather than a host-locale comparator.
Activation is a separate command with its own immutable receipt and one global active-pointer CAS. A fresh activation ID can
promote or roll back to any materialized digest; compare-and-swap prevents a stale operator from overwriting a newer decision. Site
policies are a different concurrency domain: each `(Site, product)` has its own immutable revisions and pointer CAS. `follow_active`
may inherit defaults; a replacement assignment must pin an exact catalog digest. One Site change never republishes the catalog or
invalidates another Site's expected revision.

Import, activation, and Site-policy services begin a durable command receipt before mutation and commit the stable outcome plus a
`model-control` outbox event in the same caller-owned UoW. The request digest binds deployment/caller epoch, actor identity and
generation, operation effect, and—for imports—the catalog digest, source/fence reference, and complete provider-availability
snapshot. Reusing a command ID with changed facts conflicts before mutation. Replay-only flags are excluded from durable outcomes,
so exact retries reconcile the original receipt. Gateway config/cache/projectors consume `model.inventory.activated.v1`; import and
Site policy expose `model.inventory.materialized.v1` and `model.site-policy.changed.v1`. Dispatch remains a post-commit worker concern,
and the public `ModelControlCommandJournal` port keeps later API/Admin composition independent of PostgreSQL adapters.

Catalog materialization, activation and Site policy changes are narrow `SECURITY DEFINER` control-plane boundaries. Only the dedicated
`PLATFORM_DATABASE_ADMIN_ROLE` can execute them; API and Worker roles have neither raw administration DML nor function execute.
Signed context still requires an admin workload acting as an operator or management workload. Reusing an import/change ID with a
different digest fails closed.

The migrator is the only identity allowed to read raw catalog, policy, receipt, provider account, `secret_ref`, or canonical-payload
tables. API resolves candidates and decision replays through Site-scoped, safe-projection functions only. Admin has exactly the three
catalog/Site management commands. Worker has one separate provider-availability report command: it atomically compare-and-swaps the
provider epoch and writes an immutable idempotency receipt. Provider status/health is therefore a mutable operational fact, never a
catalog-release mutation.

Runtime selection requires an explicit Site policy. `down` providers and disabled providers/models/bindings are rejected;
`unknown` and `degraded` remain eligible cold-start/degraded candidates. Resolution orders product/Site position first, then health,
binding priority, provider priority and binding key. It records the full candidate/rejection effect and selected fallback under a
decision digest. The policy-input digest is recomputed locally from Site/product/role/capabilities, never trusted from a caller, and
no resolution performs remote I/O in the UoW.

Legacy cutover is one deterministic, content-addressed bundle. Export includes the canonical catalog, provider operational
status/health and all non-deleted Sites—including Sites with no legacy model-policy row—and emits four deterministic Site commands
per Site. A product whose hidden routes leave no viable main/generation path is restored disabled instead of producing an invalid
policy. Import verifies the whole bundle digest and a signed migration context, then replays fixed import, activation and Site change
IDs. Re-running the same bundle returns the same receipts and revisions; a changed payload under a reused ID fails closed. Cross-Site
replay is available only to the admin migration purpose carrying `model:site-policy:migrate`; ordinary commands remain exact-Site.
Export requires a short-lived owner-issued quiesce lease supplied as `--fence-attestation` plus its pinned public key. The signed
claims bind issuer/key revision, lease lifetime, purpose, exact database identities, fenced timestamp and full-content write
watermarks; an arbitrary string cannot become a fence. When both sources resolve to one database URL, all Model and Site reads share
one read-only repeatable-read consistent snapshot. With separate databases, each source uses its own consistent snapshot.
Pre-snapshot, in-snapshot and post-commit watermarks must all equal the signed owner watermark and no row may be newer than the
fence. Only a digest of the lease evidence and captured watermarks enters the catalog source reference and bundle digest.
Legacy provider credentials are accepted only when already encoded as a valid `secret://`, `vault://`, or `env://` reference.
Plaintext and bare environment-variable names fail with a non-reflective quarantine error; export never manufactures a reference.

Legacy `ModelLabel` is public product-option metadata, not a logical model definition. Export therefore preserves every label as a
separate, recursively closed and content-addressed `modelOptionMigration` artifact instead of adding `productOptions` to the base
inventory. A valid label records its legacy identity, product, presentation fields, enabled state, ordered candidate logical-model
keys and the default selected through `defaultBindingId -> ModelBinding.id -> modelKey`; invalid, duplicate, unresolved and orphan
facts become non-reflective hashed quarantine entries. The artifact and its quarantine counts are covered by the bundle digest, and
its digest is also bound into the import command identity. Bundle import reports it explicitly as
`pending_site_release_materialization`: the source bundle remains the artifact of record and its digest is conflict-bound to the
import receipt, but the artifact has not been persisted as product configuration or published.
Task 7 owns the immutable `ModelOptionRevision`/`SiteRelease` aggregate, selector defaults and the consumer that materializes this
artifact. Cutover is not complete until that owner consumes or explicitly resolves every option/quarantine fact.

Task 7 adds the authoritative Site foreign key. Task 15 supplies Admin UI/command adapters. The legacy package remains only as a
read-only migration source and rollback artifact until cross-repository consumers complete cutover; no new Platform consumer may
import it or use `KOKORO_MODEL_BASE_URL`.
