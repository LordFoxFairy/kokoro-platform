---
architectureIndex: 1
rootId: service.platform.admission
owners:
  - "@LordFoxFairy"
---

# Platform General Admission

This module owns the Platform-side construction boundary for the sealed General Agent `RunRequest` draft. The application factory accepts only already verified owner facts, the prepared authorization's exact expiry ceiling and an opaque execution-context intent, strict-parses the complete Root-generated contract, canonicalizes and hashes the plaintext itself, and asks a required sealer to encrypt those exact bytes for an injected dispatch audience. It can only tighten that owner expiry to its five-minute draft lifetime and rejects malformed, oversized, expired, excessive-lifetime, wrong-audience, or wrong-digest sealer output. There is no plaintext, development, or missing-sealer fallback.

Platform treats `parent_anchor` and `parent_digest` as opaque values. It validates their contract syntax and binds them into the sealed request, but never resolves Agent checkpoints or chooses continuation lineage. Production constructs `PlatformAdmissionOwnerAuthority` itself, including native Site, Model, and lifecycle adapters; deployment can supply only the remaining exact owner ports and cannot inject an alternate authority. Session wire input cannot assert any owner fact.

Prepare resolves Session owner facts over a bounded remote port before opening the Platform transaction, then resolves local owners and reserves the root Hold plus authorization segment atomically. Finalize reads the candidate, verifies Session receipts outside the database transaction, then re-locks and commits the exact segment. Release and reconcile likewise perform remote observations outside local transactions and apply only an exact locked owner transition. Owner adapters must make every mutation idempotent by stable manifest/segment/launch identity because a command lease can be recovered after an ambiguous process failure.

The Connect mapper is the only protobuf-to-domain translation for this intent. Safe admission snapshots, logs, metrics, browser responses, and public receipts must not expose either opaque field.

The application provider implements all four effect commands plus typed receipt recovery. It recomputes the official known-field protobuf digest before durable admission, invokes owner effects with the original command identity, persists the exact typed response, replays duplicates, fences completion with a lease, and returns `outcome_unknown` after ambiguous failures. The authority may raise `AdmissionOwnerNoEffectError` only before any external or persistent owner effect starts; the application maps only that signal to `pending` plus journal deferral so the exact command identity can re-enter the authority. Once an external reservation or Credit/lifecycle mutation starts, every thrown or commit-ambiguous result remains an immutable `outcome_unknown` receipt, and exact retries replay it rather than invoking the effect again. The PostgreSQL journal is Site/caller RLS-isolated and bounded to 1 MiB responses. The private Connect listener is HTTP/2 + TLS 1.3 only and resolves callers exclusively from an allowlisted mTLS certificate/SPIFFE pair.

Session is the sole owner of immutable dispatch-publication evidence. Platform Admission is its only consumer through the Root-generated `session-dispatch-owner-evidence@v1` Connect contract. The adapter uses HTTP/2 mTLS with TLS 1.3, a five-second maximum deadline, 8 KiB request/response limits, no compression, and typed `found` / `not_found` outcomes. It preserves protobuf `uint64` values as decimal strings and fails closed unless the evidence reference, Site, Session, launch, run, authorization segment, and segment version match Platform-owned facts exactly. No browser, Site BFF, Admin, Agent, shared-secret, or legacy evidence path exists.

The same private HTTP/2+mTLS process also hosts the Root-generated
`platform-asset-eligibility@v1` read boundary for Session. Only the configured
Session SAN may call it. Platform verifies the opaque delivered
SessionAccessGrant, derives current Site/project/subject/generation facts,
applies those facts to Asset forced-RLS, and resolves the exact immutable
asset/version/grant tuple set in caller order. `chat.attachment` is the only
accepted purpose; any stale, revoked, or cross-scope member rejects the whole
set without revealing which owner check failed.

RunRequest material uses a concrete RFC 9180 HPKE sealer: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and AES-128-GCM.
Production loads a strict bounded public-key ring, requires one active exact-audience revision, and binds key revision, audience,
Site, Session, run, expiry and plaintext digest into authenticated data. The private key exists only in Session; there is no
plaintext or development fallback.

The PostgreSQL lifecycle owner durably freezes the Session binding and execution manifest, mirrors the Credit-owned segment CAS in the same transaction, and never persists trigger-message content or opaque execution-lineage plaintext. Production constructs this adapter itself; deployment cannot replace it.

Admission database identities are run-scoped `kt_pg_*` leased login roles with `NOINHERIT`; a fixed
`platform_admission` database role is not provisioned. The bootstrap administrator creates only the
login. `src/infrastructure/postgres/admission-role-lease.ts` owns the bounded transition:
`active(current, epoch)` → `draining(current, pending, retiring name/OID pairs)` →
`active(pending, epoch + 1)`. Prepare durably records the exact pending and retiring OIDs and revokes
their database `CONNECT` in the same commit; existing old
backends and either direction of role membership stop the transition. Final revoke, global/schema
default-ACL closure, exact grants, post-check, identity switch and tombstone clearing are one transaction,
so a failure remains draining and can be retried without losing the old principal. Every Admission UoW
starts with `begin_admission_transaction`, which binds the active role, operation, workload and lease
epoch before owner SQL. `platform_admission` remains only the trusted transaction
`app.workload_kind`, not a PostgreSQL principal. Media-access reservations therefore bind the recorded
role name/OID together with the exact `admission.command`, workload kind, and Site transaction context
in both RLS `USING` and `WITH CHECK`.

The native Site owner resolves only an active exact Site, active release, active project, and allowlisted locale; it has no default-Site fallback and does not own GA runtime policy. The native Model owner resolves only an option published by that immutable release. Its admission-only security-definer projection excludes provider account and secret references, preserves the option's declared orchestration primary/fallback order, and chooses a healthy binding deterministically before any effect. Production constructs both adapters itself.

`src/process/admission.ts` is the dedicated secure-listener lifecycle host: database connect/readiness precedes listen, health is no-store, new requests are rejected during drain, active HTTP/2 sessions receive GOAWAY, and server/database shutdown is deadline bounded. Production composition wires the Root-generated Session dispatch-evidence client, native Site/runtime-policy/Model/Capability/Asset/Credit owners, capability publication provider and Asset Eligibility provider. Startup fails closed when any required owner contract, key ring, peer identity or database authority is absent. There is no placeholder owner implementation, browser-header authentication, default Site/runtime policy or dual path.
