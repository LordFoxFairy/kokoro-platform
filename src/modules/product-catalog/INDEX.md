---
architectureIndex: 1
owners: ["Platform Product Catalog"]
---

# Product Catalog publication

Global authority for immutable Product/Surface catalog revisions and product-level
`LaunchProductProfile` revisions. This bounded context is not Site-scoped: SiteRelease admission
binds an exact published profile later and remains owned by the Site/Admission contexts.

The Connect provider is mounted on the existing Admin mTLS process and requires a Global operator
grant, exact operation permission, phishing-resistant step-up, canonical command-envelope digest,
and durable command receipt. Same-process Admin composition calls the application port inside a
Platform UoW; it never self-RPCs and never leaks Site lifecycle commands into this owner.

Root JSON Schemas are checked in as generated mirrors with frozen schema IDs, source SHA-256 and
artifact SHA-256. Ajv owns shape validation; hand-written domain code owns graph, ownership, product,
surface and journey closure. Canonical I-JSON admission is byte-for-byte, NFC, safe-integer, bounded
by bytes/depth/node count, and digest-bound. Published revisions and audits are immutable; only the
two global CAS heads are mutable.

The Root wire contract currently carries only an immutable binding, not its canonical bytes.
Production therefore defaults to `UnavailableProductPublicationDocumentResolver` and fails closed.
Activation and runtime traffic remain false until Root supplies an authenticated, signed immutable
bundle resolver and compatibility evidence covers both publication operations.

P0 contract follow-up: add a Root-owned typed/signed artifact admission or staging RPC that binds
producer identity, schema ID, canonical bytes and digest. Do not replace it with an Admin payload,
filesystem convention, inferred ref, or in-memory production adapter.

Durable replay reads a completed receipt before touching the external document source, then repeats
the identity/digest fence in the mutation transaction. This preserves successful retry recovery
during source outages without holding database locks across remote resolution.
