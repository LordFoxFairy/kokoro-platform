# Artifact owner module

Platform owns Artifact identity, immutable versions, staged/finalized receipts and delivery authorization. Provider and
object-store locations are private infrastructure facts. Public callers receive only Artifact references and short-lived,
audience-bound delivery capabilities; redeem streams bytes through the Platform data plane with a single bounded Range.

Metadata/list/get, delivery issuance and revocation form a generated JSON control-plane owner. Binary redemption is excluded
from that registry and uses `createArtifactDataPlaneHttpHandler`, which matches the generated GET route but never invokes its
string/JSON response schema. Authorization is bound to the exact Site, Site release, workload identity, binding epoch and Site
security epoch. Every accepted replay creates a distinct durable redemption audit lifecycle; capability material is never
stored in audit records. The public contract currently has no HEAD or ETag field, so only GET 200/206/416 is emitted; the S3
adapter still uses private HEAD + `If-Match` and content-digest checks as its integrity fence.

`infrastructure/dev` contains deterministic in-memory adapters for tests and explicit local development only. Production
composition must use durable PostgreSQL authorization state and a private object-store adapter and must reject these fakes.

The S3-compatible adapter promotes to an immutable ready key with conditional writes, then opens that exact version through
an ETag-fenced GET. Response ETag, content type, size and owner metadata must match the preceding HEAD; full-object streams also
verify the content SHA-256 before successful completion. Staged-object deletion is best effort after ready is proven: an
ambiguous delete never rolls back ready state and is returned as durable `stagedCleanup: pending` evidence. The Artifact metadata
owner must persist that evidence and a future reconciliation worker must retry it; this slice defines the schema/state contract
but does not introduce that worker.

The object adapter splits oversized provider chunks before exposure and the HTTP boundary rejects any chunk over 8 MiB,
overrun, short read or invalid response metadata. Deadline, caller disconnect and response backpressure remain live for the
whole stream. Production pins `postgres-s3-v1`: security-definer PostgreSQL authorization/audit routines, private S3 reads,
trusted secret files and ProductWorkload mTLS must all load before readiness; development fakes are never selected by main.
