---
architectureIndex: 1
owners: ["Platform Architecture"]
---

# Shared Platform kernel

`unit-of-work/` owns the opaque transaction capability. Application code may import only its public `index.ts`; the issuing,
resolving, and revocation functions are internal to PostgreSQL/owner adapters. A capability is valid only during one database
callback and is revoked in `finally` after commit or rollback.

`outbox-inbox/` owns command receipts and durable delivery primitives. Business mutation, receipt, and outbox writes share one
`PlatformUnitOfWork`. Workers claim only an explicit owner allowlist, perform remote effects after commit, then complete, retry,
reconcile `outcome_unknown`, or dead-letter in a later short transaction. Inbox deliveries have bounded leases and crash reclaim.

`security-context/` separates structural parsing from trust. An interface/infrastructure verifier validates caller cryptographic
attestation against trusted issuer/key material and issues a runtime-tracked `VerifiedRequestSecurityContext`; application code
can import only that opaque type. UoW checks its live capability and current expiry again before opening a transaction, and the
PostgreSQL host checks it once more before setting local policy fences. Raw headers, issuance primitives, Prisma handles, network
clients, and sibling module repositories are forbidden in application/domain code.
