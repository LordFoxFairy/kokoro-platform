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
factory. Its hidden, token-gated implementation validates and copies twice, keeps bytes in module-private storage, freezes its
runtime surface, and binds them to an explicit key revision and envelope digest. The module defines a protection port but deliberately ships no protector adapter,
key handling, plaintext persistence path, or decryption capability.

PostgreSQL tables are Site-composite and force RLS. M0.1 provisions the exact LOGIN/NOINHERIT/NOBYPASSRLS
`platform_memory_public`, `platform_memory_runtime`, and `platform_memory_worker` identities and pins their OIDs. Public and worker
authority is exposed only through operation-specific, fixed-search-path SECURITY DEFINER routines whose RLS policies revalidate
the exact session role and current owner facts. `platform_memory_runtime` deliberately receives zero table and routine grants.
No Memory process credential, listener, readiness check, public route, worker composition, or RPC surface is activated yet.

Consumers use only `src/modules/memory/index.ts`. Persistence and application ports are public solely to allow a later owner
composition root to supply the Platform transaction, authorization-facts, and content-protection adapters without moving authority
out of this module.
