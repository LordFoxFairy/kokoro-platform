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
Activation is a separate command with its own immutable receipt and one global active-pointer CAS. A fresh activation ID can
promote or roll back to any materialized digest; compare-and-swap prevents a stale operator from overwriting a newer decision. Site
policies are a different concurrency domain: each `(Site, product)` has its own immutable revisions and pointer CAS. `follow_active`
may inherit defaults; a replacement assignment must pin an exact catalog digest. One Site change never republishes the catalog or
invalidates another Site's expected revision.

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

Task 7 adds the authoritative Site foreign key. Task 15 supplies Admin UI/command adapters. The legacy package remains only as a
read-only migration source and rollback artifact until cross-repository consumers complete cutover; no new Platform consumer may
import it or use `KOKORO_MODEL_BASE_URL`.
