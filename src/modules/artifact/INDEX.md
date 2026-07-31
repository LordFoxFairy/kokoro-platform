# Artifact owner module

Platform owns Artifact identity, immutable versions, staged/finalized receipts and delivery authorization. Provider and
object-store locations are private infrastructure facts. Public callers receive only Artifact references and short-lived,
audience-bound delivery capabilities; redeem streams bytes through the Platform data plane with a single bounded Range.

`infrastructure/dev` contains deterministic in-memory adapters for tests and explicit local development only. Production
composition must use durable PostgreSQL authorization state and a private object-store adapter and must reject these fakes.

The S3-compatible adapter promotes to an immutable ready key with conditional writes, then opens that exact version through
an ETag-fenced GET. Response ETag, content type, size and owner metadata must match the preceding HEAD; full-object streams also
verify the content SHA-256 before successful completion. Staged-object deletion is best effort after ready is proven: an
ambiguous delete never rolls back ready state and is returned as durable `stagedCleanup: pending` evidence. The Artifact metadata
owner must persist that evidence and a future reconciliation worker must retry it; this slice defines the schema/state contract
but does not introduce that worker.
