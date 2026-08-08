---
architectureIndex: 1
rootId: service.platform.product-catalog
owners:
  - "@LordFoxFairy"
---

# Product Catalog publication

Global authority for immutable Product/Surface catalog revisions and product-level
`LaunchProductProfile` revisions. This bounded context is not Site-scoped: SiteRelease admission
binds an exact published profile later and remains owned by the Site/Admission contexts.

The Connect provider is mounted on the existing Admin mTLS process and requires a Global operator
grant, exact operation permission, phishing-resistant step-up, canonical command-envelope digest,
and durable command receipt. Same-process Admin composition calls the application port inside a
Platform UoW; it never self-RPCs and never leaks Site lifecycle commands into this owner.

Exact Root-commit source blobs for both JSON Schemas and all five dependent publication Protos are
vendored with one executable provenance manifest. Standalone generation reads only the vendor,
always verifies every source SHA-256, regenerates the JSON targets, and binds the Proto source
aggregate to the generated artifact digest. Explicit Root verification uses only `git show` and
requires every committed blob to equal the vendor. Generated targets never act as their own source.
Ajv owns shape validation; hand-written domain code owns graph, ownership, product, surface and
journey closure. Canonical I-JSON admission is byte-for-byte, NFC, safe-integer, bounded by
bytes/depth/node count, and digest-bound.

All wire `uint64` publication/head fields persist as PostgreSQL `NUMERIC(20,0)` and Prisma
`Decimal(20,0)`, with text-to-`bigint` conversion at the repository boundary. Values through
`2^64-1` remain exact; PostgreSQL signed `BIGINT` is forbidden for this bounded context.
Published revisions, owner receipts and audits are append-only; only the two global CAS heads are
mutable. A Product-owned durable receipt cross-checks the immutable revision and audit before replay.
The generic mutable command receipt coordinates begin/outcome only and is never sufficient proof of
successful publication.

The Root wire contract currently carries only an immutable binding, not its canonical bytes.
Production requires `PLATFORM_PUBLICATION_DOCUMENT_ROOT`, a read-only content-addressed mount whose
objects live at `sha256/<digest>.json`. The resolver never derives a path from caller refs, opens with
`O_NOFOLLOW`, bounds bytes, verifies a stable file descriptor read, and the owner still revalidates
canonical I-JSON, Root schema, exact binding and SHA-256 before publication. Tests may inject the same
narrow resolver port; production no longer boots with a permanently unavailable publication source.
Activation and runtime traffic remain false until Root supplies an authenticated, signed immutable
bundle resolver and compatibility evidence covers both publication operations.

P0 contract follow-up: add a Root-owned typed/signed artifact admission or staging RPC that binds
producer identity, schema ID, canonical bytes and digest. Do not replace it with an Admin payload,
filesystem convention, inferred ref, or in-memory production adapter.

Durable replay reads a completed owner attestation before touching the external document source,
then repeats the identity/digest fence in the mutation transaction. This preserves successful retry
recovery during source outages without holding database locks across remote resolution. The shared
Admin Connect error policy publishes stable authentication, permission and step-up statuses; all
unclassified internal failures are returned as a masked Internal response.
