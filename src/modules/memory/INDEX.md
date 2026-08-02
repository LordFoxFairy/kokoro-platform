---
architectureIndex: 1
rootId: service.platform.memory
owners: ["Platform Memory"]
---

# Platform Memory module

Memory owns Site-local MemorySpace, stable MemoryEntry identity, append-only MemoryRevision and MemoryProvenance facts, and
owner-scoped command receipts. M0 accepts only explicit remember, correct, restore-as-a-new-revision, priority, forget,
learning/use pause and resume, and reset commands. It does not infer saved memories from conversation history, promote
instructions into Memory, or provide search, ranking, suggestion, proactive capture, physical purge, or background processing.

Every command executes inside a caller-supplied Platform transaction. The service revalidates exact current Site, Subject,
Project membership, membership epoch, authorization epoch, Subject generation, and feature-policy revision facts before reading or
mutating authority. User-owned and Project-owned spaces are distinct; a Project bucket is identified only by Site and Project, so
it remains shared across current members rather than becoming creator-owned. The current member's Subject generation, membership
epoch, and authorization epoch are command evidence recorded in provenance and receipts, never bucket identity. Agent-product
spaces carry an immutable copy of their parent User or Project binding and cannot become a Workspace authority surface. Completed
command recovery runs before mutable admission, key access, owner reads, or current-release checks so a retry remains deterministic
after dependency or release drift. Recovery is still bound to the exact Site, Subject, Subject generation, operation and original
fingerprint-key revision, and returns only a closed, content-free result. Command-reference reuse with another canonical payload
fails closed.
The authority service never accepts a caller-supplied request digest. It computes a versioned, operation-separated SHA-256
digest over each command's fixed canonical fields; protected bytes contribute only key/envelope metadata, length, and a
ciphertext digest.

MemoryEntry identity is stable across corrections. Revisions and provenance are append-only, while forget advances both entry and
space revocation fences and leaves a tombstone. Space reset advances generation, learning generation, and revocation epoch.
Protected content enters the authority service only through the type-only `ProtectedMemoryContent` capability returned by its
factory. Its hidden, token-gated implementation owns separate nonce, ciphertext and authentication-tag copies in module-private
storage. The single protector adapter uses AES-256-GCM with a 12-byte nonce and 16-byte tag. Canonical AAD is the
`kokoro.memory.payload.v1\0` domain separator plus length-framed Site, Space, Entry and Revision references; its digest is checked
before decryption. A bounded owner-private key-ring provides exactly one active key, decrypt-only rotation keys and material-free
retired revisions. Production has no default or development key. Immutable revision headers and erasable envelope payloads are
persisted separately.

PostgreSQL tables are Site-composite and force RLS. M0.1 provisions the exact LOGIN/NOINHERIT/NOBYPASSRLS
`platform_memory_public`, `platform_memory_runtime`, and `platform_memory_worker` identities and pins their OIDs. The central
Platform migrator qualifies all three identities, ownership and membership inventory before migration, closes their default
privileges, and verifies the exact OID/ACL authority afterward. A missing OID identity table is accepted only while the public
authority migration is genuinely pending and none of that migration's baseline objects exist; applied, failed, partial, or
corrupted states stop before migration execution or ACL mutation. Direct defaults and reachable `PUBLIC` defaults are audited
without rewriting unexpected owners' authority. PostgreSQL has no schema-local deny that can override its implicit global
`PUBLIC EXECUTE` default for routines, so the migrator records the minimum effective default ACL: in the current Platform
database, only future functions owned by `platform_migrator` lose `PUBLIC EXECUTE`. Existing routines are closed separately and
only inside the `platform` schema; table and sequence defaults and every other owner's defaults remain unchanged. While the
postflight never rewrites another owner: it fails closed when an activatable, non-superuser owner with no explicit global
function-default row can create in a non-system schema visible to a Memory role, because PostgreSQL would otherwise supply that
owner's implicit `PUBLIC EXECUTE`. Superusers already bypass the runtime authority model, while PostgreSQL's NOLOGIN
`pg_database_owner` pseudo-role is not an independently activatable object creator. The Task 5 personal owner data plane grants
`platform_memory_public` Platform schema usage and only 22 operation-specific, fixed-search-path routines. It receives no direct
table or sequence authority. Its forced-RLS policies are restricted to that exact login, while every routine revalidates the
current Site, Subject generation, active release and exact feature-policy revision before returning or committing owner data.
Prepare records bind a keyed, revisioned command fingerprint, a random prepare reference and the exact locked-state digest.
Remember, correct, restore, priority, forget and reset transitions are produced only by `MemoryAuthorityService`; every commit is
bound to the full
canonical command/transition proposal by a domain-separated HMAC authority receipt, then independently checked against the live
state digest inside PostgreSQL before persistence. The verifier key-ring is private to the owner functions, and `pgcrypto` lives
in a dedicated schema with no runtime-role or `PUBLIC` authority. JSON results use closed decoders and canonical UTC instants.
Owner reads carry
monotonic space versions and sealed snapshots; database read routines independently enforce current generation and revocation
fences. Public list state is the implicit constant `active`; callers may narrow only by category and the exact source derived from
the current revision/provenance (`explicit` or `import`), while absent category/source values are canonically bound as all-values in the sealed
cursor. Complete list/history envelopes, including snapshot and continuation metadata, stay within the 262144-byte UTF-8 cap.
Forget/reset synchronously create a deterministic purge manifest and expose only a content-free
`revoked_purge_pending`/`purged` tombstone, so revoked plaintext cannot be returned through detail, history, or restore while the
physical deletion worker remains feature-off. History keeps immutable revision identity/reason/time headers after logical
revocation, but projects every retained payload as content-free `purged` and non-restorable before physical deletion.
For an active entry, the available current head is also non-restorable; only an available revision strictly older than that
head can be restored as a new successor revision.
`platform_memory_runtime` still receives zero Platform schema, table, sequence, or
routine grants. `platform_memory_worker` receives only
Platform schema usage and the four fixed-search-path purge routines. Purge claims first terminalize at most 100 exhausted queued
or expired leased/running jobs, clear their lease material, and then select only a sub-limit candidate so one exhausted job cannot
starve the queue. All three retain PostgreSQL's shared ambient `public`
schema `USAGE` only; they receive no `public` schema `CREATE`, object, sequence, or routine authority.

This Task 5 data plane is deliberately dormant. Platform does not yet own an authoritative per-Site Memory activation projection
or application port, and the deterministic syntax/common-secret admission baseline is not a production content-classification
authority. Production composition must inject an authoritative content classifier, a server-keyed fingerprint provider, and the
transition-authority key revision shared with the database verifier; absence fails closed. Until the activation projection is part
of the owner routines, Task 7 must not mount an HTTP route, issue a
Memory process credential, advertise readiness, or expose this surface. Project Memory, runtime retrieval, physical purge worker,
import/export execution, and RPC remain feature-off.

Consumers use only `src/modules/memory/index.ts`. Persistence and application ports are public solely to allow a later owner
composition root to supply the Platform transaction, authorization-facts, and content-protection adapters without moving authority
out of this module.
