---
architectureIndex: 1
rootId: service.platform.admission
owners:
  - "@LordFoxFairy"
---

# Platform General Admission

This module owns the Platform-side construction boundary for the sealed General Agent `RunRequest` draft. The application factory accepts only already verified owner facts and an opaque execution-context intent, strict-parses the complete Root-generated contract, canonicalizes and hashes the plaintext itself, and asks a required sealer to encrypt those exact bytes for an injected dispatch audience. It rejects malformed, oversized, expired, excessive-lifetime, wrong-audience, or wrong-digest sealer output. There is no plaintext, development, or missing-sealer fallback.

Platform treats `parent_anchor` and `parent_digest` as opaque values. It validates their contract syntax and binds them into the sealed request, but never resolves Agent checkpoints or chooses continuation lineage. The trusted `AdmissionOwnerAuthority` port is the only source of verified grant, Site release, capability, model, asset, budget/Hold, manifest, binding, and authorization-segment facts; Session wire input cannot assert any of them.

The Connect mapper is the only protobuf-to-domain translation for this intent. Safe admission snapshots, logs, metrics, browser responses, and public receipts must not expose either opaque field.

The application provider implements all four effect commands plus typed receipt recovery. It recomputes the official known-field protobuf digest before durable admission, invokes owner effects with the original command identity, persists the exact typed response, replays duplicates, fences completion with a lease, and returns `outcome_unknown` after ambiguous failures. The PostgreSQL journal is Site/caller RLS-isolated and bounded to 1 MiB responses. The private Connect listener is HTTP/2 + TLS 1.3 only and resolves callers exclusively from an allowlisted mTLS certificate/SPIFFE pair.

Production activation still requires concrete owner-orchestration and run-request sealer adapters in deployment composition. There is deliberately no placeholder owner implementation, plaintext material, browser-header authentication, or legacy dual path.
