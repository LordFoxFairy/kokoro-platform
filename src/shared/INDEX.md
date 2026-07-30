---
architectureIndex: 1
owners: ["Platform Architecture"]
---

# Shared Platform kernel

`unit-of-work/` owns the opaque transaction capability. Application code may import only its public `index.ts`; the issuing,
resolving, and revocation functions are internal to PostgreSQL/owner adapters. A capability is valid only during one database
callback and is revoked in `finally` after commit or rollback.

`outbox-inbox/` owns command receipts and durable delivery primitives. Business mutation, receipt, and outbox writes share one
`PlatformUnitOfWork`. Workers claim only the owners derived from their registered consumer identity, perform remote effects after commit, then complete, retry,
reconcile `outcome_unknown`, or dead-letter in a later short transaction. Inbox deliveries have bounded leases and crash reclaim.
The typed route catalog is the closed producer-event-type-to-consumer authority: each owner declares an exact event set, consumer,
and active process composition. Claim APIs require that consumer's complete canonical event-type allowlist and derive its owners;
callers cannot invent either axis. Enqueue rejects an unknown owner/event pair, and PostgreSQL repeats the exact route constraint so
direct SQL cannot bypass the TypeScript boundary. Identity's two effect routes are active only through the independent
`platform-identity-worker` entrypoint; local Identity security facts never enter the outbox catalog.
The shared outbox uses FORCE RLS with one exact database-role and fixed-owner predicate per producer/consumer operation. Runtime
startup compares the complete PostgreSQL policy catalog—including PUBLIC roles, commands, role OIDs, `USING`, and `WITH CHECK`—to
the migrator-owned immutable foundation snapshot. The Asset Data Plane receives no generic outbox privilege; its fixed
SECURITY DEFINER completion command runs as the migrator and is admitted only by the dedicated `asset` INSERT policy.
The shared HMAC HTTPS transport provides bounded signed requests, signed acknowledgements and a stable event-id idempotency key;
owner modules wrap it in typed ports and retain ownership of payload validation and durable outcome projection. A successful HTTP
response whose acknowledgement stream resets or times out is an outcome-unknown retry, while a complete invalid acknowledgement
is a permanent protocol failure.

`security-context/` separates structural parsing from trust. An interface/infrastructure verifier validates caller cryptographic
attestation against trusted issuer/key material and issues a runtime-tracked `VerifiedRequestSecurityContext`; application code
can import only that opaque type. UoW checks its live capability and current expiry again before opening a transaction, and the
PostgreSQL host checks it once more before setting local policy fences. Raw headers, issuance primitives, Prisma handles, network
clients, and sibling module repositories are forbidden in application/domain code.
