---
architectureIndex: 1
owners: ["Platform Model Control"]
---

# ModelControl

Canonical owner for one global multi-modal logical-model catalog, its many provider bindings, Chat/Music/Image/Video default routes,
independently revised Site product policies, availability projections, and immutable selection decisions. A logical model is defined
once; provider account, upstream identifier and gateway alias live only on bindings.

Callers import `ModelControlApplication` from this module's public `index.ts`. Same-process consumers inject the local application
port and an opaque UoW; no separate per-domain Model service participates. The PostgreSQL repository is private composition material.
Provider execution and secrets remain behind the remote Model Gateway: selection returns only a safe gateway route. `direct` and
`litellm` describe adapters internal to Model Gateway and never authorize Platform or a product to execute against a provider.

The global inventory contains definitions, provider bindings and the structurally allowed route pool. Product-facing choices are
native `ModelOptionDraft` records layered above that inventory: Chat selects one ordered assistant route, while Music/Image/Video
select an ordered chat-orchestration route and an independent ordered generation route. A SiteRelease publishes only the allowed
immutable option revisions and default for each enabled surface; no product duplicates provider or model definitions.
Materialization is content-addressed and
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
tables. API resolves candidates, decision replays, and exact SiteRelease ModelOption projections through scoped owner functions
only. Admin can execute the inventory/Site-policy commands plus narrow ModelOption inventory-read, revision-read, and publication
functions; it still has no raw ModelOption table access. Worker has one separate
provider-availability report command: it atomically compare-and-swaps the provider epoch and writes an immutable idempotency receipt.
Provider status/health is therefore a mutable operational fact, never a catalog-release mutation.

Runtime selection requires an explicit Site policy. `down` providers and disabled providers/models/bindings are rejected;
`unknown` and `degraded` remain eligible cold-start/degraded candidates. Resolution orders product/Site position first, then health,
binding priority, provider priority and binding key. It records the full candidate/rejection effect and selected fallback under a
decision digest. The policy-input digest is recomputed locally from Site/product/role/capabilities, never trusted from a caller, and
no resolution performs remote I/O in the UoW.

Fresh deployments author canonical Platform-native inventories and materialize native option drafts into immutable revisions. There is no
legacy database exporter, rollback authority, or migration CLI in the production path. Publication remains relational
(`publication -> surface -> allowed/default revision`) and cannot cross Site, release, catalog, or inventory boundaries.
ProductContext reads that publication inside the authorization transaction; missing operational model/provider/binding facts make
the default unavailable and fail the request closed. Upstream SiteRelease authority provisioning remains a separate owner:
ModelControl may publish only when its requested catalog reference already matches the locked `authorization_site_release` row.
