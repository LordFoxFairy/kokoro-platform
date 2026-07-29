---
architectureIndex: 1
rootId: service.platform.admission
owners:
  - "@LordFoxFairy"
---

# Platform General Admission

This module owns the Platform-side construction boundary for the sealed General Agent `RunRequest` draft. The application factory accepts only already verified owner facts and an opaque execution-context intent, strict-parses the complete Root-generated contract, canonicalizes and hashes the plaintext itself, and asks a required sealer to encrypt those exact bytes for an injected dispatch audience. It rejects malformed, oversized, expired, excessive-lifetime, wrong-audience, or wrong-digest sealer output. There is no plaintext, development, or missing-sealer fallback.

Platform treats `parent_anchor` and `parent_digest` as opaque values. It validates their contract syntax and binds them into the sealed request, but never resolves Agent checkpoints or chooses continuation lineage. Production constructs `PlatformAdmissionOwnerAuthority` itself from exact Session, Site, Model, Capability, Asset, Budget, lifecycle, dispatch-evidence, and execution-evidence owner ports; deployment cannot inject an alternate authority. Session wire input cannot assert any owner fact.

Prepare resolves Session owner facts over a bounded remote port before opening the Platform transaction, then resolves local owners and reserves the root Hold plus authorization segment atomically. Finalize reads the candidate, verifies Session receipts outside the database transaction, then re-locks and commits the exact segment. Release and reconcile likewise perform remote observations outside local transactions and apply only an exact locked owner transition. Owner adapters must make every mutation idempotent by stable manifest/segment/launch identity because a command lease can be recovered after an ambiguous process failure.

The Connect mapper is the only protobuf-to-domain translation for this intent. Safe admission snapshots, logs, metrics, browser responses, and public receipts must not expose either opaque field.

The application provider implements all four effect commands plus typed receipt recovery. It recomputes the official known-field protobuf digest before durable admission, invokes owner effects with the original command identity, persists the exact typed response, replays duplicates, fences completion with a lease, and returns `outcome_unknown` after ambiguous failures. The PostgreSQL journal is Site/caller RLS-isolated and bounded to 1 MiB responses. The private Connect listener is HTTP/2 + TLS 1.3 only and resolves callers exclusively from an allowlisted mTLS certificate/SPIFFE pair.

Session is the sole owner of immutable dispatch-publication evidence. Platform Admission is its only consumer through the Root-generated `session-dispatch-owner-evidence@v1` Connect contract. The adapter uses HTTP/2 mTLS with TLS 1.3, a five-second maximum deadline, 8 KiB request/response limits, no compression, and typed `found` / `not_found` outcomes. It preserves protobuf `uint64` values as decimal strings and fails closed unless the evidence reference, Site, Session, launch, run, authorization segment, and segment version match Platform-owned facts exactly. No browser, Site BFF, Admin, Agent, shared-secret, or legacy evidence path exists.

RunRequest material uses a concrete RFC 9180 HPKE sealer: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and AES-128-GCM.
Production loads a strict bounded public-key ring, requires one active exact-audience revision, and binds key revision, audience,
Site, Session, run, expiry and plaintext digest into authenticated data. The private key exists only in Session; there is no
plaintext or development fallback.

The PostgreSQL lifecycle owner durably freezes the Session binding and execution manifest, mirrors the Credit-owned segment CAS in the same transaction, and never persists trigger-message content or opaque execution-lineage plaintext. Production constructs this adapter itself; deployment cannot replace it.

Production activation still requires Root-generated Session owner and GA execution-evidence contracts plus concrete Site runtime-policy, Capability, AssetGrant, and Credit budget-policy adapters. Startup must fail closed until those owner facts exist. There is no placeholder owner implementation, browser-header authentication, default Site/runtime policy, or dual path.
