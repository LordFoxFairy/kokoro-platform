---
architectureIndex: 1
rootId: service.platform.media
owners: ["Platform Media"]
---

# Platform Media module

Media owns immutable Operation Definition revisions and the MediaOperation, MediaStep, and MediaCandidate execution projection.
It does not own Provider attempts, Credit facts, Trust decisions, Artifact bytes, or Session projections; those authorities may be
referenced only through typed receipts and opaque references.

The current implementation is deliberately a pure domain kernel. It preallocates Step and Candidate identities, enforces the
ADR-015 state machines and version fences, keeps cancellation intent distinct from a confirmed canceled outcome, and refuses
completed/partial terminal states while required outputs or reconciliation facts remain open. A ready Candidate requires exact
Artifact finalization, Trust, Usage evidence, and EffectBudgetCommit references.

Caller canonical bytes and fingerprints remain owned by the Root contract. `MediaDefinitionCanonicalizer` is only the typed seam
for a future generated adapter; this module defines no serialization, field ordering, hash algorithm, or golden corpus. Until those
contracts and the owner infrastructure land, this module exposes no database schema, RPC/HTTP handler, Provider adapter, worker,
or runtime capability.
