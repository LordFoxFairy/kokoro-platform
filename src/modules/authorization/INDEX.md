---
architectureIndex: 1
rootId: service.platform.authorization
owners:
  - "@LordFoxFairy"
---

# Platform Authorization

This module owns ProductContext exchange, purpose/resource-bound SessionAccessGrant issuance, the dedicated RS256 key ring, and the signed Platform-to-Session authorization feed. The feed is a ConnectRPC-over-HTTP/2 mTLS pull boundary. It uses rollback-safe transactional global and per-Site counters, an immutable signed event log, bounded frozen snapshot materialization, HMAC-bound page cursors, explicit snapshot-required recovery, and time-based retention. Session owns its cursor and local fail-closed projection; request hot paths never synchronously call Platform.

The v1 Site revocation primitive is intentionally limited to Site-wide security, policy, suspension, and decommissioning changes. It takes the fixed global-stream then Site lock order, bumps Site `revocation_epoch`, and appends the signed event atomically. It must not be wired to identity-session, credential, subject, or membership mutations: using a Site epoch for those scopes would invalidate every user in the tenant.

Current closure is intentionally narrow: the inactive feed provider, grant-delivered event, Site revocation primitive, snapshot, public verification-key delivery, mTLS composition, and retention worker are implemented. No owner mutation surface is wired and `activationAuthorized`/`runtimeTraffic` remain false. A versioned successor must add Subject, IdentitySession, and ProjectMembership current-state events/snapshot facts so Session can compare all nine grant axes without tenant-wide invalidation. Only after that contract, owner wiring, and real compatibility evidence land may this provider be promoted.
