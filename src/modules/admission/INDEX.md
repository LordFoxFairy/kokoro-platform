---
architectureIndex: 1
rootId: service.platform.admission
owners:
  - "@LordFoxFairy"
---

# Platform General Admission

This module owns the Platform-side construction boundary for the sealed General Agent `RunRequest` draft. The application factory accepts only already verified owner facts and an opaque execution-context intent, strict-parses the complete Root-generated contract, canonicalizes and hashes the plaintext itself, and asks a required sealer to encrypt those exact bytes for an injected dispatch audience. It rejects malformed, oversized, expired, excessive-lifetime, wrong-audience, or wrong-digest sealer output. There is no plaintext, development, or missing-sealer fallback.

Platform treats `parent_anchor` and `parent_digest` as opaque values. It validates their contract syntax and binds them into the sealed request, but never resolves Agent checkpoints, chooses continuation lineage, or derives identity, Site, capability, model, budget, hold, or manifest facts. Those facts remain the responsibility of their existing owners and the future Admission orchestration.

The Connect mapper is the only protobuf-to-domain translation for this intent. Safe admission snapshots, logs, metrics, browser responses, and public receipts must not expose either opaque field.

Current activation is intentionally narrow: the strict mapper, draft factory, and fail-closed application composition point are implemented. The full Prepare/Finalize/Release/Reconcile provider, production sealer adapter, command-digest/receipt journal, and runtime traffic remain inactive follow-up work.
