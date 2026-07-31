---
architectureIndex: 1
rootId: service.platform.memory
owners: ["Platform Memory"]
---

# Platform Memory module

Memory owns Site-local MemorySpace, stable MemoryEntry identity, append-only MemoryRevision and MemoryProvenance facts, and
owner-scoped command receipts. M0 accepts only explicit remember, correct, forget, learning/use pause and resume, and reset
commands. It does not infer saved memories from conversation history, promote instructions into Memory, or provide search,
ranking, suggestion, proactive capture, restoration, purge, or background processing.

Every command executes inside a caller-supplied Platform transaction. The service revalidates exact current Site, Subject,
Project membership, membership epoch, authorization epoch, Subject generation, and feature-policy revision facts before reading or
mutating authority. User-owned and Project-owned spaces are distinct; a Project bucket is identified only by Site and Project, so
it remains shared across current members rather than becoming creator-owned. The current member's Subject generation, membership
epoch, and authorization epoch are command evidence recorded in provenance and receipts, never bucket identity. Agent-product
spaces carry an immutable copy of their parent User or Project binding and cannot become a Workspace authority surface. Replay is
owner-scoped and returns only a closed,
non-secret result after current authorization succeeds; command-reference reuse with another canonical payload fails closed.
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
`pg_database_owner` pseudo-role is not an independently activatable object creator. While the feature is off,
`platform_memory_public` and
`platform_memory_runtime` receive zero Platform schema, table, sequence, or routine grants. `platform_memory_worker` receives only
Platform schema usage and the three fixed-search-path purge routines. Purge claims first terminalize at most 100 exhausted queued
or expired leased/running jobs, clear their lease material, and then select only a sub-limit candidate so one exhausted job cannot
starve the queue. All three retain PostgreSQL's shared ambient `public`
schema `USAGE` only; they receive no `public` schema `CREATE`, object, sequence, or routine authority. Task 5 must introduce the
real operation-specific public read/write routines, grants, RLS policies, and live owner-fact revalidation in a forward migration;
the M0.1 owner helper remains migrator-internal and is not a callable product surface.
No Memory process credential, listener, readiness check, public route, worker composition, or RPC surface is activated yet.

Consumers use only `src/modules/memory/index.ts`. Persistence and application ports are public solely to allow a later owner
composition root to supply the Platform transaction, authorization-facts, and content-protection adapters without moving authority
out of this module.
